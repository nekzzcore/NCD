/* Local outline artwork: no font, CDN, or runtime dependency. */
(() => {
    'use strict';
    const paths = {
        wallet:'<path d="M20 8V5H6a3 3 0 0 0 0 6h15v9H5a3 3 0 0 1-3-3V8"/><path d="M21 11h-5v5h5M17 13.5h.01"/>',
        activity:'<path d="M2 12h5l3-9 4 18 3-9h5"/>',
        book:'<path d="M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z"/>',
        briefcase:'<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12c6 4 12 4 18 0M10 13h4"/>',
        star:'<path d="m12 1 2.1 7.9L20 4l-4.9 5.9L23 12l-7.9 2.1L20 20l-5.9-4.9L12 23l-2.1-7.9L4 20l4.9-5.9L1 12l7.9-2.1L4 4l5.9 4.9Z"/>'
    };
    function getAchievementIcon(goal = {}) {
        const title = String(goal.title || '').toLocaleLowerCase('ru');
        const category = String(goal.category || '').toLowerCase();
        let name = /заработ|копи|накоп|сбереж|бюджет/.test(title) ? 'wallet'
            : /(?:^|\s)зал(?:\s|$)|трениров|спорт|здоров/.test(title) ? 'activity'
            : /уч[её]б|книг|обуч|прочит/.test(title) ? 'book'
            : /кейс|проект/.test(title) ? 'briefcase'
            : ({ finance:'wallet', health:'activity', learning:'book', education:'book', work:'briefcase', career:'briefcase' }[category] || 'star');
        return `<svg data-achievement-icon="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
    }
    function getAchievementTier(goal = {}) {
        if (['milestone','critical'].includes(goal.priority) || goal.difficulty === 'hard') return 3;
        if (goal.priority === 'high' || goal.difficulty === 'medium') return 2;
        return 1;
    }
    window.getAchievementIcon = getAchievementIcon;
    window.AchievementIcons = { render:getAchievementIcon, tier:getAchievementTier };
})();
