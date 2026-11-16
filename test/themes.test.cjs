const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.join(__dirname,'..');
function fixture(t){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://themes.invalid/',runScripts:'outside-only'});
 t.after(()=>dom.window.close());const w=dom.window;
 w.matchMedia=()=>({matches:false});
 w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8').split('// ===== Initialize =====')[0]+'\nwindow.GoalTracker=GoalTracker;');
 const app=Object.create(w.GoalTracker.prototype);
 Object.assign(app,{settings:{theme:'dark'},saveData(){this.saved=(this.saved||0)+1;}});
 app.bindEvents();return {w,d:w.document,app};
}
test('Desktop and mobile theme buttons update body class, effective theme, accessibility and saved preference in both directions',t=>{
 const {w,d,app}=fixture(t);app.setTheme('dark');
 for(const id of ['themeBtn','mobileThemeBtn']){
  d.getElementById(id).click();
  assert.equal(d.body.classList.contains('light-theme'),true);
  assert.equal(d.documentElement.dataset.theme,'light');assert.equal(d.documentElement.style.colorScheme,'light');assert.equal(app.settings.theme,'light');
  assert.equal(w.localStorage.getItem('theme'),'light');
  for(const control of ['themeBtn','mobileThemeBtn'])assert.equal(d.getElementById(control).getAttribute('aria-pressed'),'true');
  d.getElementById(id).click();
  assert.equal(d.body.classList.contains('light-theme'),false);assert.equal(d.documentElement.style.colorScheme,'dark');
  assert.equal(d.documentElement.dataset.theme,'dark');assert.equal(w.localStorage.getItem('theme'),'dark');
 }
});
test('Startup restores a saved light theme even when profile defaults to dark',t=>{
 const {w,d,app}=fixture(t);w.localStorage.setItem('theme','light');app.initTheme();
 assert.equal(d.body.classList.contains('light-theme'),true);assert.equal(app.settings.theme,'light');
});
test('Auto theme follows system preference while keeping auto as the saved setting',t=>{
 const {w,d,app}=fixture(t);app.setTheme('auto');
 assert.equal(d.body.classList.contains('light-theme'),true);assert.equal(w.localStorage.getItem('theme'),'auto');
 w.matchMedia=()=>({matches:true});app.setTheme('auto');
 assert.equal(d.body.classList.contains('light-theme'),false);assert.equal(d.documentElement.style.colorScheme,'dark');assert.equal(d.documentElement.dataset.theme,'dark');
 assert.equal(w.localStorage.getItem('theme'),'auto');
});
