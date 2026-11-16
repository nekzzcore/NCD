const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {JSDOM}=require('jsdom');
function fixture(t){const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://ncd.invalid',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;w.structuredClone=structuredClone;for(const file of ['workspace.js','case.js','learning.js','goals.js'])w.eval(fs.readFileSync(file,'utf8'));const app={workspace:w.WorkspaceModules.empty(),_dataEpoch:1,user:{id:'user'},saveData:async()=>true,showToast(){}};return {w,d:w.document,app};}
async function submit(w,form){form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));for(let i=0;i<8;i++)await Promise.resolve();}
test('Case form uses profession, optional result link and no stack or URL attachment fields',async t=>{
 const {w,d,app}=fixture(t);w.CaseView.render(app);let form=d.getElementById('caseForm');
 assert.equal(form.elements.stack,undefined);assert.equal(form.elements.images,undefined);assert.equal(form.elements.url.required,false);
 for(const [key,value]of Object.entries({title:'AI <img src=x>',role:'AI-копирайтинг',description:'Решение проблемы'}))form.elements[key].value=value;
 await submit(w,form);assert.equal(app.workspace.portfolio.length,1);assert.equal(d.querySelector('.case-card h3').textContent,'AI <img src=x>');
 assert.equal(d.querySelector('.case-direction').textContent,'AI-копирайтинг');assert.equal(d.querySelector('.case-result-link'),null);
 assert.match(w.CaseView.resume(app.workspace.portfolio[0]),/Направление \/ Профессия: AI-копирайтинг/);
 d.querySelector('[data-case-edit]').click();form=d.getElementById('caseForm');form.elements.title.value='Updated';form.elements.url.value='https://example.com/result';await submit(w,form);
 assert.equal(app.workspace.portfolio.length,1);assert.equal(app.workspace.portfolio[0].title,'Updated');assert.equal(d.querySelector('.case-result-link').textContent,'Ссылка на проект / Результат ↗');
 assert.equal(w.WorkspaceModules.safeURL('javascript:alert(1)'), '');
});
async function chooseFiles(w,form,files){
 const input=form.elements.files;Object.defineProperty(input,'files',{value:files,configurable:true});input.dispatchEvent(new w.Event('change',{bubbles:true}));
 for(let i=0;i<100&&form.dataset.reading;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(form.dataset.reading,undefined);
}
test('Uploaded image and text persist as base64, open previews and survive editing',async t=>{
 const {w,d,app}=fixture(t);w.TextDecoder=TextDecoder;const revoked=[];w.URL.createObjectURL=()=> 'blob:https://ncd.invalid/preview';w.URL.revokeObjectURL=url=>revoked.push(url);
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 w.CaseView.render(app);let form=d.getElementById('caseForm');
 await chooseFiles(w,form,[new w.File(['image bytes'],'preview.png',{type:'image/png'}),new w.File(['<script>safe text</script>'],'result.txt',{type:'text/plain'})]);
 assert.equal(d.querySelectorAll('.case-draft-files .case-attachment').length,2);assert.equal(form.querySelector('[type="submit"]').disabled,false);
 form.elements.title.value='AI project';form.elements.description.value='Completed';await submit(w,form);
 assert.equal(app.workspace.portfolio[0].attachments.length,2);assert.match(app.workspace.portfolio[0].attachments[0].url,/^data:image\/png;base64,/);
 assert.equal(d.querySelectorAll('.case-card .case-attachments img').length,1);
 d.querySelector('[data-case-open]').click();assert.equal(d.querySelector('dialog.case-file-preview img').alt,'preview.png');d.querySelector('.case-file-preview button').click();assert.equal(d.querySelector('.case-file-preview'),null);
 d.querySelectorAll('[data-case-open]')[1].click();assert.equal(d.querySelector('.case-file-preview pre').textContent,'<script>safe text</script>');assert.equal(d.querySelector('.case-file-preview script'),null);d.querySelector('.case-file-preview button').click();assert.equal(revoked.length,2);
 d.querySelector('[data-case-edit]').click();form=d.getElementById('caseForm');assert.equal(d.querySelectorAll('[data-case-remove]').length,2);d.querySelector('[data-case-remove]').click();await submit(w,form);assert.equal(app.workspace.portfolio[0].attachments.length,1);assert.equal(app.workspace.portfolio[0].attachments[0].name,'result.txt');
});
test('Editing legacy screenshots preserves attachments and hides the old technology field',async t=>{
 const {w,d,app}=fixture(t);app.workspace.portfolio=[{id:'old',title:'Old project',role:'Дизайн',stack:'Old stack',description:'Result',images:['data:image/jpeg;base64,eA==','https://example.com/old.png']}];
 w.CaseView.render(app);assert.equal(d.querySelector('.case-card').textContent.includes('Old stack'),false);d.querySelector('[data-case-edit]').click();await submit(w,d.getElementById('caseForm'));
 assert.equal(app.workspace.portfolio[0].attachments.length,2);assert.equal(app.workspace.portfolio[0].attachments[0].type,'image/jpeg');assert.equal(app.workspace.portfolio[0].images,undefined);assert.equal(d.querySelectorAll('.case-card img').length,2);assert.doesNotMatch(w.CaseView.resume(app.workspace.portfolio[0]),/Old stack/);
});
test('Unsupported uploads leave the draft unchanged and release the save button',async t=>{
 const {w,d,app}=fixture(t);const errors=[];app.showToast=message=>errors.push(message);w.CaseView.render(app);const form=d.getElementById('caseForm');await chooseFiles(w,form,[new w.File(['<svg/>'],'image.svg',{type:'image/svg+xml'})]);assert.equal(d.querySelectorAll('.case-draft-files .case-attachment').length,0);assert.equal(form.querySelector('[type="submit"]').disabled,false);assert.equal(errors.length,1);
});
test('ELO history, books and knowledge checklist save and rerender',async t=>{const {w,d,app}=fixture(t);w.LearningView.render(app);let form=d.getElementById('eloForm');form.elements.rating.value='1200';await submit(w,form);assert.equal(app.workspace.eloHistory[0].rating,1200);assert.equal(w.LearningView.eloProgress(1200).next,1300);assert.equal(w.LearningView.eloProgress(2100).percent,100);form=d.getElementById('bookForm');form.elements.title.value='Книга';assert.equal(form.elements.total,undefined);await submit(w,form);const slider=d.querySelector('[data-book-slider]');slider.value='100';slider.dispatchEvent(new w.Event('change',{bubbles:true}));for(let i=0;i<8;i++)await Promise.resolve();assert.equal(app.workspace.books[0].progress,100);form=d.getElementById('topicForm');form.elements.title.value='Английский';await submit(w,form);form=d.querySelector('[data-topic-add]');form.elements.title.value='Времена';await submit(w,form);const checkbox=d.querySelector('[data-topic-step]');checkbox.checked=true;checkbox.dispatchEvent(new w.Event('change',{bubbles:true}));for(let i=0;i<8;i++)await Promise.resolve();assert.equal(app.workspace.topics[0].mastery,0);assert.equal(w.LearningView.topicProgress(app.workspace.topics[0]),0);assert.equal(d.querySelector('.knowledge-topic.is-studied'),null);});
test('Failed saves restore workspace and milestone toggle updates the persisted priority',async t=>{const {w,d,app}=fixture(t);app.saveData=async()=>false;assert.equal(await w.WorkspaceModules.save(app,state=>({...state,books:[{id:'fail'}]})),false);assert.equal(app.workspace.books.length,0);w.GoalMilestone.bind(false,false);const toggle=d.getElementById('goalMilestone');toggle.checked=true;toggle.dispatchEvent(new w.Event('change'));assert.equal(d.getElementById('goalPriority').value,'milestone');toggle.checked=false;toggle.dispatchEvent(new w.Event('change'));assert.equal(d.getElementById('goalPriority').value,'medium');});


test('Chess.com refresh imports Rapid/Blitz, recent results and deduplicates rating history',async t=>{
 const {w,d,app}=fixture(t);w.LearningView.render(app);let rapid=1400;const calls=[];
 w.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('/stats')?{chess_rapid:{last:{rating:rapid,date:100}},chess_blitz:{last:{rating:1200,date:101}}}:url.endsWith('/archives')?{archives:['https://api.chess.com/pub/player/player_one/games/2026/10']}:{games:[{url:'game1',time_class:'rapid',rules:'chess',end_time:3,white:{username:'PLAYER_ONE',result:'win'},black:{username:'peer',result:'resigned'}},{url:'game2',time_class:'blitz',end_time:2,black:{username:'player_one',result:'stalemate'}},{url:'game3',time_class:'rapid',end_time:1,white:{username:'player_one',result:'checkmated'}}]}};};
 assert.equal(await w.LearningView.refreshChess(app,'player_one'),true);
 assert.equal(app.workspace.chess.username,'player_one');assert.equal(app.workspace.chess.stats.rapid.rating,1400);assert.equal(app.workspace.chess.stats.blitz.rating,1200);
 assert.deepEqual(JSON.parse(JSON.stringify(app.workspace.chess.recent)),{win:1,loss:1,draw:1,total:3});assert.equal(app.workspace.eloHistory.length,2);assert.equal(d.querySelectorAll('.chess-chart svg').length,2);
 assert.equal(await w.LearningView.refreshChess(app,'player_one'),true);assert.equal(app.workspace.eloHistory.length,2);
 rapid=1410;await w.LearningView.refreshChess(app,'player_one');assert.equal(app.workspace.eloHistory.length,3);assert.equal(app.workspace.eloHistory.at(-1).rating,1410);
 assert.equal(calls[0],'https://api.chess.com/pub/player/player_one/stats');
});
test('Saving Chess.com username works without API access and failed refresh keeps saved data',async t=>{
 const {w,d,app}=fixture(t);w.LearningView.render(app);const form=d.getElementById('chessForm');form.elements.username.value='Player_One';
 const save=form.querySelector('[value="save"]');form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:save}));for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(app.workspace.chess.username,'player_one');w.fetch=async()=>({ok:false,status:404});
 assert.equal(await w.LearningView.refreshChess(app,'player_one'),false);assert.equal(app.workspace.chess.username,'player_one');assert.match(d.getElementById('chessStatus').textContent,/не найден/);assert.equal(d.querySelector('#chessForm button').disabled,false);
});
test('Late Chess.com responses cannot save statistics to a different NCD account',async t=>{
 const {w,d,app}=fixture(t);w.LearningView.render(app);let release;w.fetch=()=>new Promise(resolve=>release=resolve);
 const pending=w.LearningView.refreshChess(app,'oldplayer');app._dataEpoch++;app.user={id:'other-user'};d.dispatchEvent(new w.Event('goaltracker:cloud-session'));
 release({ok:true,json:async()=>({chess_rapid:{last:{rating:1500}}})});assert.equal(await pending,false);assert.equal(app.workspace.eloHistory.length,0);assert.equal(app.workspace.chess,undefined);
});
test('Legacy page counts become percent sliders, with immediate feedback and persistent progress',async t=>{
 const {w,d,app}=fixture(t);app.workspace.books=[{id:'old-book',title:'Legacy',pages:90,total:200}];w.LearningView.render(app);
 const slider=d.querySelector('[data-book-slider]');assert.equal(slider.value,'45');slider.value='60';slider.dispatchEvent(new w.Event('input',{bubbles:true}));assert.match(d.querySelector('.book-progress-text').textContent,/60%/);assert.equal(app.workspace.books[0].pages,90);
 slider.dispatchEvent(new w.Event('change',{bubbles:true}));for(let i=0;i<8;i++)await Promise.resolve();assert.equal(app.workspace.books[0].progress,60);assert.equal(app.workspace.books[0].pages,120);
});
