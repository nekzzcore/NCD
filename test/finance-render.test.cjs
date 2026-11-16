const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
test('Finance has three tabs, editable quick income and a future CSV import entry',t=>{
 const dom=new JSDOM('<main id="financeMain"></main>',{url:'https://finance.invalid',runScripts:'outside-only'});
 t.after(()=>dom.window.close());const w=dom.window,d=w.document;
 w.matchMedia=()=>({matches:false});
 w.eval(fs.readFileSync(require.resolve('../finance.js'),'utf8'));w.renderFinanceView();
 assert.deepEqual([...d.querySelectorAll('[data-finance-step]')].map(e=>e.dataset.financeStep),['accounting','budget','safety']);
 for(const amount of ['3000','10000','1000']){
  d.querySelector(`[data-income-quick="${amount}"]`).click();
  const f=d.querySelector('[data-finance-form="transaction"]');
  assert.equal(f.elements.namedItem('amount').value,amount);
  assert.equal(f.elements.namedItem('type').value,'income');
 }
 const f=d.querySelector('[data-finance-form="transaction"]');
 f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 assert.equal(w.finance.getData().transactions.at(-1).amount,1000);
 assert.equal(w.finance.getData().transactions.at(-1).type,'income');
 d.querySelector('[data-finance-import]').click();assert.equal(d.querySelector('[data-import-status]').hidden,false);
 for(const tab of ['budget','safety']){d.querySelector(`[data-finance-step="${tab}"]`).click();assert.ok(d.querySelector('.finance-panel').textContent.trim());}
});
test('Custodian inspector shows savings instead of monthly income and expenses',t=>{
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://savings.invalid',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window;w.matchMedia=()=>({matches:true});
 w.eval(fs.readFileSync('finance.js','utf8'));
 w.finance.replaceData({transactions:[{id:'e',type:'expense',amount:100,date:'2026-10-01'}],safetyFund:{balance:1500,targetMonths:6,confirmationVersion:1,history:[{id:'d',type:'deposit',amount:1500,date:'2026-10-01'}]}});
 w.eval(fs.readFileSync('app.js','utf8').split('// ===== Initialize =====')[0]+'\nwindow.GoalTracker=GoalTracker;');
 const app=Object.create(w.GoalTracker.prototype);Object.assign(app,{currentView:'finance',goals:[],achievements:[]});app.renderInspectorOverview();
 const host=w.document.getElementById('inspectorOverview');
 assert.ok(host.querySelector('.savings-balance'));assert.match(host.textContent,/Моя подушка/);assert.equal(host.querySelector('.savings-minimal').children.length,2);
 assert.doesNotMatch(host.textContent,/Поступления|Расходы|операций за месяц/);
 const character=host.querySelector('.custodian-character');app.renderInspectorOverview();assert.equal(host.querySelector('.custodian-character'),character);
 assert.equal(w.finance.getSafetySummary().balance,1500);assert.equal(w.finance.getSafetySummary().target,600);assert.equal(w.finance.getSafetySummary().percent,100);
});

test('Background finance refresh preserves inputs and DOM when data is unchanged; safety has no month target',t=>{
 const dom=new JSDOM('<main id="financeMain"></main>',{url:'https://stable.invalid',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document;w.matchMedia=()=>({matches:false});w.eval(fs.readFileSync('finance.js','utf8'));w.renderFinanceView();
 const form=d.querySelector('[data-finance-form="transaction"]');form.elements.amount.value='321';
 w.renderFinanceView();assert.equal(d.querySelector('[data-finance-form="transaction"]'),form);assert.equal(form.elements.amount.value,'321');
 w.finance.replaceData(w.finance.getData());assert.equal(d.querySelector('[data-finance-form="transaction"]'),form);
 d.querySelector('[data-finance-step="safety"]').click();assert.equal(d.querySelector('[name="targetMonths"]'),null);assert.doesNotMatch(d.querySelector('.finance-panel').textContent,/Цель в месяцах|мес\./);
});
test('After a deposit, the next draft and focus survive changed cloud data and metadata refresh',t=>{
 const dom=new JSDOM('<main id="financeMain"></main>',{url:'https://draft.invalid',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document;w.matchMedia=()=>({matches:true});w.app={currentView:'finance'};w.eval(fs.readFileSync('finance.js','utf8'));w.renderFinanceView();d.querySelector('[data-finance-step="safety"]').click();
 d.querySelector('[data-piggy-quick="500"]').click();let form=d.getElementById('piggyDepositForm');form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(w.finance.getData().safetyFund.balance,500);
 d.querySelector('[data-piggy-quick="1000"]').click();form=d.getElementById('piggyDepositForm');form.elements.amount.value='750';form.elements.amount.dispatchEvent(new w.Event('input',{bubbles:true}));form.elements.amount.focus();
 const metadata=w.finance.getData();metadata.safetyFund.lastSeenBalance=400;w.finance.replaceData(metadata);assert.equal(d.getElementById('piggyDepositForm'),form);assert.equal(form.elements.amount.value,'750');
 const remote=w.finance.getData();remote.safetyFund.balance=600;remote.safetyFund.history.push({id:'remote',type:'correction',amount:100,balance:600,date:'2026-10-29'});w.finance.replaceData(remote);
 form=d.getElementById('piggyDepositForm');assert.equal(form.elements.amount.value,'750');assert.equal(d.activeElement,form.elements.amount);assert.equal(form.classList.contains('is-collapsed'),false);assert.equal(form.querySelector('[type=submit]').disabled,false);
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(w.finance.getData().safetyFund.balance,1350);
});
