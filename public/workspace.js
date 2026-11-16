(() => {
 'use strict';
 const empty = () => ({portfolio:[],eloHistory:[],books:[],topics:[]});
 const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const safeURL = value => { try { const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:''; } catch { return ''; } };
 const imageURL = value => /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : safeURL(value);
 function data(app){return app.workspace ||= empty();}
 async function save(app, change){
  if(app._moduleSaving || app._accountTransition || app._resetting)return false;
  const before=data(app),epoch=app._dataEpoch;app._moduleSaving=true;
  try {app.workspace=change(structuredClone(before));if(await app.saveData()!==true)throw Error('Не удалось сохранить изменения.');return true;}
  catch(error){if(epoch===app._dataEpoch)app.workspace=before;app.showToast(error.message,'error');return false;}
  finally{app._moduleSaving=false;}
 }
 const uid=()=>crypto.randomUUID();
 const field=(label,name,type='text',value='',extra='')=>`<label class="module-field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
 window.WorkspaceModules={empty,esc,safeURL,imageURL,data,save,uid,field};
})();
