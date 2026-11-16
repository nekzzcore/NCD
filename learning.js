(() => {
    'use strict';
    const M = window.WorkspaceModules;
    const milestones = [1000,1300,1500,1800,2000];
    const draws = new Set(['agreed','repetition','stalemate','insufficient','50move','timevsinsufficient','draw']);
    let bound = false, chessRequest = null;
    function eloProgress(elo) {
        const next = milestones.find(value => value > elo), previous = [0,...milestones].filter(value => value <= elo).pop();
        return {next:next || 2000,percent:next ? Math.max(0,Math.min(100,(elo-previous)/(next-previous)*100)) : 100};
    }
    function bookProgress(book) {
        const value = typeof book.progress === 'number' ? book.progress : Number(book.total) > 0 ? Number(book.pages || 0)/Number(book.total)*100 : 0;
        return Math.max(0,Math.min(100,Math.round(Number.isFinite(value) ? value : 0)));
    }
    function topicProgress(topic) {
        const value = Number(topic.mastery ?? (topic.completed ? 100 : 0));
        return Number.isFinite(value) ? Math.max(0,Math.min(100,Math.round(value))) : 0;
    }
    function summary(workspace = {}) {
        const topics = workspace.topics || [], books = workspace.books || [];
        return {read:books.filter(book => bookProgress(book) >= 100).length,reading:books.filter(book => bookProgress(book) < 100).length,
            topics:topics.length,mastery:topics.length ? Math.round(topics.reduce((sum,topic) => sum+topicProgress(topic),0)/topics.length) : 0};
    }
    function summarizeGames(games,username) {
        const summary = {win:0,loss:0,draw:0,total:0};
        const seen = new Set();
        const recent = [...games].sort((a,b) => b.end_time-a.end_time).filter(game => {
            const mine = [game.white,game.black].find(player => player?.username?.toLowerCase() === username);
            const identity = game.url || `${game.end_time}:${game.white?.username}:${game.black?.username}`;
            if (!mine?.result || game.rules && game.rules !== 'chess' || !['rapid','blitz'].includes(game.time_class) || seen.has(identity)) return false;
            seen.add(identity); return true;
        }).slice(0,20);
        for (const game of recent) {
            const mine = [game.white,game.black].find(player => player?.username?.toLowerCase() === username);
            if (mine.result === 'win') summary.win++; else if (draws.has(mine.result)) summary.draw++; else summary.loss++;
            summary.total++;
        }
        return summary;
    }
    async function chessJSON(url,signal) {
        const response = await fetch(url,{signal,credentials:'omit'});
        if (!response.ok) throw Error(response.status === 404 ? 'Игрок Chess.com не найден. Проверьте ник.' : response.status === 429 ? 'Chess.com ограничил запросы. Подождите и повторите.' : 'Chess.com временно недоступен. Повторите позже.');
        return response.json();
    }
    async function refreshChess(app,username) {
        username = String(username || '').trim().toLowerCase();
        if (chessRequest || !/^[a-z0-9_-]{2,25}$/.test(username)) return false;
        const owner = app.user?.id, epoch = app._dataEpoch, controller = new AbortController();
        controller.owner = owner; controller.epoch = epoch;
        chessRequest = controller;
        const timeout = setTimeout(() => controller.abort(),30000);
        const current = () => epoch === app._dataEpoch && owner === app.user?.id && !app._accountTransition;
        const host = document.getElementById('learningMain');
        const controls = [...host.querySelectorAll('#chessForm input,#chessForm button')];
        controls.forEach(control => control.disabled = true);
        const status = host.querySelector('#chessStatus'); status.textContent = 'Получаем статистику Chess.com…';
        try {
            const base = `https://api.chess.com/pub/player/${encodeURIComponent(username)}`;
            const response = await chessJSON(`${base}/stats`,controller.signal);
            if (!current()) return false;
            const stats = {};
            for (const mode of ['rapid','blitz']) {
                const row = response[`chess_${mode}`], rating = row?.last?.rating;
                if (Number.isInteger(rating) && rating >= 0 && rating <= 5000) stats[mode] = {rating,lastGame:Number(row.last.date) || null};
            }
            let recent = null, recentError = false;
            try {
                const archiveList = await chessJSON(`${base}/games/archives`,controller.signal);
                if (!Array.isArray(archiveList.archives)) throw Error('Invalid archives');
                const archives = archiveList.archives.filter(url => typeof url === 'string' && url.startsWith(base+'/games/') && /^\d{4}\/\d{2}$/.test(url.slice((base+'/games/').length))).slice(-2).reverse();
                const games = [];
                for (const archive of archives) {
                    if (!current()) return false;
                    const data = await chessJSON(archive,controller.signal);
                    if (!Array.isArray(data.games)) throw Error('Invalid games');
                    games.push(...data.games);
                    if (summarizeGames(games,username).total >= 20) break;
                }
                recent = summarizeGames(games,username);
            } catch { recentError = true; }
            if (!current()) return false;
            const now = new Date().toISOString();
            const saved = await M.save(app,data => {
                data.chess = {username,stats,recent,recentError,updatedAt:now};
                for (const [mode,row] of Object.entries(stats)) {
                    const last = [...data.eloHistory].reverse().find(item => item.username === username && item.mode === mode);
                    if (!last || last.rating !== row.rating) data.eloHistory.push({id:M.uid(),rating:row.rating,date:now,mode,username,source:'chess.com',lastGame:row.lastGame});
                }
                return data;
            });
            if (saved) render(app);
            else if (current()) status.textContent = 'Не удалось сохранить статистику. Повторите обновление.';
            return saved;
        } catch (error) {
            if (current()) status.textContent = error.name === 'AbortError' ? 'Время ожидания истекло. Сохранённая статистика доступна, повторите позже.' : error.message === 'Failed to fetch' ? 'Нет соединения с Chess.com. Проверьте сеть и повторите.' : error.message;
            return false;
        } finally {
            clearTimeout(timeout); chessRequest = null;
            [...controls,...host.querySelectorAll('#chessForm input,#chessForm button')].forEach(control => control.disabled = false);
            if (status.isConnected && status.textContent.startsWith('Получаем')) status.textContent = '';
        }
    }
    function chart(history,mode,username) {
        const points = history.filter(row => row.mode === mode && row.username === username && Number.isFinite(row.rating) && Number.isFinite(Date.parse(row.date))).slice(-30);
        if (!points.length) return '';
        const low = Math.min(...points.map(row => row.rating)), high = Math.max(...points.map(row => row.rating));
        const start = Date.parse(points[0].date), end = Date.parse(points.at(-1).date);
        const coords = points.map(row => [points.length === 1 ? 160 : 30+(Date.parse(row.date)-start)/(end-start || 1)*260,85-(row.rating-low)/(high-low || 1)*55]);
        return `<figure class="chess-chart"><figcaption>${mode === 'rapid' ? 'Rapid' : 'Blitz'} · история рейтинга</figcaption><svg viewBox="0 0 320 120" role="img" aria-label="${mode}: от ${points[0].rating} до ${points.at(-1).rating} ELO"><path d="M30 20v70h260" class="chart-axis"/><polyline points="${coords.map(point => point.join(',')).join(' ')}"/>${coords.map(([x,y]) => `<circle cx="${x}" cy="${y}" r="3"/>`).join('')}<text x="4" y="24">${high}</text><text x="4" y="90">${low}</text><text x="30" y="112">${M.esc(new Date(start).toLocaleDateString('ru-RU'))}</text><text x="290" y="112" text-anchor="end">${M.esc(new Date(end).toLocaleDateString('ru-RU'))}</text></svg></figure>`;
    }
    function render(app, addedId = null) {
        const host = document.getElementById('learningMain'); if (!host) return;
        const d = M.data(app), chess = d.chess || {}, stats = chess.stats || {};
        const history = [...d.eloHistory].sort((a,b) => String(a.date).localeCompare(b.date));
        const manual = history.filter(row => !row.mode || row.mode === 'manual').at(-1);
        const elo = stats.rapid?.rating ?? stats.blitz?.rating ?? manual?.rating ?? 0, p = eloProgress(elo);
        const openDetails = new Set([...host.querySelectorAll('details[open][id]')].map(el => el.id));
        const statsSummary = summary(d);
        const newClass = id => id === addedId ? ' learning-added' : '';
        const book = item => {
            const percent = bookProgress(item), done = percent >= 100;
            return `<article class="module-card book-card${newClass(item.id)}" data-learning-card="${M.esc(item.id)}">
                <div class="book-card-heading"><span class="book-mark" aria-hidden="true">${done ? '✓' : '▤'}</span><div><h4>${M.esc(item.title)}</h4>${item.author ? `<p class="module-muted">${M.esc(item.author)}</p>` : ''}</div><button type="button" class="btn-icon" data-learn-delete="books" data-id="${M.esc(item.id)}" aria-label="Удалить книгу ${M.esc(item.title)}">×</button></div>
                <label class="module-field book-slider-label"><span>Прогресс чтения</span><input type="range" min="0" max="100" step="1" value="${percent}" data-book-slider="${M.esc(item.id)}" aria-label="Прогресс книги ${M.esc(item.title)}" aria-valuetext="${percent}%"></label>
                <progress value="${percent}" max="100"></progress><output class="book-progress-text">${done ? 'Прочитано · 100%' : `Книга прочитана на ${percent}%`}</output>
            </article>`;
        };
        host.innerHTML = `<section class="module-section learning-books" aria-labelledby="learningBooksTitle">
            <div class="learning-section-heading"><div><span class="learning-eyebrow">Чтение</span><h3 id="learningBooksTitle">Книги</h3></div><span class="learning-count">${statsSummary.reading} в чтении · ${statsSummary.read} прочитано</span></div>
            <details class="module-editor learning-add-editor" id="addBookEditor"><summary>+ Добавить книгу</summary><form id="bookForm" class="module-form">${M.field('Название','title','text','','required maxlength="200"')}${M.field('Автор','author','text','','maxlength="200"')}<button class="btn btn-primary">Добавить книгу</button></form></details>
            <h4 class="learning-subheading">Сейчас читаю</h4><div class="module-grid book-grid">${d.books.filter(item => bookProgress(item) < 100).map(book).join('') || '<p class="learning-empty">Выберите книгу, которую хочется открыть сегодня.</p>'}</div>
            <details class="learning-completed" id="completedBooks" ${d.books.some(item => item.id === addedId && bookProgress(item) >= 100) ? 'open' : ''}><summary>Прочитано <span>${statsSummary.read}</span></summary><div class="module-grid book-grid">${d.books.filter(item => bookProgress(item) >= 100).map(book).join('') || '<p class="learning-empty">Прочитанные книги останутся здесь.</p>'}</div></details>
        </section>
        <section class="module-section learning-knowledge" aria-labelledby="learningKnowledgeTitle">
            <div class="learning-section-heading"><div><span class="learning-eyebrow">Практика и открытия</span><h3 id="learningKnowledgeTitle">База знаний</h3></div><span class="learning-count">${statsSummary.topics} тем · освоение ${statsSummary.mastery}%</span></div>
            <p class="learning-description">Оценивайте, насколько уверенно владеете темой сейчас. Подтемы и заметки помогут увидеть, что уже удалось понять.</p>
            <form id="topicForm" class="module-inline">${M.field('Новая тема','title','text','','required maxlength="200" placeholder="Английский, психология…"')}<button class="btn btn-primary">+ Добавить тему</button></form>
            <div class="module-grid knowledge-grid">${d.topics.map(topic => `<article class="module-card knowledge-topic${newClass(topic.id)}" data-learning-card="${M.esc(topic.id)}">
                <div class="knowledge-heading"><h4>${M.esc(topic.title)}</h4><button type="button" class="btn-icon" data-learn-delete="topics" data-id="${M.esc(topic.id)}" aria-label="Удалить тему ${M.esc(topic.title)}">×</button></div>
                <label class="module-field"><span>Уровень погружения <output class="topic-mastery-value">${topicProgress(topic)}%</output></span><input type="range" min="0" max="100" step="1" data-topic-mastery="${M.esc(topic.id)}" value="${topicProgress(topic)}" aria-label="Уровень погружения: ${M.esc(topic.title)}" aria-valuetext="${topicProgress(topic)}%"></label>
                <details class="knowledge-reflection" id="reflection-${M.esc(topic.id)}"><summary>Заметки и рефлексия${topic.notes ? ' · есть запись' : ''}</summary><form data-topic-notes="${M.esc(topic.id)}" class="module-form"><label class="module-field">Что узнал и где применю<textarea name="notes" maxlength="20000" placeholder="Короткое открытие, пример или следующий шаг…">${M.esc(topic.notes)}</textarea></label><button class="btn btn-secondary">Сохранить заметки</button></form></details>
                <div class="knowledge-steps-heading">Подтемы <span>${(topic.steps || []).filter(step => step.completed).length}/${(topic.steps || []).length}</span></div>
                <ul class="knowledge-steps">${(topic.steps || []).map(step => `<li class="${step.completed ? 'is-studied' : ''}"><label><input type="checkbox" data-topic-step="${M.esc(topic.id)}" data-id="${M.esc(step.id)}" ${step.completed ? 'checked' : ''}><span>${M.esc(step.title)}</span></label></li>`).join('')}</ul>
                <form data-topic-add="${M.esc(topic.id)}" class="module-inline">${M.field('Подтема','title','text','','required maxlength="300" placeholder="Что хочется разобрать?"')}<button class="btn btn-secondary">Добавить</button></form>
            </article>`).join('') || '<p class="learning-empty">Добавьте тему, к которой хотите возвращаться.</p>'}</div>
        </section>
        <details class="module-section learning-chess" id="learningChess"><summary><span>♟ Шахматы <small>Chess.com · дополнительный навык</small></span><span class="learning-chess-rating">${stats.rapid ? `Rapid ${stats.rapid.rating}` : 'Статистика'}${stats.blitz ? ` · Blitz ${stats.blitz.rating}` : ''}</span></summary><div class="learning-chess-body">
            <form id="chessForm" class="module-inline">${M.field('Ваш ник на Chess.com','username','text',chess.username || '','required maxlength="25" pattern="[A-Za-z0-9_-]{2,25}" autocomplete="off" placeholder="Никнейм игрока"')}
                <button class="btn btn-primary" type="submit" name="action" value="refresh">🔄 Обновить статистику</button><button class="btn btn-secondary" type="submit" name="action" value="save">Сохранить ник</button></form>
            <p id="chessStatus" class="module-muted" role="status" aria-live="polite"></p>
            <div class="chess-rating-grid">${['rapid','blitz'].map(mode => `<article class="module-card"><span>${mode === 'rapid' ? 'Rapid' : 'Blitz'}</span><p class="elo-number">${stats[mode]?.rating ?? '—'} <small>ELO</small></p></article>`).join('')}</div>
            ${chess.recent ? `<p class="chess-recent">Последние ${chess.recent.total} доступных партий Rapid/Blitz: <strong>${chess.recent.win}</strong> побед · <strong>${chess.recent.loss}</strong> поражений · <strong>${chess.recent.draw}</strong> ничьих</p>` : `<p class="module-muted">${chess.recentError ? 'Последние партии временно недоступны. Рейтинг обновлён.' : 'Обновите статистику, чтобы увидеть последние партии.'}</p>`}
            ${chess.updatedAt ? `<p class="module-muted">Запрошено: ${M.esc(new Date(chess.updatedAt).toLocaleString('ru-RU'))}. Chess.com может отдавать статистику с задержкой.</p>` : ''}
            <progress value="${p.percent}" max="100"></progress><p class="module-muted">${elo >= 2000 ? 'Веха 2000 достигнута' : `Следующая веха: ${p.next} · ещё ${p.next-elo} ELO (${stats.rapid ? 'Rapid' : stats.blitz ? 'Blitz' : 'вручную'})`}</p>
            <div class="chess-rating-grid">${chart(history,'rapid',chess.username)}${chart(history,'blitz',chess.username)}</div>
            <details><summary>История рейтинга (${history.length})</summary><ol class="elo-history">${history.slice().reverse().map(row => `<li>${M.esc(new Date(row.date).toLocaleString('ru-RU'))} — <strong>${row.rating} ELO</strong> ${M.esc(row.mode || 'вручную')} ${M.esc(row.username || '')}</li>`).join('') || '<li>Пока нет записей.</li>'}</ol></details>
            <details><summary>Записать рейтинг вручную</summary><form id="eloForm" class="module-inline">${M.field('Текущий рейтинг','rating','number',manual?.rating || 0,'min="0" max="4000" step="1" required')}<button class="btn btn-secondary">Записать рейтинг</button></form></details>

        </div></details>`;
        if (addedId && d.books.some(book => book.id === addedId)) openDetails.delete('addBookEditor');
        for (const id of openDetails) { const detail = document.getElementById(id); if (detail) detail.open = true; }
        app.renderInspectorOverview?.();
        if (bound) return; bound = true;
        document.addEventListener('goaltracker:cloud-session',() => { if (chessRequest && (app.user?.id !== chessRequest.owner || app._dataEpoch !== chessRequest.epoch)) chessRequest.abort(); });
        host.addEventListener('submit',async event => {
            event.preventDefault();
            const form = event.target; if (!form.reportValidity()) return;
            const values = new FormData(form), now = new Date().toISOString(); let change, addedId = null;
            if (form.id === 'chessForm') {
                const username = String(values.get('username')).trim().toLowerCase();
                if (!/^[a-z0-9_-]{2,25}$/.test(username)) return;
                if (event.submitter?.value !== 'save') { await refreshChess(app,username); return; }
                change = data => { data.chess = data.chess?.username === username ? data.chess : {username}; return data; };
            }
            if (form.id === 'eloForm') {
                const rating = Number(values.get('rating')); if (!Number.isInteger(rating) || rating < 0 || rating > 4000) return;
                change = data => {data.eloHistory.push({id:M.uid(),rating,date:now,mode:'manual'});return data;};
            }
            if (form.id === 'bookForm') change = data => { const title = String(values.get('title')).trim(); if (!title) throw Error('Укажите название книги.'); addedId = M.uid(); data.books.push({id:addedId,title,author:values.get('author'),progress:0});return data; };
            if (form.id === 'topicForm') change = data => {const title = String(values.get('title')).trim(); if (!title) throw Error('Укажите тему.'); addedId = M.uid(); data.topics.push({id:addedId,title,notes:'',mastery:0,completed:false,steps:[]});return data;};
            if (form.dataset.topicNotes) change = data => {data.topics.find(item => item.id === form.dataset.topicNotes).notes = values.get('notes');return data;};
            if (form.dataset.topicAdd) change = data => {const topic = data.topics.find(item => item.id === form.dataset.topicAdd);topic.steps.push({id:M.uid(),title:String(values.get('title')).trim(),completed:false});return data;};
            if (change && await M.save(app,change)) render(app,addedId);
        });
        host.addEventListener('input',event => {
            const input = event.target;
            if (input.dataset.topicMastery) {
                input.closest('.knowledge-topic').querySelector('.topic-mastery-value').textContent = `${input.value}%`;
                input.setAttribute('aria-valuetext',`${input.value}%`); return;
            }
            if (!input.dataset.bookSlider) return;
            const value = Number(input.value), card = input.closest('.book-card');
            card.querySelector('progress').value = value; card.querySelector('output').textContent = `Книга прочитана на ${value}%`;input.setAttribute('aria-valuetext',`${value}%`);
        });
        host.addEventListener('change',async event => {
            const input = event.target; let change;
            if (input.dataset.bookSlider) {
                const id = input.dataset.bookSlider, progress = Number(input.value);
                if (!Number.isInteger(progress) || progress < 0 || progress > 100) return;
                change = data => {const book = data.books.find(item => item.id === id); if (!book) return data; book.progress = progress; if (Number(book.total) > 0) book.pages = Math.round(book.total*progress/100);return data;};
            }
            if (input.dataset.topicMastery) {
                const mastery = Number(input.value);
                if (!Number.isInteger(mastery) || mastery < 0 || mastery > 100) return;
                change = data => {const topic = data.topics.find(item => item.id === input.dataset.topicMastery); if (topic) topic.mastery=mastery; return data;};
            }
            if (input.dataset.topicStep) change = data => {const topic=data.topics.find(item => item.id === input.dataset.topicStep);topic.steps.find(item => item.id === input.dataset.id).completed=input.checked;return data;};
            if (change) {
                const controls = [...host.querySelectorAll('[data-book-slider],[data-topic-mastery],[data-topic-step]')];controls.forEach(control => control.disabled=true);
                const saved = await M.save(app,change);render(app);
                if (saved && input.dataset.bookSlider && Number(input.value) >= 100) {
                    const completed = host.querySelector('#completedBooks'); if (completed) completed.open = true;
                }
            }
        });
        host.addEventListener('click',async event => {
            const button = event.target.closest('[data-learn-delete]');
            if (button && confirm('Удалить запись?') && await M.save(app,data => ({...data,[button.dataset.learnDelete]:data[button.dataset.learnDelete].filter(item => item.id !== button.dataset.id)}))) render(app);
        });
    }
    window.LearningView = {render,eloProgress,bookProgress,topicProgress,summary,refreshChess,summarizeGames};
})();
