const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
function setup(t){
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window;w.eval(fs.readFileSync('achievements.js','utf8'));
 w.eval(fs.readFileSync('app.js','utf8').split('// ===== Initialize =====')[0]+'\nwindow.GoalTracker=GoalTracker;');
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 return {w,d:w.document,app:Object.create(w.GoalTracker.prototype)};
}
test('Keyword/category matching uses local outline SVG and an eight point default',t=>{
 const {w}=setup(t);
 for(const [goal,name] of [[{category:'FINANCE'},'wallet'],[{title:'Накопить резерв'},'wallet'],[{title:'Тренировка в зале'},'activity'],[{category:'HEALTH'},'activity'],[{title:'Учёба и книга'},'book'],[{category:'LEARNING'},'book'],[{title:'Новый проект'},'briefcase'],[{category:'WORK'},'briefcase'],[{},'star']]){
  const svg=w.getAchievementIcon(goal);assert.match(svg,new RegExp('data-achievement-icon="'+name+'"'));assert.match(svg,/stroke-width="1.5"/);assert.match(svg,/fill="none"/);
 }
 assert.equal(w.AchievementIcons.tier({priority:'low'}),1);assert.equal(w.AchievementIcons.tier({priority:'high'}),2);assert.equal(w.AchievementIcons.tier({priority:'milestone'}),3);
});
test('Gallery opens an inspector with safe goal text, date and recorded path',t=>{
 const {app,d}=setup(t);app.goals=[{id:'goal',title:'Проект <script>bad()</script>',category:'work',priority:'milestone',status:'completed',completedAt:'2026-10-26',subgoals:[{title:'Первый кейс',completed:true,completedAt:'2026-10-25'}]}];app.achievements=[];
 app.renderAchievements();assert.ok(d.querySelector('.achievement-tier-3 svg'));
 d.querySelector('[data-inspect-achievement]').click();assert.equal(d.getElementById('achievementInspector').open,true);
 assert.equal(d.getElementById('achievementInspectorTitle').textContent,app.goals[0].title);
 assert.match(d.getElementById('achievementInspectorBody').textContent,/Первый кейс/);assert.match(d.getElementById('achievementInspectorBody').textContent,/26.10.2026/);
 assert.equal(d.querySelector('#achievementInspector script'),null);
 d.getElementById('closeAchievementInspector').click();assert.equal(d.getElementById('achievementInspector').open,false);
});
