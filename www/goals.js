/* The milestone toggle uses the existing persisted priority and routing rules. */
(() => {
 window.GoalMilestone={bind(checked,subgoal){
  const toggle=document.getElementById('goalMilestone'),priority=document.getElementById('goalPriority');
  toggle.checked=checked;toggle.parentElement.hidden=subgoal;
  toggle.onchange=()=>{priority.value=toggle.checked?'milestone':'medium';priority.dispatchEvent(new Event('change',{bubbles:true}));};
  if (!priority.dataset.milestoneBound) {
   priority.addEventListener('change',()=>{toggle.checked=priority.value==='milestone';});
   priority.dataset.milestoneBound='true';
  }
 }};
})();

// Manual refresh performs the full account merge: fetch cloud state, preserve
// local-only goals, write the merged state, then render the confirmed result.
document.addEventListener('DOMContentLoaded', () => {
 const filter = document.getElementById('filterStatus');
 if (!filter || document.getElementById('syncGoalsBtn')) return;
 const button = document.createElement('button');
 button.id = 'syncGoalsBtn'; button.type = 'button'; button.className = 'btn btn-secondary';
 button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17"/></svg>'; button.title = 'Обновить / Синхронизировать';
 button.setAttribute('aria-label', 'Синхронизировать цели');
 button.style.cssText = 'width:36px;height:36px;min-width:36px;padding:0;border-radius:50%;flex-shrink:0';
 filter.insertAdjacentElement('afterend', button);
 button.addEventListener('click', async () => {
  if (window.CloudSync?.isSyncing?.()) return;
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
   let ok = false;
   try { ok = await window.CloudSync?.sync?.(); } catch { ok = false; }
   window.app?.showToast(ok ? 'Синхронизировано' : 'Не удалось синхронизировать цели. Проверьте подключение и вход в аккаунт.', ok ? 'success' : 'warning');
  } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
 });
});
