/* Themeable fallback for browsers without customizable native selects. */
(() => {
    'use strict';
    if (window.CSS?.supports('appearance', 'base-select')) return;
    let active = null;
    let sequence = 0;
    function close() {
        if (!active) return;
        const { select, menu, expanded, controls, descendant } = active;
        for (const [name, value] of [['aria-expanded', expanded], ['aria-controls', controls], ['aria-activedescendant', descendant]]) {
            if (value === null) select.removeAttribute(name); else select.setAttribute(name, value);
        }
        menu.remove(); active = null;
    }
    function highlight(index) {
        if (!active) return;
        const { select, menu, options } = active;
        active.index = index;
        [...menu.children].forEach((row, i) => row.classList.toggle('is-active', i === index));
        const row = menu.children[index];
        if (row) {
            select.setAttribute('aria-activedescendant', row.id);
            row.scrollIntoView?.({ block: 'nearest' });
        }
        active.option = options[index];
    }
    function choose(index) {
        if (!active) return;
        const { select, options } = active;
        const option = options[index];
        if (!option || option.disabled || option.parentElement?.disabled || select.disabled) return;
        const changed = select.selectedIndex !== option.index;
        select.selectedIndex = option.index;
        close(); select.focus();
        if (changed) {
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
    function open(select) {
        close();
        const options = [...select.options].filter(option => !option.hidden && !option.parentElement?.hidden);
        if (!options.length) return;
        const menu = document.createElement('div');
        menu.className = 'cyber-select-menu'; menu.id = `cyber-select-${++sequence}`;
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', select.labels?.[0]?.textContent.trim() || select.getAttribute('aria-label') || 'Выбор значения');
        active = { select, menu, options, index: -1, expanded: select.getAttribute('aria-expanded'), controls: select.getAttribute('aria-controls'), descendant: select.getAttribute('aria-activedescendant') };
        options.forEach((option, index) => {
            const row = document.createElement('div');
            row.className = 'cyber-select-option'; row.id = `${menu.id}-${index}`;
            row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.selected));
            const disabled = option.disabled || option.parentElement?.disabled;
            row.setAttribute('aria-disabled', String(Boolean(disabled)));
            row.textContent = option.textContent;
            row.addEventListener('pointermove', () => { if (!disabled) highlight(index); });
            row.addEventListener('mousedown', event => event.preventDefault());
            row.addEventListener('click', () => choose(index));
            menu.append(row);
        });
        document.body.append(menu);
        select.setAttribute('aria-expanded', 'true'); select.setAttribute('aria-controls', menu.id);
        const rect = select.getBoundingClientRect();
        const below = window.innerHeight - rect.bottom - 8;
        const above = rect.top - 8;
        const upward = below < 180 && above > below;
        menu.style.maxHeight = `${Math.max(40, Math.min(280, upward ? above : below))}px`;
        menu.style.width = `${Math.min(Math.max(rect.width, 160), window.innerWidth - 16)}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.getBoundingClientRect().width - 8))}px`;
        if (upward) menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        else menu.style.top = `${rect.bottom + 4}px`;
        select.focus();
        highlight(options.findIndex(option => option.selected));
    }
    const eligible = target => target instanceof HTMLSelectElement && !target.multiple && target.size <= 1 && !target.disabled;
    document.addEventListener('mousedown', event => {
        if (eligible(event.target) && event.button === 0) event.preventDefault();
        else if (active && !active.menu.contains(event.target)) close();
    }, true);
    document.addEventListener('click', event => {
        if (!eligible(event.target)) return;
        event.preventDefault();
        if (active?.select === event.target) close(); else open(event.target);
    }, true);
    let search = '', searchTime = 0;
    document.addEventListener('keydown', event => {
        const select = event.target;
        if (!eligible(select) || event.ctrlKey || event.metaKey) return;
        if (event.key === 'Tab' || event.key === 'Escape') { close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key) && event.key.length !== 1) return;
        event.preventDefault();
        if (!active || active.select !== select) { open(select); if (event.key === 'Enter' || event.key === ' ') return; }
        if (!active) return;
        if (event.key === 'Enter' || event.key === ' ') { choose(active.index); return; }
        const enabled = active.options.map((option, index) => !option.disabled && !option.parentElement?.disabled ? index : -1).filter(index => index >= 0);
        let next;
        if (event.key === 'Home') next = enabled[0];
        else if (event.key === 'End') next = enabled.at(-1);
        else if (event.key.startsWith('Arrow')) {
            const position = enabled.indexOf(active.index);
            next = enabled[Math.max(0, Math.min(enabled.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)))];
        } else {
            const now = Date.now(); search = now - searchTime < 700 ? search + event.key : event.key; searchTime = now;
            next = enabled.find(index => active.options[index].textContent.trim().toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
        }
        if (next !== undefined) highlight(next);
    }, true);
    document.addEventListener('focusin', event => { if (active && event.target !== active.select && !active.menu.contains(event.target)) close(); });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', event => { if (active && !active.menu.contains(event.target)) close(); }, true);
    // Close stale menus after a modal, options or disabled state changes.
    new MutationObserver(() => {
        if (active && (!active.select.isConnected || active.select.disabled || !active.select.getClientRects().length || active.options.some(option => !active.select.contains(option)))) close();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'class', 'hidden'] });
})();
