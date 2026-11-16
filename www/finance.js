(function () {
    'use strict';

    const STORAGE_KEY = 'goalTracker_finance';
    const CATEGORY_NAMES = {
        salary: 'Зарплата',
        freelance: 'Подработка',
        food: 'Еда',
        transport: 'Транспорт',
        housing: 'Жильё',
        health: 'Здоровье',
        entertainment: 'Развлечения',
        other: 'Другое'
    };

    const CUSTODIAN_COIN = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <circle cx="32" cy="32" r="27" fill="#07181e" stroke="#22d3ee" stroke-width="2"/>
        <circle cx="32" cy="32" r="22" fill="none" stroke="#ecfeff" stroke-width="1" opacity=".7"/>
        <path d="M27 45V19h9c11 0 11 16 0 16H23m0 5h15" fill="none" stroke="#ecfeff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let celebrationTimers = [];
    let custodianObserver = null;

    let activeStep = 'accounting';
    let renderedStep = null;
    let eventsBound = false;
    let depositFormOpen = false;
    let fundActionPending = false;
    let data = loadData();

    function defaults() {
        return {
            transactions: [],
            budget: {
                categories: {
                    food: { name: 'Еда', limit: 0 },
                    transport: { name: 'Транспорт', limit: 0 },
                    housing: { name: 'Жильё', limit: 0 },
                    health: { name: 'Здоровье', limit: 0 },
                    entertainment: { name: 'Развлечения', limit: 0 },
                    other: { name: 'Другое', limit: 0 }
                }
            },
            safetyFund: { balance: 0, targetMonths: 6, confirmationVersion: 1, history: [], newDepositMade: false, lastSeenBalance: 0 },
            investments: { assets: [] },
            growth: { baseIncome: 0, currentIncome: 0, history: [], ideas: [] }
        };
    }

    function number(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function array(value) {
        return Array.isArray(value) ? value : [];
    }

    function normalize(raw) {
        const base = defaults();
        const source = raw && typeof raw === 'object' ? raw : {};
        const oldSalary = source.growthTracker?.salaryGrowth || {};
        const oldPortfolio = source.investments?.portfolio;
        const rawAssets = Array.isArray(source.investments?.assets)
            ? source.investments.assets
            : Object.entries(oldPortfolio?.assets || {}).map(([symbol, asset]) => ({ symbol, ...asset }));

        const categories = { ...base.budget.categories };
        const storedCategories = source.budget?.categories;
        if (storedCategories && typeof storedCategories === 'object') {
            Object.entries(storedCategories).forEach(([key, category]) => {
                categories[key] = {
                    name: category?.name || CATEGORY_NAMES[key] || key,
                    limit: Math.max(0, number(category?.limit))
                };
            });
        }

        return {
            transactions: array(source.transactions).map(item => ({
                id: item?.id || createId(),
                type: item?.type === 'income' ? 'income' : 'expense',
                amount: Math.max(0, number(item?.amount)),
                category: item?.category || 'other',
                description: String(item?.description || ''),
                date: item?.date || today()
            })),
            budget: { categories },
            safetyFund: {
                balance: Math.max(0, number(source.safetyFund?.balance)),
                targetMonths: Math.max(1, number(source.safetyFund?.targetMonths, 6)),
                history: array(source.safetyFund?.history),
                confirmationVersion: Number(source.safetyFund?.confirmationVersion || 0),
                pendingConversion: source.safetyFund?.pendingConversion || null,
                newDepositMade: Boolean(source.safetyFund?.newDepositMade),
                lastSeenBalance: Math.max(0, number(source.safetyFund?.lastSeenBalance, number(source.safetyFund?.balance)))
            },
            investments: {
                assets: rawAssets.map(asset => ({
                    id: asset?.id || createId(),
                    symbol: String(asset?.symbol || 'ASSET').toUpperCase(),
                    name: String(asset?.name || asset?.symbol || 'Актив'),
                    quantity: Math.max(0, number(asset?.quantity)),
                    buyPrice: Math.max(0, number(asset?.buyPrice)),
                    currentPrice: Math.max(0, number(asset?.currentPrice, number(asset?.buyPrice)))
                }))
            },
            growth: {
                baseIncome: Math.max(0, number(source.growth?.baseIncome, number(oldSalary.baseSalary))),
                currentIncome: Math.max(0, number(source.growth?.currentIncome, number(oldSalary.currentSalary))),
                history: array(source.growth?.history || source.growthTracker?.incomeGrowthHistory),
                ideas: array(source.growth?.ideas || oldSalary.ideas).map(idea =>
                    typeof idea === 'string'
                        ? { id: createId(), title: idea, status: 'idea' }
                        : { id: idea?.id || createId(), title: String(idea?.title || ''), status: idea?.status || 'idea' }
                )
            }
        };
    }

    function migrateSafety(value) {
        const fund = value.safetyFund;
        if (!fund.confirmationVersion) {
            // One-time correction of the known accidental legacy 1,000 ₽ deposit.
            if (fund.balance === 1000) {
                fund.history.push({ id:createId(), date:today(), type:'correction', amount:-1000, balance:0, description:'Исправление ошибочного пополнения' });
                fund.balance = 0; fund.lastSeenBalance = 0; fund.newDepositMade = false;
            }
            fund.confirmationVersion = 1;
        }
        return value;
    }

    function loadData() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            const value = normalize(stored ? JSON.parse(stored) : null);
            const migrationNeeded = !value.safetyFund.confirmationVersion;
            migrateSafety(value);
            if (stored && migrationNeeded) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
            return value;
        } catch (error) {
            console.error('[Finance] Не удалось прочитать данные:', error);
            return defaults();
        }
    }

    function saveData(notify = true) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            if (notify) document.dispatchEvent(new CustomEvent('goaltracker:finance-changed'));
            return true;
        } catch (error) {
            console.error('[Finance] Не удалось сохранить данные:', error);
            window.app?.showToast?.('Не удалось сохранить изменения. Повторите попытку.', 'error');
            return false;
        }
    }

    function createId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
        else for (let i=0;i<bytes.length;i++) bytes[i]=Math.floor(Math.random()*256);
        bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
        const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }

    function today() {
        return new Date().toISOString().slice(0, 10);
    }

    function money(value) {
        return `${number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
    }

    function percent(value) {
        return `${number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value ?? '');
        return element.innerHTML;
    }

    function monthKey(date = new Date()) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    function currentMonthTransactions() {
        const month = monthKey();
        return data.transactions.filter(item => String(item.date).startsWith(month));
    }

    function totals() {
        return currentMonthTransactions().reduce((result, item) => {
            result[item.type] += number(item.amount);
            return result;
        }, { income: 0, expense: 0 });
    }

    function averageMonthlyExpenses() {
        const expenses = data.transactions.filter(item => item.type === 'expense');
        if (!expenses.length) return 0;
        const monthly = new Map();
        expenses.forEach(item => {
            const key = String(item.date).slice(0, 7) || monthKey();
            monthly.set(key, (monthly.get(key) || 0) + number(item.amount));
        });
        return [...monthly.values()].reduce((sum, value) => sum + value, 0) / monthly.size;
    }

    function progress(value, tone = '') {
        const safe = Math.max(0, Math.min(100, number(value)));
        return `<div class="finance-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(safe)}"><span class="${tone}" style="width:${safe}%"></span></div>`;
    }

    function emptyState(text) {
        return `<div class="finance-empty">${escapeHtml(text)}</div>`;
    }

    function renderAccounting() {
        const summary = totals();
        const balance = summary.income - summary.expense;
        const recent = [...data.transactions].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 30);
        return `
            <div class="finance-terminal"><div class="finance-summary-grid">
                <article class="finance-metric balance"><span>Баланс месяца <span aria-hidden="true">↗</span></span><strong>${money(balance)}</strong><small>Доходы минус расходы</small></article>
                <article class="finance-metric"><span>Финансовая подушка <span aria-hidden="true">◈</span></span><strong>${money(data.safetyFund.balance)}</strong><small>Накоплено к текущему моменту</small></article>
                <article class="finance-metric income"><span>Доход за месяц <span aria-hidden="true">↓</span></span><strong>${money(summary.income)}</strong><small>Расходы: ${money(summary.expense)}</small></article>
            </div>
            <div class="finance-layout">
                <details class="finance-card finance-entry"><summary><span>+ Новая операция</span><span class="entry-disclosure">Раскрыть форму</span></summary>
                    <form class="finance-form" data-finance-form="transaction">
                        <div class="finance-segmented" role="group" aria-label="Тип операции">
                            <label><input type="radio" name="type" value="expense" checked><span>Расход</span></label>
                            <label><input type="radio" name="type" value="income"><span>Доход</span></label>
                        </div>
                        <div class="finance-income-shortcuts" role="group" aria-label="Быстрый ввод дохода">
                            <button type="button" class="btn btn-secondary" data-income-quick="3000" data-description="Смена">+ 3 000 ₽ Смена</button>
                            <button type="button" class="btn btn-secondary" data-income-quick="10000" data-description="Бонус">+ 10 000 ₽ Бонус</button>
                            <button type="button" class="btn btn-secondary" data-income-quick="1000" data-description="">+ 1 000 ₽</button>
                        </div>
                        <div class="finance-form-grid">
                            <label><span>Сумма</span><input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0" required></label>
                            <label><span>Категория</span><select name="category">${Object.entries(CATEGORY_NAMES).map(([key, name]) => `<option value="${key}">${name}</option>`).join('')}</select></label>
                            <label><span>Дата</span><input name="date" type="date" value="${today()}" required></label>
                            <label class="finance-field-wide"><span>Описание</span><input name="description" maxlength="100" placeholder="Например, продукты"></label>
                        </div>
                        <button class="btn btn-primary finance-submit" type="submit">Добавить операцию</button>
                    </form>
                </details>
                <section class="finance-card">
                    <div class="finance-card-head"><div><span class="finance-kicker">История</span><h3>Последние операции</h3></div><span class="finance-count">${data.transactions.length}</span></div>
                    <div class="finance-ledger-wrap"><table class="finance-ledger"><thead><tr><th>Дата</th><th>Операция</th><th>Категория</th><th>Сумма</th></tr></thead><tbody>
                        ${recent.length ? recent.map(item => `<tr><td>${escapeHtml(item.date)}</td><td><span class="ledger-description"><span class="ledger-category-icon" aria-hidden="true">${({salary:"↓",freelance:"⌘",food:"◉",transport:"↗",housing:"⌂",health:"♡",entertainment:"▷"})[item.category] || "◇"}</span><strong>${escapeHtml(item.description || CATEGORY_NAMES[item.category] || 'Операция')}</strong></span></td><td class="ledger-category">${escapeHtml(CATEGORY_NAMES[item.category] || item.category)}</td><td class="${item.type}">${item.type === 'income' ? '+' : '-'}${money(item.amount)}</td></tr>`).join('') : '<tr><td colspan="4">Операций пока нет</td></tr>'}
                    </tbody></table></div>
                    <button type="button" class="btn btn-secondary finance-import" data-finance-import>📄 Импорт выписки (CSV)</button>
                    <p class="finance-caption" data-import-status role="status" hidden></p>
                </section>
            </div></div>`;
    }

    function renderBudget() {
        const spending = currentMonthTransactions().filter(item => item.type === 'expense').reduce((map, item) => {
            map[item.category] = (map[item.category] || 0) + number(item.amount);
            return map;
        }, {});
        const categories = Object.entries(data.budget.categories);
        return `
            <section class="finance-card">
                <div class="finance-card-head"><div><span class="finance-kicker">Шаг 2</span><h3>Бюджет на текущий месяц</h3></div><span class="finance-hint">Лимиты сохраняются автоматически</span></div>
                <form data-finance-form="budget" class="finance-budget-list">
                    ${categories.map(([key, category]) => {
                        const spent = number(spending[key]);
                        const limit = number(category.limit);
                        const used = limit > 0 ? spent / limit * 100 : 0;
                        const tone = used >= 100 ? 'danger' : used >= 80 ? 'warning' : '';
                        return `<div class="finance-budget-row">
                            <div class="finance-budget-meta"><strong>${escapeHtml(category.name)}</strong><span>${money(spent)} из ${money(limit)}</span></div>
                            ${progress(used, tone)}
                            <label><span>Лимит</span><input name="limit-${escapeHtml(key)}" type="number" min="0" step="100" value="${limit}"></label>
                        </div>`;
                    }).join('')}
                    <button class="btn btn-primary finance-submit" type="submit">Сохранить лимиты</button>
                </form>
            </section>`;
    }

    function renderSafety() {
        return `
            <div class="finance-summary-grid">
                <article class="finance-metric balance"><span>Накоплено</span><strong data-safety-balance>${money(data.safetyFund.balance)}</strong></article>
            </div>
            <section class="finance-card">
                <div class="finance-card-head"><h3>Финансовая подушка</h3></div>

                <p class="custodian-status" role="status" aria-live="polite" aria-atomic="true"></p>

                <div class="piggy-quick-row" aria-label="Быстрое пополнение">
                    <button class="piggy-quick-chip" type="button" data-piggy-quick="500">+500 ₽</button>
                    <button class="piggy-quick-chip" type="button" data-piggy-quick="1000">+1 000 ₽</button>
                    <button class="piggy-quick-chip" type="button" data-piggy-quick="2000">+2 000 ₽</button>
                    <button class="piggy-quick-chip" type="button" data-piggy-quick="5000">+5 000 ₽</button>
                    <button class="piggy-quick-chip is-manual" type="button" data-piggy-toggle aria-expanded="${depositFormOpen}" aria-controls="piggyDepositForm">${depositFormOpen ? '✖ Закрыть ввод' : '+ Другая сумма'}</button>
                </div>

                <form class="finance-form finance-inline-form piggy-deposit-form${depositFormOpen ? '' : ' is-collapsed'}" id="piggyDepositForm" data-finance-form="deposit">
                    <label><span>Сумма пополнения</span><input name="amount" type="number" min="0.01" step="0.01" placeholder="0" required></label>
                    <button class="btn btn-primary" type="submit" data-confirm-deposit disabled>Подтвердить внесение</button>
                    <button class="btn btn-secondary" type="button" data-deposit-reset>✕ Сбросить</button>
                </form>
                <p class="finance-hint piggy-safe-note${depositFormOpen ? '' : ' is-collapsed'}">Только сумма — без карт, CVV и паролей. Данные хранятся локально в вашем браузере.</p>

                <button type="button" class="btn btn-secondary safety-use" data-use-safety>➖ Использовать / Снять средства</button>
                <details class="safety-correction"><summary>Изменить сумму накоплений вручную</summary>
                    <form class="finance-form finance-inline-form" data-finance-form="correction">
                        <label><span>Точная сумма накоплений, ₽</span><input name="balance" type="number" min="0" step="0.01" value="${data.safetyFund.balance}" required></label>
                        <button type="submit" class="btn btn-secondary">Сохранить сумму</button>
                    </form>
                </details>
                <section class="safety-history"><h4>История подушки</h4><div data-safety-history>${renderSafetyHistory()}</div></section>

            </section>`;
    }

    function recoverSafetyConversion() {
        const pending = data.safetyFund.pendingConversion;
        if (!pending || !Array.isArray(window.app?.goals)) return;
        const completed = window.app.goals.some(goal => goal.id === pending.goalId && goal.safetyFunding?.id === pending.id && goal.status === 'completed');
        if (!completed) data.safetyFund = pending.previousFund;
        else data.safetyFund.pendingConversion = null;
        saveData();
    }

    function openSafetyUseDialog() {
        if (fundActionPending) return;
        document.getElementById('safetyUseDialog')?.remove();
        const goals = (window.app?.goals || []).filter(goal => goal.priority === 'milestone' && goal.status !== 'completed');
        const dialog = document.createElement('dialog');
        dialog.id = 'safetyUseDialog'; dialog.className = 'safety-use-dialog';
        dialog.setAttribute('aria-labelledby','safetyUseTitle');
        dialog.innerHTML = `<form class="finance-form" id="safetyUseForm">
            <div class="inspector-dialog-header"><h3 id="safetyUseTitle">Использовать подушку</h3><button type="button" class="btn-icon" data-close-safety aria-label="Закрыть">×</button></div>
            <p>Доступно: <strong>${money(data.safetyFund.balance)}</strong></p>
            <label><span>Действие</span><select name="action"><option value="goal">🎯 Трансформировать в Цель/Покупку</option><option value="emergency">🚨 Вынужденный расход / ЧП</option><option value="correction">✏️ Корректировка</option></select></label>
            <label data-safety-goal><span>★ Главная веха</span><select name="goalId">${goals.map(goal => `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.title)}</option>`).join('')}</select><small>${goals.length ? 'Выбранная веха будет выполнена на 100% и добавлена в достижения.' : 'Нет активных главных вех. Создайте цель с приоритетом «★ Главная веха».'}</small></label>
            <label><span data-amount-label>Сумма списания, ₽</span><input name="amount" type="number" min="0.01" max="${data.safetyFund.balance}" step="0.01" inputmode="decimal" required></label>
            <p data-safety-use-preview class="finance-hint" aria-live="polite"></p>
            <p data-safety-use-error role="alert" hidden></p>
            <div class="safety-use-actions"><button type="button" class="btn btn-secondary" data-close-safety>Отмена</button><button type="submit" class="btn btn-primary">Подтвердить</button></div>
        </form>`;
        document.body.appendChild(dialog);
        const form = dialog.querySelector('form');
        const refresh = () => {
            const correction = form.elements.action.value === 'correction';
            const goalMode = form.elements.action.value === 'goal';
            form.querySelector('[data-safety-goal]').hidden = !goalMode;
            form.elements.goalId.required = goalMode;
            form.elements.goalId.disabled = !goalMode;
            form.elements.amount.min = correction ? '0' : '0.01';
            if (correction) form.elements.amount.removeAttribute('max');
            else form.elements.amount.max = data.safetyFund.balance;
            form.querySelector('[data-amount-label]').textContent = correction ? 'Новый баланс подушки, ₽' : 'Сумма списания, ₽';
            const amount = number(form.elements.amount.value);
            form.querySelector('[data-safety-use-preview]').textContent = `После подтверждения в подушке: ${money(correction ? amount : Math.max(0,data.safetyFund.balance-amount))}`;
            form.querySelector('[type="submit"]').disabled = goalMode && !goals.length;
        };
        form.addEventListener('input', refresh); form.addEventListener('change', refresh);
        dialog.querySelectorAll('[data-close-safety]').forEach(button => button.onclick = () => { if (!fundActionPending) dialog.close(); });
        dialog.addEventListener('cancel', event => { if (fundActionPending) event.preventDefault(); });
        dialog.addEventListener('close', () => { if (!fundActionPending) dialog.remove(); });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (fundActionPending || !form.checkValidity()) return;
            const error = form.querySelector('[data-safety-use-error]'); error.hidden = true;
            fundActionPending = true;
            const controls = [...form.querySelectorAll('input,select,button')];
            const values = Object.fromEntries(new FormData(form));
            controls.forEach(control => control.disabled = true);
            form.setAttribute('aria-busy','true');
            try {
                await useSafetyFunds(values);
                dialog.close(); dialog.remove();
                renderFinanceView();
                if (values.action === 'goal') celebrateSafetyConversion();
            } catch (reason) {
                error.textContent = reason.message || 'Изменения не сохранены.'; error.hidden = false;
            } finally {
                fundActionPending = false;
                if (dialog.isConnected) { controls.forEach(control => control.disabled = false); refresh(); form.removeAttribute('aria-busy'); }
            }
        });
        refresh(); dialog.showModal();
    }

    async function useSafetyFunds(values) {
        const amount = number(values.amount,-1);
        const correction = values.action === 'correction';
        if (!['goal','emergency','correction'].includes(values.action) || amount < 0 || (!correction && amount <= 0)) throw new Error('Введите корректную сумму.');
        if (!correction && amount > data.safetyFund.balance) throw new Error('Недостаточно средств в подушке.');
        const app = window.app;
        const goal = values.action === 'goal' ? app?.goals?.find(item => item.id === values.goalId && item.priority === 'milestone' && item.status !== 'completed') : null;
        if (values.action === 'goal' && (!goal || app._goalActionPending || app._goalSaveInProgress)) throw new Error('Выберите доступную главную веху и дождитесь сохранения целей.');
        const previousFund = JSON.parse(JSON.stringify(data.safetyFund));
        const id = createId(), now = new Date().toISOString();
        const balance = correction ? amount : Math.round((previousFund.balance-amount)*100)/100;
        const entry = {id,type:correction ? 'correction' : values.action === 'goal' ? 'conversion' : 'emergency',date:today(),amount:correction ? balance-previousFund.balance : -amount,balance,
            ...(goal ? {goalId:goal.id,description:goal.title} : values.action === 'emergency' ? {description:'Щит сработал'} : {})};
        data.safetyFund = {...previousFund,balance,lastSeenBalance:balance,history:[...previousFund.history,entry],pendingConversion:goal ? {id,goalId:goal.id,previousFund} : null};
        if (!saveData(false)) { data.safetyFund = previousFund; throw new Error('Не удалось сохранить баланс. Средства не списаны.'); }
        if (goal) {
            const next = {...goal,status:'completed',progress:100,completedAt:now,safetyFunding:{id,amount,date:now},
                subgoals:(goal.subgoals || []).map(step => ({...step,completed:true,completedAt:step.completedAt || now}))};
            const achievement = {id:createId(),goalId:goal.id,title:`Завершена цель: ${goal.title}`,description:goal.description || '',date:today(),progress:100,protected:true,autoCreated:true,createdAt:now};
            let saved = false;
            try { saved = await app.persistGoalAction(app.goals.map(item => item === goal ? next : item),[...app.achievements.filter(item => !(item.autoCreated && item.goalId === goal.id)),achievement]); } catch { saved = false; }
            if (!saved) {
                data.safetyFund = previousFund;
                saveData(false);
                throw new Error('Цель не сохранена. Списание отменено.');
            }
            data.safetyFund.pendingConversion = null;
        }
        saveData();
        app?.render?.();
        app?.showToast?.(goal ? 'Капитал успешно конвертирован в Достижение!' : correction ? 'Баланс скорректирован' : 'Щит сработал', 'success');
    }

    function celebrateSafetyConversion() {
        const stage = document.querySelector('#finance-inspector .custodian-stage');
        if (!stage) return;
        const status = stage.querySelector('.custodian-conversion-status');
        if (status) status.textContent = 'Капитал успешно конвертирован в Достижение!';
        if (!motionPreference?.matches && !document.hidden) {
            stage.classList.add('is-converting');
            celebrationTimers.push(window.setTimeout(() => stage.classList.remove('is-converting'),2800));
        }
    }

    function renderSafetyHistory() {
        return [...data.safetyFund.history].reverse().slice(0,20).map(entry => `<div class="safety-history-row"><div><strong>${entry.type === 'deposit' ? '+' : ''}${money(number(entry.amount))}</strong><small>${escapeHtml(entry.date || '')} · ${escapeHtml(entry.voided ? 'Отменено' : entry.type === 'deposit' ? 'Пополнение' : entry.type === 'conversion' ? 'Цель: ' + (entry.description || '') : entry.type === 'emergency' ? 'Щит сработал' : 'Корректировка / старая запись')}</small></div>${entry.type === 'deposit' && !entry.voided ? `<button type="button" class="btn btn-secondary" data-cancel-deposit="${escapeHtml(entry.id)}">Отменить</button>` : ''}</div>`).join('') || '<p class="finance-hint">Пополнений пока нет.</p>';
    }

    function updateDepositConfirmation() {
        const form = document.getElementById('piggyDepositForm');
        if (!form) return;
        const amount = number(form.elements.namedItem('amount').value);
        const button = form.querySelector('[data-confirm-deposit]');
        button.disabled = amount <= 0 || !form.checkValidity();
        button.textContent = amount > 0 ? `Подтвердить внесение (+${money(amount)})` : 'Подтвердить внесение';
    }

    // Effects never change the deposit balance or rebuild the scene.
    function clearCustodianCelebration(stage = document.querySelector('.custodian-stage')) {
        celebrationTimers.forEach(window.clearTimeout);
        celebrationTimers = [];
        stage?.classList.remove('is-celebrating');
        stage?.querySelector('.custodian-confetti')?.replaceChildren();
    }

    function syncCustodianVisibility() {
        const stage = document.querySelector('.custodian-stage');
        if (!stage) return;
        const paused = document.hidden || stage.dataset.offscreen === 'true';
        stage.classList.toggle('is-paused', paused);
        if (paused || motionPreference?.matches) clearCustodianCelebration(stage);
    }

    function setupCustodianScene() {
        custodianObserver?.disconnect();
        const stage = document.querySelector('.custodian-stage');
        if (!stage) return;
        if ('IntersectionObserver' in window) {
            stage.dataset.offscreen = 'false';
            custodianObserver = new IntersectionObserver(entries => {
                if (!stage.isConnected) return;
                stage.dataset.offscreen = String(!entries[0].isIntersecting);
                syncCustodianVisibility();
            }, { threshold: 0 });
            custodianObserver.observe(stage);
        }
        syncCustodianVisibility();
    }

    function celebrateCustodian(amount) {
        const stage = document.querySelector('.custodian-stage');
        if (!stage) return;
        clearCustodianCelebration(stage);
        if (document.hidden || motionPreference?.matches || stage.classList.contains('is-paused')) return;
        // One layout read restarts only this finite animation after rapid deposits.
        void stage.offsetWidth;
        const badge = stage.querySelector('.custodian-deposit-badge');
        if (badge) badge.textContent = `+${money(amount)}`;
        stage.classList.add('is-celebrating');
        celebrationTimers.push(window.setTimeout(() => {
            if (!stage.isConnected || document.hidden) return;
            const host = stage.querySelector('.custodian-confetti');
            if (!host) return;
            for (let i = 0; i < 24; i += 1) {
                const particle = document.createElement('i');
                const angle = i / 24 * Math.PI * 2;
                const radius = 65 + Math.random() * 65;
                particle.style.setProperty('--burst-x', `${Math.cos(angle) * radius}px`);
                particle.style.setProperty('--burst-y', `${Math.sin(angle) * radius + 35}px`);
                particle.style.setProperty('--burst-turn', `${90 + Math.random() * 270}deg`);
                particle.style.setProperty('--burst-color', i % 3 === 0 ? '#ecfeff' : i % 2 ? '#22d3ee' : '#fbbf24');
                host.appendChild(particle);
            }
        }, 500));
        celebrationTimers.push(window.setTimeout(() => clearCustodianCelebration(stage), 2500));
    }

    function addSafetyDeposit(value) {
        const amount = Math.max(0, number(value));
        if (amount <= 0) return false;
        data.safetyFund.balance = Math.round((data.safetyFund.balance + amount) * 100) / 100;
        data.safetyFund.history.push({ id:createId(), type:'deposit', amount, date: today(), balance: data.safetyFund.balance });
        data.safetyFund.newDepositMade = true;
        return true;
    }

    function animateSafetyValue(element) {
        if (!element) return;
        element.classList.remove('is-updating');
        void element.offsetWidth;
        element.classList.add('is-updating');
    }

    function updateSafetyUi() {
        const monthly = averageMonthlyExpenses();
        const months = monthly > 0 ? data.safetyFund.balance / monthly : 0;
        const targetAmount = monthly * data.safetyFund.targetMonths;
        const completed = targetAmount > 0 ? data.safetyFund.balance / targetAmount * 100 : 0;
        const safeProgress = Math.max(0, Math.min(100, number(completed)));
        const balanceElement = document.querySelector('[data-safety-balance]');
        const monthsElement = document.querySelector('[data-safety-months]');
        const percentElement = document.querySelector('[data-safety-percent]');
        const progressElement = document.querySelector('.finance-card .finance-progress');
        if (balanceElement) balanceElement.textContent = money(data.safetyFund.balance);
        if (monthsElement) monthsElement.textContent = `${months.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} мес.`;
        if (percentElement) percentElement.textContent = percent(completed);
        if (progressElement) {
            progressElement.setAttribute('aria-valuenow', String(Math.round(safeProgress)));
            const fill = progressElement.querySelector('span');
            if (fill) fill.style.width = `${safeProgress}%`;
        }
        [balanceElement, monthsElement, percentElement].forEach(animateSafetyValue);
    }

    function closeManualDepositForm() {
        depositFormOpen = false;
        const form = document.getElementById('piggyDepositForm');
        const note = document.querySelector('.piggy-safe-note');
        const toggle = document.querySelector('[data-piggy-toggle]');
        form?.classList.add('is-collapsed');
        note?.classList.add('is-collapsed');
        if (toggle) {
            toggle.setAttribute('aria-expanded', 'false');
            toggle.textContent = '+ Другая сумма';
        }
    }

    function toggleManualDepositForm() {
        depositFormOpen = !depositFormOpen;
        const form = document.getElementById('piggyDepositForm');
        const note = document.querySelector('.piggy-safe-note');
        const toggle = document.querySelector('[data-piggy-toggle]');
        form?.classList.toggle('is-collapsed', !depositFormOpen);
        note?.classList.toggle('is-collapsed', !depositFormOpen);
        if (toggle) {
            toggle.setAttribute('aria-expanded', String(depositFormOpen));
            toggle.textContent = depositFormOpen ? '✖ Закрыть ввод' : '+ Другая сумма';
        }
        if (depositFormOpen) form?.querySelector('input[name="amount"]')?.focus();
    }

    function completeInstantDeposit(value, closeForm = false) {
        const previous = JSON.parse(JSON.stringify(data.safetyFund));
        if (!addSafetyDeposit(value)) return false;
        data.safetyFund.newDepositMade = false;
        data.safetyFund.lastSeenBalance = data.safetyFund.balance;
        if (!saveData()) { data.safetyFund = previous; return false; }
        updateSafetyUi();
        const history = document.querySelector('[data-safety-history]');
        if (history) history.innerHTML = renderSafetyHistory();
        if (closeForm) closeManualDepositForm();
        const status = document.querySelector('.custodian-status');
        if (status) status.textContent = `Подушка пополнена на ${money(number(value))}`;
        window.app?.renderInspectorOverview?.();
        setupCustodianScene();
        const container = document.getElementById('financeMain');
        if (container) container._financeSignature = financeSignature();
        celebrateCustodian(number(value));
        return true;
    }

    // Acknowledge imported/legacy deposits without replaying a button celebration.
    function acknowledgeSavingsOnEntry() {
        const fund = data.safetyFund;
        const hasNewDeposit = fund.newDepositMade === true;
        const balanceGrew = fund.balance > fund.lastSeenBalance;
        if (!hasNewDeposit && !balanceGrew) return;
        fund.newDepositMade = false;
        fund.lastSeenBalance = fund.balance;
        saveData();
    }

    const renderers = {
        accounting: renderAccounting,
        budget: renderBudget,
        safety: renderSafety
    };

    function financeSignature() {
        const visible = activeStep === 'safety' ? [data.safetyFund.balance,data.safetyFund.history]
            : activeStep === 'budget' ? [data.budget,data.transactions] : [data.transactions,data.safetyFund.balance];
        return JSON.stringify([activeStep,visible]);
    }

    function captureFinanceDrafts(container) {
        const forms = [...container.querySelectorAll('form')].map(form => ({
            key:form.dataset.financeForm,
            fields:[...form.elements].filter(field => field.name).map(field => ({name:field.name,type:field.type,value:field.value,checked:field.checked}))
        }));
        const focus = document.activeElement;
        return {forms,details:[...container.querySelectorAll('details')].map(detail => detail.open),
            focus:container.contains(focus) && focus.name ? {form:focus.form?.dataset.financeForm,name:focus.name,start:focus.selectionStart,end:focus.selectionEnd} : null};
    }
    function restoreFinanceDrafts(container,draft) {
        for (const saved of draft.forms) {
            const form = [...container.querySelectorAll('form')].find(form => form.dataset.financeForm === saved.key);
            if (!form) continue;
            for (const value of saved.fields) {
                const field = [...form.elements].find(field => field.name === value.name && (value.type !== 'radio' || field.value === value.value));
                if (!field) continue;
                if (value.type === 'radio' || value.type === 'checkbox') field.checked = value.checked;
                else field.value = value.value;
            }
        }
        [...container.querySelectorAll('details')].forEach((detail,index) => { detail.open = draft.details[index] || false; });
        updateDepositConfirmation();
        if (draft.focus) {
            const field = [...container.querySelectorAll('form')].find(form => form.dataset.financeForm === draft.focus.form)?.elements.namedItem(draft.focus.name);
            field?.focus?.({preventScroll:true});
            if (draft.focus.start !== null) { try { field?.setSelectionRange(draft.focus.start,draft.focus.end); } catch {} }
        }
    }

    function renderFinanceView(externalEntry = false) {
        const container = document.getElementById('financeMain');
        if (!container) {
            console.error('[Finance] #financeMain not found');
            return;
        }
        recoverSafetyConversion();
        data = normalize(data);
        if (!renderers[activeStep]) activeStep = 'accounting';
        bindEvents(container);
        const signature = financeSignature();
        if (externalEntry && container._financeSignature === signature && container.childElementCount) {
            window.app?.renderInspectorOverview?.(); return;
        }
        const draft = externalEntry && renderedStep === activeStep ? captureFinanceDrafts(container) : null;
        container._financeSignature = signature;
        const enteringSafety = activeStep === 'safety' && (externalEntry || renderedStep !== 'safety');
        renderedStep = activeStep;
        clearCustodianCelebration();
        custodianObserver?.disconnect();
        container.innerHTML = `
            <nav class="finance-tabs" aria-label="Шаги финансовой грамотности">
                ${[
                    ['accounting', 'Учёт'],
                    ['budget', 'Бюджет'],
                    ['safety', 'Подушка']
                ].map(([id, title]) => `<button type="button" class="finance-tab ${activeStep === id ? 'active' : ''}" data-finance-step="${id}" aria-selected="${activeStep === id}">${title}</button>`).join('')}
            </nav>
            <div class="finance-panel" data-finance-panel>${renderers[activeStep]()}</div>`;

        if (draft) restoreFinanceDrafts(container,draft);
        // Re-rendering replaces the strip; keep the selected mobile tab in view.
        window.app?.renderInspectorOverview?.();
        const tabs = container.querySelector('.finance-tabs');
        const selectedTab = tabs.querySelector('.active');
        if (window.matchMedia?.('(max-width: 600px)').matches && selectedTab) {
            tabs.scrollLeft = Math.max(0, selectedTab.offsetLeft - tabs.offsetLeft - (tabs.clientWidth - selectedTab.offsetWidth) / 2);
        }
        setupCustodianScene();
        if (activeStep === 'safety' && enteringSafety) acknowledgeSavingsOnEntry();
    }

    function bindEvents(container) {
        if (eventsBound) return;
        eventsBound = true;
        container.addEventListener('click', event => {
            if (fundActionPending) return;
            if (event.target.closest('[data-use-safety]')) { openSafetyUseDialog(); return; }
            if (event.target.closest('[data-deposit-reset]')) {
                document.getElementById('piggyDepositForm')?.reset();
                updateDepositConfirmation(); closeManualDepositForm(); return;
            }
            const cancel = event.target.closest('[data-cancel-deposit]');
            if (cancel) {
                const entry = data.safetyFund.history.find(item => item.id === cancel.dataset.cancelDeposit);
                if (!entry || entry.voided || entry.type !== 'deposit') return;
                if (entry.amount > data.safetyFund.balance) {
                    window.app?.showToast?.('Сумма уже скорректирована. Измените накопления вручную.', 'warning'); return;
                }
                const previous = JSON.parse(JSON.stringify(data.safetyFund));
                entry.voided = true;
                data.safetyFund.balance = Math.round((data.safetyFund.balance - entry.amount) * 100) / 100;
                data.safetyFund.lastSeenBalance = data.safetyFund.balance;
                if (!saveData()) { data.safetyFund = previous; return; }
                renderFinanceView(); return;
            }
            const quickIncome = event.target.closest('[data-income-quick]');
            if (quickIncome) {
                const form = quickIncome.closest('form');
                form.elements.namedItem('type').value = 'income';
                form.elements.namedItem('amount').value = quickIncome.dataset.incomeQuick;
                form.elements.namedItem('category').value = 'salary';
                form.elements.namedItem('description').value = quickIncome.dataset.description;
                form.elements.namedItem('amount').focus();
                return;
            }
            if (event.target.closest('[data-finance-import]')) {
                const status = container.querySelector('[data-import-status]');
                status.hidden = false;
                status.textContent = 'Импорт банковских CSV-выписок появится в следующем обновлении.';
                return;
            }
            const quickDeposit = event.target.closest('[data-piggy-quick]');
            if (quickDeposit) {
                depositFormOpen = false;
                toggleManualDepositForm();
                document.querySelector('#piggyDepositForm input[name="amount"]').value = quickDeposit.dataset.piggyQuick;
                updateDepositConfirmation();
                return;
            }
            const toggle = event.target.closest('[data-piggy-toggle]');
            if (toggle) {
                toggleManualDepositForm();
                return;
            }
            const tab = event.target.closest('[data-finance-step]');
            if (!tab) return;
            activeStep = tab.dataset.financeStep;
            renderFinanceView();
        });
        container.addEventListener('submit', handleSubmit);
        container.addEventListener('input', event => { if (event.target.closest('#piggyDepositForm')) updateDepositConfirmation(); });
    }

    function handleSubmit(event) {
        if (fundActionPending) { event.preventDefault(); return; }
        const form = event.target.closest('[data-finance-form]');
        if (!form) return;
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form));

        switch (form.dataset.financeForm) {
            case 'transaction': {
                const amount = number(values.amount);
                if (amount <= 0) return;
                data.transactions.push({ id: createId(), type: values.type === 'income' ? 'income' : 'expense', amount, category: values.category || 'other', description: String(values.description || '').trim(), date: values.date || today() });
                break;
            }
            case 'budget':
                Object.keys(data.budget.categories).forEach(key => {
                    data.budget.categories[key].limit = Math.max(0, number(values[`limit-${key}`]));
                });
                break;
            case 'safety':
                data.safetyFund.targetMonths = Math.max(1, number(values.targetMonths, 6));
                break;
            case 'correction': {
                const balance = number(values.balance, -1);
                if (balance < 0 || !form.checkValidity()) return;
                const previous = JSON.parse(JSON.stringify(data.safetyFund));
                data.safetyFund.history.push({id:createId(),type:'correction',date:today(),amount:balance-data.safetyFund.balance,balance});
                data.safetyFund.balance = balance; data.safetyFund.lastSeenBalance = balance;
                if (!saveData()) { data.safetyFund = previous; return; }
                renderFinanceView(); return;
            }
            case 'deposit': {
                if (!completeInstantDeposit(values.amount, true)) return;
                form.reset();
                updateDepositConfirmation();
                return;
            }
            default:
                return;
        }
        saveData();
        renderFinanceView();
    }

    // Existing public finance API is preserved.
    function renderFinanceViewExternal() {
        renderFinanceView(true);
    }

    document.addEventListener('visibilitychange', syncCustodianVisibility);
    motionPreference?.addEventListener?.('change', syncCustodianVisibility);

    window.renderFinanceView = renderFinanceViewExternal;
    window.finance = { renderFinanceView: renderFinanceViewExternal,
        getData: () => JSON.parse(JSON.stringify(data)),
        getSafetySummary() {
            const monthly = averageMonthlyExpenses(), target = monthly * data.safetyFund.targetMonths;
            return { balance:data.safetyFund.balance,target,targetMonths:data.safetyFund.targetMonths,
                months:monthly > 0 ? data.safetyFund.balance/monthly : null,
                percent:target > 0 ? Math.min(100,Math.round(data.safetyFund.balance/target*100)) : null,
                recent:data.safetyFund.history.filter(entry => !entry.voided && Number.isFinite(entry.amount)).slice(-3).reverse() };
        },
        clearData() { document.getElementById('safetyUseDialog')?.remove(); data = defaults(); activeStep = 'accounting'; renderedStep = null; depositFormOpen = false; celebrationTimers.forEach(id => clearTimeout(id)); celebrationTimers = []; custodianObserver?.disconnect(); document.getElementById('financeMain')?.replaceChildren(); },
        replaceData(next) {
            const normalized = migrateSafety(normalize(next));
            if (JSON.stringify(normalized) === JSON.stringify(data)) return;
            data = normalized;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            if (window.app?.currentView === 'finance') renderFinanceView(true);
        }
    };
})();
