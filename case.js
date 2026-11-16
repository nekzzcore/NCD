(() => {
    'use strict';
    const M = window.WorkspaceModules;
    const drafts = new WeakMap();
    const allowed = ['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain'];
    const extensions = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',pdf:'application/pdf',txt:'text/plain'};
    let bound = false;

    const resume = item => [item.title, item.role && `Направление / Профессия: ${item.role}`, item.description, item.url && `Ссылка на проект / Результат: ${item.url}`].filter(Boolean).join('\n\n');
    const isImage = file => /^image\//.test(file.type);
    function attachmentURL(file) {
        if (!file || typeof file.url !== 'string') return '';
        const inline = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.url);
        return inline ? (allowed.includes(inline[1]) && inline[1] === file.type ? file.url : '') : M.safeURL(file.url);
    }
    function attachments(item) {
        if (Array.isArray(item?.attachments)) return item.attachments.filter(attachmentURL);
        return (item?.images || []).filter(M.imageURL).map((url,index) => ({id:`legacy-${index}`,name:`Скриншот ${index+1}`,type:/^data:([^;,]+)/.exec(url)?.[1] || extensions[url.split('?')[0].split('.').pop().toLowerCase()] || 'image/png',url}));
    }
    function attachmentMarkup(files, draft = false, caseId = '') {
        return files.map(file => `<div class="case-attachment">
            <button type="button" class="case-attachment-open" ${draft ? 'data-case-draft-open' : `data-case-open="${M.esc(caseId)}"`} data-file="${M.esc(file.id)}" aria-label="Открыть ${M.esc(file.name)}">
                ${isImage(file) ? `<img src="${M.esc(file.url)}" alt="${M.esc(file.name)}" loading="lazy">` : `<span class="case-file-symbol" aria-hidden="true">${file.type === 'application/pdf' ? 'PDF' : 'TXT'}</span>`}
                <span>${M.esc(file.name)}</span>
            </button>
            ${draft ? `<button type="button" class="btn-icon case-attachment-remove" data-case-remove="${M.esc(file.id)}" aria-label="Убрать ${M.esc(file.name)}">×</button>` : ''}
        </div>`).join('');
    }
    function paintDraft(form) {
        form.querySelector('.case-draft-files').innerHTML = attachmentMarkup(drafts.get(form) || [],true);
    }
    function openAttachment(file) {
        const url = attachmentURL(file);
        if (!url) return;
        const dialog = document.createElement('dialog');
        dialog.className = 'attachment-preview case-file-preview';
        dialog.setAttribute('aria-label',file.name);
        const close = document.createElement('button');
        close.type = 'button'; close.className = 'btn btn-secondary'; close.textContent = 'Закрыть';
        const download = document.createElement('a');
        download.className = 'btn btn-secondary'; download.textContent = 'Скачать файл'; download.download = file.name;
        const toolbar = document.createElement('div'); toolbar.className = 'module-actions'; toolbar.append(close,download);
        dialog.append(toolbar);
        let blobURL;
        const inline = /^data:([^;,]+);base64,(.*)$/.exec(url);
        let bytes;
        if (inline) {
            bytes = Uint8Array.from(atob(inline[2]),char => char.charCodeAt(0));
            blobURL = URL.createObjectURL(new Blob([bytes],{type:file.type}));
        }
        download.href = blobURL || url; download.target = '_blank'; download.rel = 'noopener noreferrer';
        if (isImage(file)) {
            const image = document.createElement('img'); image.src = url; image.alt = file.name; dialog.append(image);
        } else if (file.type === 'text/plain' && bytes) {
            const text = document.createElement('pre'); text.textContent = new TextDecoder().decode(bytes); dialog.append(text);
        } else if (file.type === 'application/pdf') {
            const frame = document.createElement('iframe'); frame.src = blobURL || url; frame.title = file.name;
            frame.setAttribute('sandbox',''); dialog.append(frame);
            const hint = document.createElement('p'); hint.textContent = 'Если просмотр PDF недоступен, скачайте файл.'; dialog.append(hint);
        }
        document.body.append(dialog);
        close.onclick = () => dialog.close();
        dialog.addEventListener('click',event => { if (event.target === dialog) dialog.close(); });
        dialog.addEventListener('close',() => { if (blobURL) URL.revokeObjectURL(blobURL); dialog.remove(); });
        dialog.showModal(); close.focus();
    }
    function render(app) {
        const host = document.getElementById('caseMain');
        if (!host) return;
        host.innerHTML = `<details class="module-editor"><summary>+ Добавить кейс</summary><form id="caseForm" class="module-form">
            <input name="id" type="hidden">
            ${M.field('Название проекта','title','text','','required maxlength="160" placeholder="Контент для запуска AI-сервиса"')}
            ${M.field('Направление / Профессия','role','text','','maxlength="160" placeholder="AI-копирайтинг, Генерация контента, Дизайн"')}
            <label class="module-field">Задача и решённая проблема<textarea name="description" required maxlength="12000"></textarea></label>
            ${M.field('Ссылка на проект / Результат','url','url','','placeholder="https://… (необязательно)"')}
            <label class="module-field">Загрузить скриншоты / файлы<input name="files" type="file" accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.txt" multiple></label>
            <small class="module-muted">До 4 файлов по 1 МБ: PNG, JPEG, WebP, GIF, PDF или TXT.</small>
            <div class="case-draft-files case-attachments" aria-live="polite"></div>
            <button class="btn btn-primary" type="submit">Сохранить кейс</button>
        </form></details>
        <div class="module-grid">${M.data(app).portfolio.map(item => {
            const files = attachments(item);
            return `<article class="module-card case-card"><h3>${M.esc(item.title)}</h3>
                ${item.role ? `<span class="case-direction">${M.esc(item.role)}</span>` : ''}
                <p class="module-copy">${M.esc(item.description)}</p>
                ${files.length ? `<div class="case-attachments">${attachmentMarkup(files,false,item.id)}</div>` : ''}
                ${M.safeURL(item.url) ? `<a class="case-result-link" href="${M.esc(M.safeURL(item.url))}" target="_blank" rel="noopener noreferrer">Ссылка на проект / Результат ↗</a>` : ''}
                <div class="module-actions"><button class="btn btn-secondary" data-case-copy="${M.esc(item.id)}">Копировать кейс для резюме</button><button class="btn-icon" data-case-edit="${M.esc(item.id)}" aria-label="Редактировать кейс">✎</button><button class="btn-icon" data-case-delete="${M.esc(item.id)}" aria-label="Удалить кейс">×</button></div>
            </article>`;
        }).join('') || '<p class="module-muted">Добавьте первый завершённый проект.</p>'}</div>`;
        drafts.set(host.querySelector('form'),[]);
        if (bound) return;
        bound = true;
        host.addEventListener('change',async event => {
            const input = event.target;
            if (input.name !== 'files') return;
            const form = input.form, button = form.querySelector('[type="submit"]');
            if (form.dataset.reading) return;
            const epoch = app._dataEpoch, owner = app.user?.id;
            form.dataset.reading = 'true'; button.disabled = true;
            try {
                const selected = [...input.files], files = [...(drafts.get(form) || [])];
                if (selected.length + files.length > 4) throw Error('Максимум 4 прикреплённых файла.');
                const added = [];
                for (const file of selected) {
                    const type = file.type || extensions[file.name.split('.').pop().toLowerCase()];
                    if (!allowed.includes(type) || file.size > 1048576) throw Error('Выберите PNG, JPEG, WebP, GIF, PDF или TXT размером до 1 МБ.');
                    const url = await new Promise((resolve,reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result).replace(/^data:[^;,]*;base64,/,`data:${type};base64,`));
                        reader.onerror = () => reject(Error('Не удалось прочитать файл. Повторите загрузку.'));
                        reader.readAsDataURL(file);
                    });
                    added.push({id:M.uid(),name:file.name,type,size:file.size,url});
                }
                if (!form.isConnected || epoch !== app._dataEpoch || owner !== app.user?.id) return;
                drafts.set(form,[...files,...added]); paintDraft(form);
            } catch (error) { if (epoch === app._dataEpoch && owner === app.user?.id) app.showToast(error.message,'error'); }
            finally { delete form.dataset.reading; button.disabled = false; input.value = ''; }
        });
        host.addEventListener('submit',async event => {
            if (event.target.id !== 'caseForm') return;
            event.preventDefault();
            const form = event.target;
            if (form.dataset.reading || form.dataset.saving || !form.reportValidity()) return;
            const values = new FormData(form), button = form.querySelector('[type="submit"]');
            form.dataset.saving = 'true'; button.disabled = true;
            try {
                const id = values.get('id') || M.uid();
                const previous = M.data(app).portfolio.find(item => item.id === id);
                const item = {...previous,id,title:String(values.get('title')).trim(),role:String(values.get('role')).trim(),description:String(values.get('description')).trim(),url:M.safeURL(values.get('url')),attachments:[...(drafts.get(form) || [])],updatedAt:new Date().toISOString()};
                delete item.images;
                if (!item.title || !item.description) throw Error('Укажите название и описание.');
                if (await M.save(app,data => {
                    const index = data.portfolio.findIndex(entry => entry.id === id);
                    if (index < 0) data.portfolio.push(item); else data.portfolio[index] = item;
                    return data;
                })) render(app);
            } catch (error) { app.showToast(error.message,'error'); }
            finally { delete form.dataset.saving; button.disabled = false; }
        });
        host.addEventListener('click',async event => {
            const button = event.target.closest('button');
            if (!button) return;
            const form = host.querySelector('form');
            if (button.hasAttribute('data-case-draft-open')) {
                const file = (drafts.get(form) || []).find(item => item.id === button.dataset.file);
                if (file) openAttachment(file);
            }
            if (button.hasAttribute('data-case-open')) {
                const item = M.data(app).portfolio.find(entry => entry.id === button.dataset.caseOpen);
                const file = attachments(item).find(entry => entry.id === button.dataset.file);
                if (file) openAttachment(file);
            }
            if (button.hasAttribute('data-case-remove') && !form.dataset.reading && !form.dataset.saving) {
                drafts.set(form,(drafts.get(form) || []).filter(file => file.id !== button.dataset.caseRemove)); paintDraft(form);
            }
            if (button.hasAttribute('data-case-copy')) {
                const item = M.data(app).portfolio.find(entry => entry.id === button.dataset.caseCopy);
                try { await navigator.clipboard.writeText(resume(item)); app.showToast('Кейс скопирован для резюме','success'); }
                catch { const area = document.createElement('textarea'); area.value = resume(item); button.after(area); area.focus(); area.select(); app.showToast('Скопируйте выделенный текст','info'); }
            }
            if (button.hasAttribute('data-case-edit') && !form.dataset.reading && !form.dataset.saving) {
                const item = M.data(app).portfolio.find(entry => entry.id === button.dataset.caseEdit);
                for (const key of ['id','title','role','description','url']) form.elements[key].value = item[key] || '';
                drafts.set(form,attachments(item)); paintDraft(form);
                host.querySelector('details').open = true; form.elements.title.focus();
            }
            if (button.hasAttribute('data-case-delete') && confirm('Удалить кейс?')) {
                if (await M.save(app,data => ({...data,portfolio:data.portfolio.filter(item => item.id !== button.dataset.caseDelete)}))) render(app);
            }
        });
    }
    window.CaseView = {render,resume};
})();
