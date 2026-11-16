const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {randomUUID}=require('node:crypto');const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),src=fs.readFileSync(path.join(root,'app.js'),'utf8').split('// ===== Initialize =====')[0],sync=fs.readFileSync(path.join(root,'sync.js'),'utf8');
const stalePlayerTag=()=> '#'+randomUUID().replace(/-/g,'').slice(0,8).toUpperCase();
const copy=v=>JSON.parse(JSON.stringify(v));
const aliases={parentId:'parent_id',createdAt:'created_at',updatedAt:'updated_at',targetAmount:'target_amount',currentAmount:'current_amount',isCompleted:'is_completed'};
const toGoalRow=(goal,uid)=>({...Object.fromEntries(Object.entries(goal).map(([key,value])=>[aliases[key]||key,copy(value)])),user_id:uid});
const fromGoalRow=({user_id,...row})=>Object.fromEntries(Object.entries(row).map(([key,value])=>[Object.keys(aliases).find(local=>aliases[local]===key)||key,copy(value)]));
function fixture(t,cloud={}){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(String(e)));vc.on('error',(...a)=>errors.push(a.join(' ')));
 const dom=new JSDOM(html,{url:'https://cloud-test.invalid/',runScripts:'outside-only',virtualConsole:vc,pretendToBeVisual:true});const w=dom.window,d=w.document;t.after(()=>{assert.deepEqual(errors,[]);w.close();});w.crypto.randomUUID=randomUUID;
 if(cloud.desktopStore)w.electronAPI={readAuthSession:async key=>cloud.desktopStore.get(key)??null,writeAuthSession:async(key,value)=>{if(value===null)cloud.desktopStore.delete(key);else cloud.desktopStore.set(key,value);}};
 w.eval(src+'\nwindow.GoalTracker=GoalTracker;');w.eval(fs.readFileSync(path.join(root,'finance.js'),'utf8'));if(cloud.nativeStore){w.Capacitor={isNativePlatform:()=>true,Plugins:{Preferences:{get:async({key})=>({value:cloud.nativeStore.get(key)??null}),set:async({key,value})=>{cloud.nativeStore.set(key,value);},remove:async({key})=>{cloud.nativeStore.delete(key);},keys:async()=>({keys:[...cloud.nativeStore.keys()]})}}};}if(cloud.bridgeOnly){w.NCDNativeStorage={preferences:w.Capacitor.Plugins.Preferences,isNative:()=>true};delete w.Capacitor.Plugins;}w.eval(sync);
 const app=w.app=Object.create(w.GoalTracker.prototype);let snapshot;
 Object.assign(app,{user:{id:'local-device',nickname:'Local',createdAt:'2026-01-01'},goals:[],achievements:[],events:[],notes:{},habits:[],gamification:{badges:[]},gamificationEngine:null,settings:{autoSync:false,notifications:false,theme:'dark'},currentMonth:new Date(),currentView:'profile',showToast(){}});
 snapshot=copy(app.serialize());w.ProfileStorage={save:async data=>{if(cloud.saveGate)await cloud.saveGate;if(cloud.failDisk)throw new Error('Disk failure');snapshot=copy(data);w.localStorage.setItem('goalTracker_data',JSON.stringify(data));},get:()=>copy(snapshot),flush:async()=>{}};
 let current=cloud.initialSession||null;cloud.records??={};cloud.calls??=[];let nextUser='11111111-1111-4111-8111-111111111111';
 w.supabase={createClient(url,key,options){
  cloud.clientCreations=(cloud.clientCreations||0)+1;cloud.options=options;cloud.clientURL=url;cloud.listeners??=new Set();
  const record=uid=>cloud.records[uid]??={revision:0,state:copy(w.CloudSyncCore.empty()),present:[]};
  const row=(table,uid)=>{
   const r=record(uid),s=r.state,present=r.present?.includes(table)||r.revision>0;
   if(table==='calendar_events'){if(!r.calendarDocument)return null;const data=copy(r.calendarDocument);if(r.versions?.calendar_events)data.__goaltrackerVersion=r.versions.calendar_events;return {user_id:uid,data};}
   if(table==='profiles')return present||s.profile?.nickname||Object.keys(s.financeOther||{}).length||Object.keys(s.calendar||{}).length?{id:uid,username:s.profile?.nickname||'',handle:r.handle,short_id:r.shortId,...(!cloud.noWorkspaceStorage?{extra:cloud.extraText?'text':r.profileExtra||{}}:{}),...(cloud.workspaceColumns?{portfolio:[],learning_chess:[],learning_books:[],learning_topics:[],...(r.workspaceColumns||{})}:{})}:null;
   const field={goals:'goals',finance_transactions:'transactions',calendar_events:'calendar',safety_fund:'safetyFund',user_profile:'profile'}[table];
   let data=copy(field==='profile'?{...s.profile,__goaltrackerSync:r.profileSync||{financeOther:s.financeOther,calendar:s.calendar}}:s[field]);
   if(r.versions?.[table]){if(Array.isArray(data)&&data.length)data[0].__goaltrackerVersion=r.versions[table];else if(data&&!Array.isArray(data))data.__goaltrackerVersion=r.versions[table];}
   return field&&(present||JSON.stringify(s[field])!==JSON.stringify(w.CloudSyncCore.empty()[field]))?{user_id:uid,data:copy(data)}:null;
  };
  const failure=(table,operation)=>cloud.offline?{code:'FETCH_ERROR'}:cloud.tableError&&(!cloud.failOperation||cloud.failOperation===`${table}.${operation}`)?{code:cloud.tableError,message:'Sensitive backend details'}:null;
  const emit=(table,uid)=>{for(const listener of cloud.listeners)if(listener.table===table&&listener.user===uid)listener.callback({eventType:'UPDATE'});};
  cloud.emit=emit;
  const apply=(table,value,uid)=>{
   const r=record(uid),s=r.state;
   if(value.data){const raw=value.data;const version=Array.isArray(raw)?raw[0]?.__goaltrackerVersion:raw.__goaltrackerVersion;r.versions??={};r.versions[table]=version;value={...value,data:Array.isArray(raw)?raw.map(item=>{const {__goaltrackerVersion,...fields}=item;return fields;}):Object.fromEntries(Object.entries(raw).filter(([key])=>key!=='__goaltrackerVersion'))};}
   r.present??=[];if(!r.present.includes(table))r.present.push(table);
   if(table==='profiles'){
    if(value.handle!==undefined)r.handle=value.handle;
    r.shortId??=cloud.generatedTag||'#AB12CD34';
    if(value.nickname!==undefined||value.username!==undefined)s.profile.nickname=value.nickname??value.username;
    if(value.extra){r.profileExtra=copy(value.extra);if(value.extra.financeOther)s.financeOther=copy(value.extra.financeOther);if(value.extra.calendar)s.calendar=copy(value.extra.calendar);if(value.extra.profile)r.extraProfile=copy(value.extra.profile);}
    for(const key of ['portfolio','learning_chess','learning_books','learning_topics'])if(value[key]!==undefined){r.workspaceColumns??={};r.workspaceColumns[key]=copy(value[key]);}
   }else if(table==='user_profile'){
    const {__goaltrackerSync:extra,...profile}=value.data;s.profile=copy(profile);
    if(extra){r.profileSync=copy(extra);s.financeOther=copy(extra.financeOther);s.calendar=copy(extra.calendar);}
   }else if(table==='calendar_events'){r.calendarDocument=copy(value.data);s.calendar=copy(value.data);}else{s[{goals:'goals',finance_transactions:'transactions',safety_fund:'safetyFund'}[table]]=copy(value.data);}
   emit(table,uid);
  };
  return {
   rest:{url:'https://fixture.supabase.co/rest/v1',fetch:async()=>{cloud.schemaReads=(cloud.schemaReads||0)+1;if(cloud.schemaUnavailable)throw Error('Schema unavailable');return {ok:true,json:async()=>({definitions:{profiles:{properties:cloud.workspaceColumns?{id:{format:'uuid'},username:{type:'string'},handle:{type:'string'},short_id:{type:'string'},portfolio:{format:'jsonb'},learning_chess:{format:'jsonb'},learning_books:{format:'jsonb'},learning_topics:{format:'jsonb'}}:{id:{format:'uuid'},username:{type:'string'},handle:{type:'string'},short_id:{type:'string'},...(cloud.noWorkspaceStorage?{}:{extra:{format:cloud.extraText?'text':'jsonb'}})}}}})}}},
   auth:{getUser:async()=>{cloud.userChecks=(cloud.userChecks||0)+1;if(cloud.userGate)await cloud.userGate;return {data:{user:cloud.noUser?null:(cloud.verifiedUser||current?.user||null)},error:cloud.userError||null};},onAuthStateChange(callback){cloud.authCallback=callback;return {data:{subscription:{unsubscribe(){}}}};},getSession:async()=>{if(cloud.sessionGate)await cloud.sessionGate;if(cloud.useSDKStorage&&!current){const stored=await options.auth.storage.getItem(options.auth.storageKey);if(stored)current=JSON.parse(stored);}return {data:{session:current},error:cloud.sessionError?{code:'network_error'}:null};},signInWithPassword:async args=>{cloud.authInput=args;if(cloud.signInError)return {data:{session:null},error:cloud.signInError};current=cloud.signInSession||{user:{id:nextUser,email:'test@example.invalid'}};if(cloud.useSDKStorage)await options.auth.storage.setItem(options.auth.storageKey,JSON.stringify(current));return {data:{session:current},error:null};},resetPasswordForEmail:async email=>{cloud.resetEmails??=[];cloud.resetEmails.push(email);if(cloud.resetGate)await cloud.resetGate;return {data:{},error:cloud.resetError?{message:'Provider error'}:null};},signUp:async args=>{cloud.signUpInput=args;if(cloud.sdkSignupSession)current=cloud.sdkSignupSession;if(cloud.signUpResult?.data?.session)current=cloud.signUpResult.data.session;return cloud.signUpResult||{data:{session:null},error:null};},signOut:async()=>{if(cloud.signOutError)return {error:{code:'network_error'}};current=null;return {error:null};}},
   channel(name){const listeners=[];const channel={on(type,filter,callback){const listener={table:filter.table,user:filter.filter.split('eq.')[1],callback};listeners.push(listener);cloud.listeners.add(listener);return channel;},subscribe(callback){callback('SUBSCRIBED');return channel;},listeners};cloud.channelNames??=[];cloud.channelNames.push(name);return channel;},
   async removeChannel(channel){for(const listener of channel.listeners)cloud.listeners.delete(listener);},
   from(table){return {
    select(selected){
     assert.equal(typeof selected,'string');assert.ok(!selected.includes(':'));
     if(table==='profiles'&&selected!=='*'&&selected!=='handle'&&selected!=='short_id'){for(const key of selected.split(','))assert.ok(['id','username','handle','short_id','extra','portfolio','learning_chess','learning_books','learning_topics'].includes(key));}
     const allowed=table==='profiles'?['id,username,handle,short_id','short_id','handle']:table==='goals'?['*']:table==='finance_transactions'?['*','id,user_id,type,amount,category,description,date']:['user_id,data'];assert.ok(table==='profiles'||allowed.includes(selected),`${table}: ${selected}`);
     cloud.projections??=[];cloud.projections.push({table,selected});
     let uid=current?.user.id,columnUsed='user_id';return {order(){return this;},async range(start,end){assert.ok(['goals','finance_transactions'].includes(table));cloud.calls.push({name:`${table}.select`,user:uid});if(cloud.readGate)await cloud.readGate;if(cloud.financeReadGate&&table==='finance_transactions')await cloud.financeReadGate;const field=table==='goals'?'goals':'transactions';const values=table==='finance_transactions'&&cloud.financeDocument?(row(table,uid)?[row(table,uid)]:[]):record(uid).state[field].map(item=>table==='goals'?toGoalRow(item,uid):({type:null,amount:null,category:null,description:null,date:null,...copy(item),user_id:uid})).sort((a,b)=>a.id.localeCompare(b.id));if(table==='finance_transactions'&&cloud.financeMissingColumn)values.forEach(item=>delete item.description);return {data:values.slice(start,end+1),error:failure(table,'select')};     },eq(column,id){uid=id;columnUsed=column;cloud.readFilters??=[];cloud.readFilters.push({table,column,id});return this;},abortSignal(){return this;},async maybeSingle(){
      if(table==='profiles'&&columnUsed==='handle'){cloud.handleSelections??=[];cloud.handleSelections.push(selected);cloud.handleFallbacks??=[];cloud.handleFallbacks.push(uid);if(cloud.handleGate)await cloud.handleGate;if(cloud.handleLookup) return cloud.handleLookup(uid);return {data:(cloud.takenHandles||[]).includes(uid)?{handle:uid}:null,error:cloud.handleLookupError?{code:'FETCH_ERROR'}:null};}
      cloud.calls.push({name:`${table}.select`,user:uid});if(cloud.readGate)await cloud.readGate;
      if(table==='profiles'&&cloud.profileReply)return cloud.profileReply(selected,uid);
      const error=table==='calendar_events'&&cloud.calendarMissing?{code:'PGRST205'}:failure(table,'select');return {data:row(table,uid),error};
     },async single(){assert.equal(table,'profiles');cloud.profileSingleReads=(cloud.profileSingleReads||0)+1;return this.maybeSingle();},async limit(){if(table==='profiles'&&cloud.profileIdSchema&&columnUsed==='user_id')return {error:{code:'42703'}};cloud.calls.push({name:`${table}.select`,user:uid});if(cloud.readGate)await cloud.readGate;const error=table==='calendar_events'&&cloud.calendarMissing?{code:'PGRST205'}:failure(table,'select');const value=row(table,uid);return {data:value?[value]:[],error};}};},
    upsert(value,options={}){
     const uid=Array.isArray(value)?value[0].user_id:value.user_id||value.id;
     if(table==='goals'||table==='finance_transactions'){
      assert.ok(Array.isArray(value));assert.equal(options.onConflict,'id');assert.equal(new Set(value.map(g=>g.id)).size,value.length);
      return (async()=>{cloud.calls.push({name:`${table}.upsert`,user:uid,payload:copy(value),options});const error=failure(table,'upsert');if(error)return {error};
       if(cloud.beforeWrite){const fn=cloud.beforeWrite;cloud.beforeWrite=null;await fn(record(uid),{data:value});}
       for(const row of value){assert.equal(row.user_id,uid);assert.equal(typeof row.id,'string');const items=record(uid).state[table==='goals'?'goals':'transactions'];const index=items.findIndex(item=>item.id===row.id);const decoded=table==='goals'?fromGoalRow(row):Object.fromEntries(Object.entries(row).filter(([key])=>key!=='user_id'));if(index<0)items.push(decoded);else items[index]={...items[index],...decoded};}
       emit(table,uid);return {error:null};})();
     }
     const execute=async()=>{
      cloud.calls.push({name:`${table}.upsert`,user:uid,...(table==='calendar_events'?{payload:copy(value)}:{})});
      const error=table==='calendar_events'&&cloud.calendarRequiresId&&!value.id?{code:'23502'}:
       table==='calendar_events'&&cloud.calendarRequiresTitle&&!value.title?{code:'23502'}:failure(table,'upsert');if(error)return {error};
      if(table==='profiles'){cloud.profileUpserts??=[];cloud.profileUpserts.push(copy(value));}
      if(options.ignoreDuplicates&&row(table,uid))return {data:[],error:null};
      if(cloud.beforeWrite&&table!=='profiles'){const fn=cloud.beforeWrite;cloud.beforeWrite=null;await fn(record(uid),{data:value.data});}
      apply(table,value,uid);return {data:[{user_id:uid}],error:null};
     };
     return {select:execute,then(resolve,reject){return execute().then(resolve,reject);}};
    },
    delete(){const filters={};return {eq(key,value){filters[key]=value;return this;},then(resolve,reject){return (async()=>{assert.ok(['goals','finance_transactions'].includes(table));assert.ok(filters.user_id);assert.ok(filters.id);const error=failure(table,'delete');if(error)return {error};const r=record(filters.user_id),field=table==='goals'?'goals':'transactions';cloud.calls.push({name:`${table}.delete`,user:filters.user_id,id:filters.id});r.state[field]=r.state[field].filter(item=>item.id!==filters.id);emit(table,filters.user_id);return {error:null};})().then(resolve,reject);}};},
    update(value){const filters=[];return {
     eq(column,data){filters.push(['eq',column,data]);return this;},
     is(column,data){filters.push(['is',column,data]);return this;},
     neq(column,data){filters.push(['neq',column,data]);return this;},
     async select(){const uid=filters.find(f=>f[1]===(table==='profiles'?'id':'user_id'))[2];cloud.calls.push({name:`${table}.update`,user:uid});cloud.updateFilters??=[];cloud.updateFilters.push(copy(filters));const error=failure(table,'update');if(error)return {error};
      if(cloud.beforeWrite){const fn=cloud.beforeWrite;cloud.beforeWrite=null;const before=JSON.stringify(record(uid).state);await fn(record(uid),{data:value.data});if(before!==JSON.stringify(record(uid).state)){record(uid).versions??={};record(uid).versions[table]=randomUUID();}}
      const previous=row(table,uid);
      const matches=previous&&filters.every(([op,column,expected])=>{
       if(column==='user_id'||column==='id')return true;
       if(column==='extra->>__ncdWorkspaceVersion'){const actual=previous.extra?.__ncdWorkspaceVersion;return op==='is'?actual==null:actual===expected;}
       const actual=column==='data'?previous.data:column.includes('->0')?previous.data?.[0]?.__goaltrackerVersion:previous.data?.__goaltrackerVersion;
       if(op==='is')return actual==null;
       const same=JSON.stringify(actual)===JSON.stringify(column==='data'?JSON.parse(expected):expected);
       return op==='neq'?!same:same;
      });
      if(!matches)return {data:[],error:null};apply(table,value,uid);return {data:[{user_id:uid}],error:null};
     }
    };}
   };},
   async rpc(name,args){if(name==='ncd_handle_available'){cloud.handleVerifications??=[];cloud.handleVerifications.push(args.candidate);return cloud.verificationError?{data:null,error:{code:'PGRST202'}}:{data:!(cloud.takenHandles||[]).includes(args.candidate),error:null};}if(name==='ncd_email_available'){cloud.emailChecks??=[];cloud.emailChecks.push(args.check_email);if(cloud.emailGate)await cloud.emailGate;if(cloud.emailThrow)throw cloud.emailThrow;return cloud.emailStatus?{data:null,error:null,status:cloud.emailStatus}:cloud.emailError?{data:null,error:cloud.emailError}:{data:!(cloud.takenEmails||[]).includes(args.check_email),error:null};}if(name==='check_handle_available'){cloud.handleChecks??=[];cloud.handleChecks.push(args.candidate);if(cloud.handleGate)await cloud.handleGate;return cloud.handleError?{data:null,error:{code:'PGRST202'}}:{data:!(cloud.takenHandles||[]).includes(args.candidate),error:null};}throw new Error('Data sync must not call RPC');}
  };
 }};
 for(const [key,value] of Object.entries(cloud.browserStorage||{}))w.localStorage.setItem(key,value);
 if(cloud.defaults)w.eval(fs.readFileSync(path.join(root,'supabase-config.js'),'utf8'));if(cloud.savedConfig)w.localStorage.setItem('gt-supabase-config-v1',JSON.stringify(cloud.savedConfig));app.bindEvents();if(cloud.startup){app.user=null;app.showAccountLoading();}else app.showApp();if(cloud.cachedProfile){Object.assign(app,copy(cloud.cachedProfile));snapshot=copy(app.serialize());}w.CloudSync.attach(app);
 const idle=async()=>{await new Promise(r=>w.setTimeout(r,0));const deadline=Date.now()+2000;while(Date.now()<deadline){await new Promise(r=>w.setTimeout(r,1));if(!w.CloudSync.isSyncing()&&!w.CloudSync.isApplying())return;}throw new Error('Sync did not settle');};
 return {w,d,app,cloud,idle,setUser:id=>nextUser=id,online:value=>Object.defineProperty(w.navigator,'onLine',{value,configurable:true}),async login(){await new Promise(resolve=>setImmediate(resolve));if(!w.CloudSync.configured())await w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');await w.CloudSync.authenticate('test@example.invalid','fixture-password',false);if(w.CloudSync.connectionState().needsBinding)d.querySelector('[data-cloud-bind]').click();await idle();if(w.CloudSync.connectionState().state==='active')await w.CloudSync.sync();await idle();},async consent(){d.querySelector('[data-cloud-bind]').click();await idle();}};
}
const goal=(id,title=id)=>({id,title,priority:'medium',status:'active',category:'personal',subgoals:[]});
test('Public key validation rejects secret and service-role keys',t=>{const h=fixture(t),validate=h.w.CloudSyncCore.validateConfig;assert.equal(validate('https://fixture.supabase.co','sb_publishable_test').url,'https://fixture.supabase.co');const jwt=role=>'x.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.x';assert.equal(validate('https://fixture.supabase.co',jwt('anon')).key,jwt('anon'));for(const key of ['sb_secret_test',jwt('service_role'),'bad'])assert.throws(()=>validate('https://fixture.supabase.co',key));assert.throws(()=>validate('http://fixture.supabase.co','sb_publishable_test'));});
test('Three-way merge preserves independent edits, additions, deletions and nested steps',t=>{const h=fixture(t),merge=h.w.CloudSyncCore.merge;const base=[{id:'a',title:'A',subgoals:[{id:'s',completed:false}]},{id:'gone',title:'Gone'}];const local=copy(base);local[0].title='Edited';local.splice(1,1);const remote=copy(base);remote[0].subgoals[0].completed=true;remote.push({id:'new',title:'New'});const result=merge(base,local,remote);assert.deepEqual(copy(result.conflicts),[]);assert.deepEqual(copy(result.value),[{id:'a',title:'Edited',subgoals:[{id:'s',completed:true}]},{id:'new',title:'New'}]);});
test('Conflicting amounts and edit/delete require an explicit choice',t=>{const h=fixture(t),merge=h.w.CloudSyncCore.merge;assert.equal(merge({balance:10},{balance:20},{balance:30}).conflicts.length,1);assert.equal(merge({balance:10},{balance:20},{balance:30},'remote').value.balance,30);assert.equal(merge({id:'a'},undefined,{id:'a',title:'edit'}).conflicts.length,1);});
test('Offline first login opens a clean workspace without uploading stale local records',async t=>{
 const h=fixture(t,{offline:true});h.app.goals=[goal('stale')];await h.app.saveData();await h.login();
 assert.equal(h.app.goals.length,0);assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.w.CloudSync.connectionState().state,'load_error');assert.ok(!h.cloud.calls.some(c=>/upsert|update/.test(c.name)));
});

test('Empty new device automatically downloads goals, finance, calendar and cloud profile',async t=>{const cloud={records:{'11111111-1111-4111-8111-111111111111':{revision:4,state:{goals:[goal('remote')],transactions:[{id:'t',amount:100,type:'income'}],safetyFund:{balance:500},financeOther:{},profile:{nickname:'Cloud',status:'Ready',createdAt:'2025-01-01'},calendar:{notes:{'2026-01-01':[{id:'n',content:'Plan'}]},events:[],achievements:[]}}}}};const h=fixture(t,cloud);await h.login();assert.equal(h.app.goals[0].id,'remote');assert.equal(h.app.user.nickname,'Cloud');assert.equal(h.app.user.supabaseUserId,'11111111-1111-4111-8111-111111111111');assert.equal(h.w.finance.getData().safetyFund.balance,500);assert.equal(h.w.finance.getData().transactions[0].id,'t');assert.equal(h.app.notes['2026-01-01'][0].id,'n');});
test('A profile-only cloud account replaces the generated name on a new device',async t=>{const state={...CloudState(),profile:{nickname:'Cloud profile'}};function CloudState(){return {goals:[],transactions:[],safetyFund:{},financeOther:{},profile:{},calendar:{}};}const h=fixture(t,{records:{'11111111-1111-4111-8111-111111111111':{revision:2,state}}});await h.login();assert.equal(h.app.user.nickname,'Cloud profile');});
test('Cloud-first login isolates unowned records and protects cloud goals from an empty local list',async t=>{
 const h=fixture(t);h.app.goals=[goal('unowned')];await h.app.saveData();await h.login();
 assert.equal(h.app.goals.length,0);assert.ok(!h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.length);
 h.app.goals=[goal('new')];await h.app.saveData();await h.w.CloudSync.sync();assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].id,'new');
 h.app.goals=[];await h.app.saveData();await h.w.CloudSync.sync();assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.length,0);assert.equal(h.app.goals.length,0);
});

test('Account switch pulls the target owner and cannot upload the previous owner records',async t=>{
 const h=fixture(t);await h.login();h.app.goals=[goal('11111111-1111-4111-8111-111111111111-only')];await h.app.saveData();await h.w.CloudSync.sync();await h.w.CloudSync.logout();
 h.setUser('22222222-2222-4222-8222-222222222222');await h.w.CloudSync.authenticate('b@example.invalid','fixture-password',false);await h.idle();await h.w.CloudSync.sync();
 assert.equal(h.app.user.supabaseUserId,'22222222-2222-4222-8222-222222222222');assert.equal(h.app.goals.length,0);assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].id,'11111111-1111-4111-8111-111111111111-only');assert.equal(h.cloud.records['22222222-2222-4222-8222-222222222222'].state.goals.length,0);
});

test('Offline edits survive reconnect and merge another device additions without resurrection',async t=>{const h=fixture(t);await h.login();h.app.settings.autoSync=true;h.online(false);h.app.goals=[goal('local')];await h.app.saveData();h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals=[goal('other')];h.cloud.records['11111111-1111-4111-8111-111111111111'].revision++;h.online(true);h.w.dispatchEvent(new h.w.Event('online'));await h.idle();assert.deepEqual(h.app.goals.map(g=>g.id).sort(),['local','other']);});
test('Conflicts leave both versions intact until an explicit resolve button is used',async t=>{const h=fixture(t);await h.login();h.app.goals=[goal('a')];await h.app.saveData();await h.w.CloudSync.sync();h.app.goals[0].title='Local edit';await h.app.saveData();h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].title='Remote edit';h.cloud.records['11111111-1111-4111-8111-111111111111'].revision++;assert.equal(await h.w.CloudSync.sync(),false);assert.equal(h.app.goals[0].title,'Local edit');assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].title,'Remote edit');assert.equal(h.d.querySelector('[data-cloud-conflicts]').hidden,false);await h.w.CloudSync.sync('remote');assert.equal(h.app.goals[0].title,'Remote edit');});
test('Per-goal upsert preserves a different goal inserted by the competing device',async t=>{const h=fixture(t);await h.login();h.app.goals=[goal('local')];await h.app.saveData();h.cloud.beforeWrite=async record=>{record.state.goals.push(goal('concurrent'));record.revision++;};assert.equal(await h.w.CloudSync.sync(),true);assert.deepEqual(h.app.goals.map(g=>g.id).sort(),['concurrent','local']);});
test('Edits made during a request survive acknowledgement and the next upload',async t=>{const h=fixture(t);await h.login();h.app.goals=[goal('first')];await h.app.saveData();h.cloud.beforeWrite=async()=>{h.app.goals.push(goal('during-flight'));await h.app.saveData();};await h.w.CloudSync.sync();assert.ok(h.app.goals.some(g=>g.id==='during-flight'));await h.w.CloudSync.sync();assert.ok(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.some(g=>g.id==='during-flight'));});
test('Incoming apply failure keeps local state and a durable receipt for retry',async t=>{const h=fixture(t);await h.login();const old=copy(h.app.goals);h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals=[goal('remote')];h.cloud.records['11111111-1111-4111-8111-111111111111'].revision++;h.cloud.failDisk=true;assert.equal(await h.w.CloudSync.sync(),false);assert.deepEqual(copy(h.app.goals),old);assert.ok(h.w.localStorage.getItem('gt-cloud-state-v1:https://fixture.supabase.co|11111111-1111-4111-8111-111111111111').includes('receipt'));h.cloud.failDisk=false;await h.w.CloudSync.sync();assert.equal(h.app.goals[0].id,'remote');});
test('Auth uses SDK persistence and passwords do not enter app config, backups or outbox',async t=>{const h=fixture(t);await h.login();assert.equal(h.cloud.options.auth.persistSession,true);assert.equal(h.cloud.options.auth.autoRefreshToken,true);assert.equal(h.cloud.authInput.password,'fixture-password');for(let i=0;i<h.w.localStorage.length;i++)assert.ok(!h.w.localStorage.getItem(h.w.localStorage.key(i)).includes('fixture-password'));});
test('Login uses the cloud profile and later edits upsert only the owned profile row',async t=>{
 const h=fixture(t,{records:{'11111111-1111-4111-8111-111111111111':{revision:1,state:{goals:[],transactions:[],safetyFund:{},financeOther:{},calendar:{},profile:{nickname:'Cloud Name'}},present:['profiles','user_profile']}}});h.app.user.nickname='Unowned Name';await h.login();assert.equal(h.app.user.nickname,'Cloud Name');
 h.app.user.nickname='Renamed';await h.w.CloudSync.saveAccountProfile();assert.deepEqual(h.cloud.profileUpserts.at(-1),{id:'11111111-1111-4111-8111-111111111111',username:'Renamed',handle:'user_111111111111411181111111111'});
});

test('SQL policies are owner-scoped with invoker RPC, revision locks and no anon grants',()=>{const sql=fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8');assert.match(sql,/force row level security/);assert.match(sql,/using \(\(select auth\.uid\(\)\) = user_id\) with check \(\(select auth\.uid\(\)\) = user_id\)/);assert.match(sql,/for update/);assert.match(sql,/errcode='40001'/);assert.match(sql,/security invoker/);assert.doesNotMatch(sql,/security definer|grant .* to anon/);});
test('Concurrent fund changes remain one coherent balance/history version',t=>{const h=fixture(t);const base={balance:0,history:[]},local={balance:100,history:[{id:'local',amount:100}]},remote={balance:200,history:[{id:'remote',amount:200}]};const result=h.w.CloudSyncCore.merge(base,local,remote,undefined,'/safetyFund');assert.equal(result.conflicts.length,1);const chosen=h.w.CloudSyncCore.merge(base,local,remote,'local','/safetyFund');assert.equal(chosen.value.balance,100);assert.equal(chosen.value.history.length,1);assert.equal(chosen.value.history[0].id,'local');});
test('Explicit offline deletion of the last goal survives restart and reaches the cloud',async t=>{const cloud={};const first=fixture(t,cloud);await first.login();first.app.goals=[goal('delete-later')];await first.app.saveData();await first.w.CloudSync.sync();first.online(false);first.app.goals=[];await first.app.saveData();const stored={};for(let i=0;i<first.w.localStorage.length;i++){const key=first.w.localStorage.key(i);stored[key]=first.w.localStorage.getItem(key);}cloud.initialSession={user:{id:'11111111-1111-4111-8111-111111111111',email:'test@example.invalid'}};const second=fixture(t,cloud);for(const [key,value] of Object.entries(stored))second.w.localStorage.setItem(key,value);await second.w.ProfileStorage.save(JSON.parse(stored.goalTracker_data));second.app.loadData();second.w.finance.replaceData(JSON.parse(stored.goalTracker_finance||'{}'));await second.login();await second.w.CloudSync.sync();assert.equal(cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.length,0);assert.equal(second.app.goals.length,0);});
test('Explicit local reset clears the baseline so it cannot delete cloud backups',async t=>{const h=fixture(t);await h.login();h.app.goals=[goal('keep-in-cloud')];await h.app.saveData();await h.w.CloudSync.sync();h.w.CloudSync.prepareLocalReset();h.app.goals=[];await h.app.saveData();await h.w.CloudSync.sync();assert.ok(h.app.goals.some(g=>g.id==='keep-in-cloud'));assert.ok(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.some(g=>g.id==='keep-in-cloud'));});
test('A legacy autoSync=false setting cannot disable cloud write-through for an active account',async t=>{
 const h=fixture(t);await h.login();h.app.settings.autoSync=false;h.app.goals=[goal('automatic')];await h.app.saveData();await new Promise(r=>h.w.setTimeout(r,30));await h.idle();assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].id,'automatic');
});

test('Existing finance plans or income history prevent automatic replacement on first login',t=>{const h=fixture(t);let state=h.w.CloudSync.capture();state.safetyFund.targetMonths=9;assert.equal(h.w.CloudSync.localEmpty(state),false);state.safetyFund.targetMonths=6;state.financeOther.growth={history:[{date:'2026-01-01',income:100}]};assert.equal(h.w.CloudSync.localEmpty(state),false);});
test('Cloud controls live only in Settings; auth opens with focus and closes without closing Settings',t=>{const h=fixture(t),{d,w}=h;assert.equal(d.querySelector('#profileView #cloudSyncPanel'),null);assert.ok(d.querySelector('#settingsModal #cloudSyncPanel'));h.app.openSettingsModal();d.querySelector('[data-cloud-open-auth]').click();assert.ok(d.getElementById('cloudAuthModal').classList.contains('active'));assert.equal(d.activeElement.id,'cloudAuthEmail');d.getElementById('cloudAuthPassword').value='private-password';d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(d.getElementById('cloudAuthPassword').value,'');assert.ok(!d.getElementById('cloudAuthModal').classList.contains('active'));assert.ok(d.getElementById('settingsModal').classList.contains('active'));assert.equal(d.activeElement,d.querySelector('[data-cloud-open-auth]'));w.CloudSync.openAuth();d.querySelector('#cloudAuthModal .modal-overlay').click();assert.ok(!d.getElementById('cloudAuthModal').classList.contains('active'));});
test('Registration switch changes password autocomplete; missing configuration displays error and allows retry',async t=>{const h=fixture(t),{d,w}=h;w.CloudSync.openAuth();const form=d.querySelector('[data-cloud-auth]');form.querySelector('[value=signup]').click();assert.equal(d.getElementById('cloudAuthPassword').autocomplete,'new-password');form.querySelector('[value=signin]').click();assert.equal(d.getElementById('cloudAuthPassword').autocomplete,'current-password');form.querySelector('[name=email]').value='test@example.invalid';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));form.querySelector('[name=password]').value='private-password';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(form.querySelector('[type=submit]').disabled,true);await new Promise(r=>setImmediate(r));assert.match(d.querySelector('[data-cloud-auth-status]').textContent,/временно недоступно/);assert.equal(form.querySelector('[type=submit]').disabled,false);assert.equal(form.querySelector('[name=password]').value,'');assert.ok(d.getElementById('cloudAuthModal').classList.contains('active'));});
test('Successful UI login closes auth, shows email and truthful sync badge; logout clears local goals',async t=>{const h=fixture(t),{d,w}=h;await w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');h.app.openSettingsModal();w.CloudSync.openAuth();const form=d.querySelector('[data-cloud-auth]');form.querySelector('[name=email]').value='test@example.invalid';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));form.querySelector('[name=password]').value='fixture-password';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));await h.idle();assert.ok(!d.getElementById('cloudAuthModal').classList.contains('active'));assert.equal(d.querySelector('[data-cloud-account]').textContent,'test@example.invalid');assert.equal(d.querySelector('[data-cloud-open-auth]').hidden,true);assert.equal(d.querySelector('[data-cloud-actions]').hidden,false);assert.match(d.querySelector('[data-cloud-status]').textContent,/^(Аккаунт подключён|Синхронизировано) 🟢$/);h.app.goals=[goal('keep')];await h.app.saveData();await w.CloudSync.logout();assert.equal(d.querySelector('[data-cloud-open-auth]').hidden,false);assert.equal(d.querySelector('[data-cloud-account]').hidden,true);assert.equal(h.app.goals.length,0);assert.equal(h.app.user,null);assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));});
test('Offline signed-in account never displays a false green synchronization badge',async t=>{const h=fixture(t);h.online(false);await h.login();assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.d.querySelector('[data-cloud-status]').classList.contains('is-synced'),false);assert.doesNotMatch(h.d.querySelector('[data-cloud-status]').textContent,/Синхронизировано 🟢/);});
test('Bundled defaults activate Auth without manual setup or configuration message',async t=>{const h=fixture(t,{defaults:true});await new Promise(r=>setImmediate(r));assert.equal(h.w.CloudSync.configured(),true);assert.equal(h.cloud.clientURL,'https://kvyhbbctpyeoikjqhubu.supabase.co');h.w.CloudSync.openAuth();assert.equal(h.d.querySelector('[data-cloud-auth] [type=submit]').disabled,false);assert.doesNotMatch(h.d.querySelector('[data-cloud-auth-status]').textContent,/Сначала укажите/);await h.w.CloudSync.authenticate('test@example.invalid','fixture-password',false);await h.idle();assert.equal(h.cloud.authInput.email,'test@example.invalid');assert.equal(h.w.CloudSync.connectionState().state,'active');assert.match(h.d.querySelector('[data-cloud-status]').textContent,/^(Аккаунт подключён|Синхронизировано) 🟢$/);});
test('Saved project configuration is preserved over defaults without replacing account ownership',async t=>{const h=fixture(t,{defaults:true,savedConfig:{url:'https://previous.supabase.co',key:'sb_publishable_previous'}});await new Promise(r=>setImmediate(r));assert.equal(h.cloud.clientURL,'https://previous.supabase.co');});
test('Default config is included before sync in browser, PWA, and Electron artifacts',()=>{assert.ok(html.indexOf('src="supabase-config.js"')<html.indexOf('src="sync.js"'));assert.ok(JSON.parse(fs.readFileSync(path.join(root,'package.json'))).build.files.includes('supabase-config.js'));assert.match(fs.readFileSync(path.join(root,'sw.js'),'utf8'),/\.\/supabase-config\.js/);assert.match(fs.readFileSync(path.join(root,'bin/prepare-web.js'),'utf8'),/'supabase-config.js'/);});

test('Recovery mode keeps only email and returns to the first login step',t=>{
 const h=fixture(t),{d,w}=h;w.CloudSync.openAuth();const form=d.querySelector('[data-cloud-auth]');
 form.querySelector('[name=email]').value='test@example.invalid';form.dispatchEvent(new w.Event('submit',{cancelable:true}));
 d.getElementById('cloudAuthPassword').value='secret-password';d.querySelector('[data-cloud-forgot]').click();const password=d.getElementById('cloudAuthPassword');
 assert.equal(password.value,'');assert.equal(password.disabled,true);assert.equal(password.required,false);assert.equal(d.querySelector('[data-cloud-password]').hidden,true);assert.equal(d.querySelector('.cloud-auth-mode').hidden,true);assert.equal(form.querySelector('[type=submit]').textContent,'Отправить письмо');assert.equal(d.activeElement.id,'cloudAuthEmail');
 d.querySelector('[data-cloud-back]').click();assert.equal(form.dataset.step,'email');assert.equal(password.required,false);assert.equal(password.disabled,true);assert.equal(d.querySelector('[data-cloud-password]').hidden,true);assert.match(form.querySelector('[type=submit]').textContent,/Продолжить/);
});

test('Recovery calls SDK with email only and shows green success without logging in or syncing',async t=>{const h=fixture(t,{defaults:true}),{d,w}=h;await new Promise(r=>setImmediate(r));const toasts=[];h.app.showToast=(...args)=>toasts.push(args);w.CloudSync.openAuth();d.querySelector('[data-cloud-forgot]').click();d.getElementById('cloudAuthEmail').value='reset@example.invalid';assert.equal(d.querySelector('[data-cloud-auth]').checkValidity(),true);d.querySelector('[data-cloud-auth] [type=submit]').click();await new Promise(r=>setImmediate(r));assert.deepEqual(h.cloud.resetEmails,['reset@example.invalid']);assert.equal(d.querySelector('[data-cloud-auth-status]').textContent,'Инструкция по сбросу отправлена на почту');assert.equal(d.querySelector('[data-cloud-auth-status]').classList.contains('is-success'),true);assert.equal(toasts[0][1],'success');assert.equal(h.cloud.authInput,undefined);assert.equal(h.cloud.calls.length,0);assert.equal(d.querySelector('[data-cloud-status]').classList.contains('is-synced'),false);assert.equal(d.getElementById('cloudAuthModal').classList.contains('active'),true);w.CloudSync.closeAuth();w.CloudSync.openAuth();assert.equal(d.querySelector('[data-cloud-auth-status]').classList.contains('is-success'),false);assert.equal(d.getElementById('cloudAuthPassword').required,false);});
test('Recovery errors stay visible and permit retry without claiming email sent',async t=>{const h=fixture(t,{defaults:true,resetError:true}),{d,w}=h;await new Promise(r=>setImmediate(r));w.CloudSync.openAuth();d.querySelector('[data-cloud-forgot]').click();d.getElementById('cloudAuthEmail').value='reset@example.invalid';const submit=d.querySelector('[data-cloud-auth] [type=submit]');submit.click();await new Promise(r=>setImmediate(r));assert.match(d.querySelector('[data-cloud-auth-status]').textContent,/Provider error/);assert.equal(d.querySelector('[data-cloud-auth-status]').classList.contains('is-success'),false);assert.equal(submit.disabled,false);assert.equal(d.getElementById('cloudAuthPassword').disabled,true);h.cloud.resetError=false;submit.click();await new Promise(r=>setImmediate(r));assert.equal(h.cloud.resetEmails.length,2);assert.equal(d.querySelector('[data-cloud-auth-status]').classList.contains('is-success'),true);});
test('Recovery guards duplicate requests and locks mode switching while waiting',async t=>{let release;const gate=new Promise(r=>release=r);const h=fixture(t,{defaults:true,resetGate:gate}),{d,w}=h;await new Promise(r=>setImmediate(r));w.CloudSync.openAuth();d.querySelector('[data-cloud-forgot]').click();d.getElementById('cloudAuthEmail').value='reset@example.invalid';const form=d.querySelector('[data-cloud-auth]');form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.cloud.resetEmails.length,1);assert.equal(d.querySelector('[data-cloud-back]').disabled,true);release();await new Promise(r=>setImmediate(r));assert.equal(form.querySelector('[type=submit]').disabled,false);assert.equal(d.getElementById('cloudAuthPassword').disabled,true);});

test('Workspace and Friends open before the first scoped pull',async t=>{
 let release;const h=fixture(t,{readGate:new Promise(r=>release=r)});await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');
 const login=h.w.CloudSync.authenticate('test@example.invalid','fixture-password',false);await new Promise(r=>setImmediate(r));
 assert.equal(h.w.CloudSync.connectionState().state,'loading');assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.w.CloudSync.accountConnection().userId,'11111111-1111-4111-8111-111111111111');assert.equal(h.d.querySelector('[data-cloud-status]').classList.contains('is-synced'),false);
 release();await login;await h.idle();assert.equal(h.w.CloudSync.connectionState().state,'active');assert.match(h.d.querySelector('[data-cloud-status]').textContent,/(Аккаунт подключён|Синхронизировано) 🟢/);
});

for(const code of ['PGRST205','42P01','42501'])test(`Account pull ${code} keeps the workspace open and retries without uploads`,async t=>{
 const h=fixture(t,{tableError:code});await h.login();assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.w.CloudSync.connectionState().state,'load_error');assert.equal(h.d.querySelector('[data-cloud-status]').classList.contains('is-synced'),false);assert.ok(!h.cloud.calls.some(c=>/upsert|update/.test(c.name)));
 h.cloud.tableError=null;await h.w.CloudSync.authenticate('test@example.invalid','fixture-password',false);await h.idle();assert.equal(h.w.CloudSync.connectionState().state,'active');assert.equal(h.d.getElementById('app').style.display,'flex');
});
test('Failed uploads retain goal and finance edits, then automatic changes upload after recovery',async t=>{const h=fixture(t);await h.login();h.app.settings.autoSync=true;h.cloud.tableError='42501';h.cloud.failOperation='goals.upsert';h.app.goals=[goal('goal-change')];await h.app.saveData();h.w.finance.replaceData({transactions:[{id:'tx-change',amount:300,type:'income',description:'Test'}]});await h.w.CloudSync.sync();assert.match(h.d.querySelector('[data-cloud-diagnostic]').textContent,/goals.upsert/);assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.length,0);assert.equal(h.app.goals[0].id,'goal-change');assert.equal(h.w.finance.getData().transactions[0].id,'tx-change');h.cloud.tableError=null;h.w.document.dispatchEvent(new h.w.Event('goaltracker:finance-changed'));await new Promise(r=>setTimeout(r,1000));await h.idle();assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].id,'goal-change');assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.transactions[0].amount,300);h.app.goals[0].title='Changed title';await h.app.saveData();await new Promise(r=>setTimeout(r,1000));await h.idle();assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].title,'Changed title');assert.equal(h.d.querySelector('[data-cloud-status]').textContent,'Синхронизировано 🟢');await h.w.CloudSync.logout();assert.equal(h.d.querySelector('[data-cloud-status]').classList.contains('is-connected'),false);assert.equal(h.d.querySelector('[data-cloud-sync-status]').hidden,true);});

for (const error of [{message:'User already registered'}, {code:'user_already_exists'}, {code:'email_exists'}, {status:422,message:'Password is too weak'}, {status:400,message:'Email address is invalid'}]) {
 test(`Explicit signup errors preserve their meaning without attempting sign-in: ${JSON.stringify(error)}`,async t=>{
  const h=fixture(t,{signUpResult:{data:{},error}});await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');
  const expected=error.message||error.code;
  await assert.rejects(h.w.CloudSync.authenticate('test@example.invalid','fixture-password',true),{message:expected});assert.equal(h.cloud.authInput,undefined);assert.equal(h.cloud.calls.length,0);
 });
}
test('Hidden duplicate signup logs in instead of creating a blank account',async t=>{
 const h=fixture(t,{signUpResult:{data:{session:null,user:{identities:[]}},error:null}});
 await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');
 await h.w.CloudSync.authenticate('test@example.invalid','fixture-password',true);await h.idle();assert.ok(h.cloud.authInput);
});
test('Wrong password after duplicate signup shows actionable modal error and permits retry',async t=>{
 const h=fixture(t,{defaults:true,signUpResult:{data:{},error:{code:'user_already_exists'}},signInError:{code:'invalid_credentials'}});
 await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth();const form=h.d.querySelector('[data-cloud-auth]');
 form.querySelector('[value=signup]').click();form.querySelector('[name=email]').value='test@example.invalid';
 form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));assert.equal(form.dataset.step,'profile');
 form.querySelector('[name=nickname]').value='sayonara';form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));
 form.querySelector('[name=password]').value='wrong-password';form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));
 assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'user_already_exists');
 assert.equal(form.querySelector('[type=submit]').disabled,false);assert.equal(h.cloud.calls.length,0);assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
});
test('New signup requiring confirmation attempts seamless login but never bypasses verification',async t=>{
 const h=fixture(t,{signInError:{code:'email_not_confirmed'}});await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');
 const result=await h.w.CloudSync.authenticate('new@example.invalid','fixture-password',true);assert.equal(result.confirmationRequired,true);assert.ok(h.cloud.authInput);assert.equal(h.cloud.calls.length,0);
});
test('First authentication publishes only the hydrated account to Friends',async t=>{
 const h=fixture(t);const connections=[];h.d.addEventListener('goaltracker:cloud-session',()=>connections.push(h.w.CloudSync.accountConnection()));await h.login();
 assert.ok(connections.some(c=>c?.userId==='11111111-1111-4111-8111-111111111111'));assert.ok(connections.every(c=>!c||c.userId==='11111111-1111-4111-8111-111111111111'));
});

test('Switching accounts automatically replaces the cache instead of requiring a local-data binding',async t=>{
 const h=fixture(t);await h.login();await h.w.CloudSync.logout();h.setUser('22222222-2222-4222-8222-222222222222');await h.w.CloudSync.authenticate('b@example.invalid','fixture-password',false);await h.idle();
 assert.equal(h.w.CloudSync.connectionState().state,'active');assert.equal(h.w.CloudSync.accountConnection().userId,'22222222-2222-4222-8222-222222222222');assert.equal(h.d.querySelector('[data-cloud-bind]').hidden,true);assert.ok(h.cloud.calls.some(c=>c.user==='22222222-2222-4222-8222-222222222222'));
});

test('Startup recovery failure stays quiet and retains native backup tokens',async t=>{
 const prefix='goaltracker.supabase.tokens.fixture.supabase.co.';
 const nativeStore=new Map([[prefix+'access_token','fixture-access'],[prefix+'refresh_token','fixture-refresh']]);
 const h=fixture(t,{nativeStore,sessionError:true});
 await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');
 assert.equal(h.w.CloudSync.connectionState().state,'restore_error');
 assert.equal(nativeStore.size,2);
 assert.match(h.d.querySelector('[data-cloud-session-state]').textContent,/Не удалось восстановить/);
 assert.equal(h.d.querySelector('[data-cloud-storage-state]'),null);
});

test('Settings keep account controls without destructive, export or manual sync actions',async t=>{
 const h=fixture(t);h.app.openSettingsModal();const settings=h.d.getElementById('settingsModal');
 for(const selector of ['#autoSyncEnabled','#syncUrlInput','#syncUrlGroup','#importDataBtn','#syncNowBtn','[data-cloud-config]','[data-cloud-sync]','#resetProfileBtn','#exportCSVBtn','#exportPDFBtn','#exportDataBtn','[data-cloud-detail-status]'])assert.equal(settings.querySelector(selector),null);
 assert.ok(settings.querySelector('[data-cloud-open-auth]'));assert.ok(settings.querySelector('.theme-selector'));assert.ok(settings.querySelector('#notificationsEnabled'));
 for(const method of ['resetProfile','exportData','exportCSV','exportPDF'])assert.equal(typeof h.app[method],'function');
 assert.doesNotMatch(settings.textContent,/Сбросить профиль|Локальный профиль|Экспорт данных|Синхронизировать сейчас/);
 await h.login();assert.equal(settings.querySelector('[data-cloud-logout]').hidden,false);
});
test('Direct table write error remains visible once without synchronized status',async t=>{
 const h=fixture(t);await h.login();h.cloud.tableError='42501';h.cloud.failOperation='goals.upsert';
 h.app.goals=[goal('pending')];await h.app.saveData();await h.w.CloudSync.sync();
 const panel=h.d.querySelector('#cloudSyncPanel');
 assert.match(panel.querySelector('[data-cloud-sync-status]').textContent,/Синхронизация не завершена/);
 assert.match(panel.querySelector('[data-cloud-diagnostic]').textContent,/42501.*goals.upsert/);
 assert.equal(panel.querySelector('[data-cloud-diagnostic]').hidden,false);
 assert.equal(panel.querySelector('[data-cloud-status]').classList.contains('is-synced'),false);
 assert.equal(panel.textContent.split('Синхронизация не завершена').length-1,1);
});
test('Nested attachments survive goal JSON cloud roundtrip and subgoal progress changes',async t=>{
 const h=fixture(t);const state=copy(h.w.CloudSyncCore.empty());
 state.goals=[{...goal('attached'),subgoals:[{id:'step',title:'With document',completed:false,attachments:[{id:'file',name:'plan.pdf',type:'application/pdf',size:1,url:'data:application/pdf;base64,eA=='}]}]}];
 h.cloud.records['11111111-1111-4111-8111-111111111111']={revision:4,state};await h.login();
 assert.equal(h.app.goals[0].subgoals[0].attachments[0].name,'plan.pdf');
 await h.app.toggleSubgoal('attached','step',true);await h.w.CloudSync.sync();
 assert.equal(h.app.calculateProgress(h.app.goals[0]),100);
 const next=fixture(t,h.cloud);await next.login();
 assert.equal(next.app.goals[0].subgoals[0].attachments[0].url,'data:application/pdf;base64,eA==');
 assert.equal(next.app.calculateProgress(next.app.goals[0]),100);
});

test('Reopening account Settings preserves the cloud panel and authorization',async t=>{
 const h=fixture(t);await h.login();const panel=h.d.getElementById('cloudSyncPanel');
 h.app.openSettingsModal();h.app.closeModal('settingsModal');h.app.openSettingsModal();
 assert.equal(h.d.getElementById('cloudSyncPanel'),panel);
 assert.ok(h.d.querySelector('#settingsModal #settingsUserCard .profile-avatar'));
 assert.ok(h.d.querySelector('#settingsModal #categoryStats'));
 assert.equal(h.d.querySelectorAll('#profileContent').length,1);
 assert.equal(panel.querySelector('[data-cloud-account]').hidden,false);
 panel.querySelector('[data-cloud-logout]').click();await h.idle();
 assert.equal(panel.querySelector('[data-cloud-open-auth]').hidden,false);
});

test('Desktop pushes all domains and Android receives live updates without RPC calls',async t=>{
 const cloud={};const desktop=fixture(t,cloud);await desktop.login();
 desktop.app.goals=[{...goal('shared'),subgoals:[{id:'step',title:'Step',completed:false,attachments:[{name:'a.txt',url:'data:text/plain;base64,eA=='}]}]}];
 desktop.w.finance.replaceData({transactions:[{id:'tx',amount:150,type:'income'}],safetyFund:{balance:1200,history:[]}});
 desktop.app.user.nickname='Shared profile';await desktop.app.saveData();await desktop.w.CloudSync.sync();
 cloud.nativeStore=new Map();const phone=fixture(t,cloud);await phone.login();assert.equal(phone.w.Capacitor.isNativePlatform(),true);
 assert.equal(phone.app.goals[0].subgoals[0].attachments[0].name,'a.txt');assert.equal(phone.app.user.nickname,'Shared profile');
 assert.equal(phone.w.finance.getData().safetyFund.balance,1200);
 await desktop.app.toggleSubgoal('shared','step',true);
 await new Promise(r=>setTimeout(r,650));await desktop.idle();await phone.idle();
 assert.equal(phone.app.goals[0].subgoals[0].completed,true);
 assert.equal(JSON.parse(phone.w.localStorage.getItem('goalTracker_data')).goals[0].subgoals[0].completed,true);
 phone.w.finance.replaceData({...phone.w.finance.getData(),safetyFund:{balance:1700,history:[]}});
 phone.d.dispatchEvent(new phone.w.Event('goaltracker:finance-changed'));
 await new Promise(r=>setTimeout(r,650));await phone.idle();await desktop.idle();
 assert.equal(desktop.w.finance.getData().safetyFund.balance,1700);
 assert.ok(cloud.calls.some(c=>c.name==='goals.upsert'));assert.ok(cloud.calls.some(c=>c.name==='goals.upsert'));
 assert.ok(cloud.channelNames.length>=2);
 assert.ok(cloud.calls.every(c=>!c.name.startsWith('goaltracker_')));
});
test('Large inline attachments use short JSONB version filters and do not leak sync metadata into UI',async t=>{
 const h=fixture(t);await h.login();
 h.app.goals=[{...goal('large'),subgoals:[{id:'step',title:'Document',attachments:[{name:'file.txt',url:'data:text/plain;base64,'+'eA=='.repeat(20000)}]}]}];
 await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 h.app.goals[0].title='Updated';await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 assert.ok((h.cloud.updateFilters||[]).every(filters=>JSON.stringify(filters).length<600));
 assert.equal(h.app.goals[0].__goaltrackerVersion,undefined);
 assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].subgoals[0].attachments[0].name,'file.txt');
});
test('A partial multi-table failure retains pending local edits and recovers on retry',async t=>{
 const h=fixture(t);await h.login();h.app.goals=[goal('partial')];
 h.w.finance.replaceData({...h.w.finance.getData(),safetyFund:{balance:900,history:[]}});
 await h.app.saveData();h.cloud.tableError='42501';h.cloud.failOperation='safety_fund.update';
 assert.equal(await h.w.CloudSync.sync(),false);assert.equal(h.app.goals[0].id,'partial');
 assert.equal(h.w.finance.getData().safetyFund.balance,900);assert.equal(h.d.querySelector('[data-cloud-status]').classList.contains('is-synced'),false);
 h.cloud.tableError=null;assert.equal(await h.w.CloudSync.sync(),true);
 assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.safetyFund.balance,900);
 assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].id,'partial');
});
test('Social profiles keyed by id retain full profile/calendar/finance via user_profile',async t=>{
 const h=fixture(t,{profileIdSchema:true});await h.login();h.app.user.nickname='Synced name';
 h.app.notes={'2030-01-01':[{id:'note',content:'Plan',time:'10:00'}]};await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 assert.ok(h.cloud.profileUpserts.some(row=>row.id==='11111111-1111-4111-8111-111111111111'&&row.username==='Synced name'));
 const second=fixture(t,h.cloud);await second.login();assert.equal(second.app.user.nickname,'Synced name');assert.equal(second.app.notes['2030-01-01'][0].content,'Plan');
});

test('Goals use separate id-conflict rows with the session owner and SQL field names',async t=>{
 const h=fixture(t);await h.login();
 h.app.goals=[{...goal('one'),user_id:'untrusted-owner',parentId:null,createdAt:'2026-01-01T10:00:00Z',subgoals:[{id:'s',title:'Step',attachments:[{name:'a.pdf',url:'https://example.invalid/a.pdf'}]}]},goal('two')];
 await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 const call=h.cloud.calls.filter(c=>c.name==='goals.upsert').at(-1);
 assert.equal(call.options.onConflict,'id');assert.equal(call.payload.length,2);
 assert.ok(call.payload.every(row=>row.user_id==='11111111-1111-4111-8111-111111111111'&&typeof row.id==='string'));
 assert.equal(call.payload[0].created_at,undefined);assert.equal(call.payload[0].parent_id,null);assert.equal(call.payload[0].createdAt,undefined);
 assert.equal(h.app.goals[0].subgoals[0].attachments[0].name,'a.pdf');
 h.app.goals=h.app.goals.filter(g=>g.id!=='one');await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 assert.deepEqual(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.map(g=>g.id),['two']);
});
test('Goals pull reads beyond the first page rather than a single user document',async t=>{
 const h=fixture(t);const state=copy(h.w.CloudSyncCore.empty());state.goals=Array.from({length:503},(_,i)=>goal(`goal-${String(i).padStart(4,'0')}`));
 h.cloud.records['11111111-1111-4111-8111-111111111111']={revision:1,state};await h.login();
 assert.equal(h.app.goals.length,503);assert.equal(h.app.goals.at(-1).id,'goal-0502');
 assert.ok(h.cloud.calls.filter(c=>c.name==='goals.select').length>=4);
 assert.equal(h.cloud.calls.some(c=>c.name==='goals.upsert'),false);
});
test('Duplicate or empty goal IDs stop upload without overwriting cloud goals',async t=>{
 const h=fixture(t);await h.login();
 for(const goals of [[goal('same'),goal('same')],[goal('')]]){
  h.app.goals=goals;await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),false);
  assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.length,0);
 }
 assert.equal(h.cloud.calls.some(c=>c.name==='goals.upsert'),false);
});

test('Goal payload omits unsupported timestamp columns without mutating source',async t=>{
 const h=fixture(t);await h.login();
 h.app.goals=[{...goal('valid-date'),createdAt:'2026-10-21T15:00:00+10:00',updatedAt:'broken'},
  {...goal('invalid-date'),created_at:'2026-02-30',updatedAt:{bad:true}},
  {...goal('date-object'),createdAt:new h.w.Date('2026-10-21T00:00:00Z')}];
 const source=h.app.goals[0];
 await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 const call=h.cloud.calls.filter(c=>c.name==='goals.upsert').at(-1);
 assert.equal(call.options.defaultToNull,false);
 const valid=call.payload.find(g=>g.id==='valid-date');assert.equal(valid.created_at,undefined);assert.equal('updated_at' in valid,false);
 const invalid=call.payload.find(g=>g.id==='invalid-date');assert.equal('created_at' in invalid,false);assert.equal('updated_at' in invalid,false);
 assert.equal(call.payload.find(g=>g.id==='date-object').created_at,undefined);
 assert.equal(source.createdAt,'2026-10-21T15:00:00+10:00');
});
test('Malformed string IDs stop uploads without coercion or changing cloud data',async t=>{
 const h=fixture(t);await h.login();
 for(const id of ['undefined','[object Object]',' spaced ','with space']){
  h.app.goals=[goal(id)];await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),false);
  assert.match(h.d.querySelector('[data-cloud-diagnostic]').textContent,/Некорректное поле: id/);
 }
 assert.equal(h.cloud.calls.some(c=>c.name==='goals.upsert'),false);
});
test('Row transactions omit unsupported fields while profile and fund documents sanitize timestamps',async t=>{
 const h=fixture(t);await h.login();
 h.app.user.createdAt='broken';
 const get=h.w.finance.getData,replace=h.w.finance.replaceData;
 const raw={...get(),transactions:[{id:'tx-clean',amount:3,type:'income',created_at:'2026-10-21T15:00:00+10:00',updated_at:'bad'}],safetyFund:{balance:5,created_at:'bad',updated_at:'2026-10-21'}};
 h.w.finance.getData=()=>copy(raw);
 h.w.finance.replaceData=next=>{replace(next);h.w.finance.getData=get;};
 await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 const state=h.cloud.records['11111111-1111-4111-8111-111111111111'].state;
 assert.equal(state.profile.createdAt,undefined);assert.equal(state.transactions[0].created_at,undefined);assert.equal(state.transactions[0].updated_at,undefined);
 assert.equal(state.safetyFund.created_at,undefined);assert.equal(state.safetyFund.updated_at,'2026-10-21T00:00:00.000Z');
});

test('Registration steps check unique handle and send clean metadata without creating a local profile before confirmation',async t=>{
 const h=fixture(t,{defaults:true,signInError:{code:'email_not_confirmed'}});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const form=h.d.querySelector('[data-cloud-auth]');
 const submit=async()=>{form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));};
 form.querySelector('[name=email]').value='new@example.invalid';await submit();assert.equal(form.dataset.step,'profile');
 form.querySelector('[name=nickname]').value='@Sayonara';form.querySelector('[name=nickname]').dispatchEvent(new h.w.Event('input'));await submit();
 assert.equal(form.dataset.step,'password');assert.equal(form.querySelector('[name=nickname]').value,'sayonara');
 form.querySelector('[name=password]').value='new-private-password';await submit();
 assert.equal(form.dataset.step,'confirm');assert.equal(h.cloud.signUpInput.options.data.ncd_handle,'sayonara');assert.equal(h.cloud.signUpInput.options.data.username,'sayonara');
 assert.ok(h.cloud.authInput);assert.equal(form.querySelector('[name=password]').value,'');assert.equal(h.app.user,null);assert.equal(h.cloud.calls.length,0);
 assert.ok(!h.w.localStorage.getItem('goalTracker_data')?.includes('new-private-password'));
 await submit();assert.equal(form.dataset.step,'email');assert.ok(form.querySelector('[value=signin]').checked);
});
test('Taken nickname and unavailable lookup keep registration on the profile stage without calling signUp',async t=>{
 for(const state of [{takenHandles:['taken']},{handleError:true,handleLookupError:true}]){
  const h=fixture(t,{defaults:true,...state});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const form=h.d.querySelector('[data-cloud-auth]');
  form.querySelector('[name=email]').value='new@example.invalid';form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));form.querySelector('[name=nickname]').value='taken';
  form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));
  assert.equal(form.dataset.step,'profile');assert.equal(h.cloud.signUpInput,undefined);assert.ok(h.d.querySelector('[data-cloud-auth-status]').textContent);assert.equal(form.querySelector('[type=submit]').disabled,true);
 }
});
test('Nickname race is rechecked at final submission and returns to profile without a signup request',async t=>{
 const h=fixture(t,{defaults:true});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const form=h.d.querySelector('[data-cloud-auth]');
 form.querySelector('[name=email]').value='new@example.invalid';form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));form.querySelector('[name=nickname]').value='sayonara';form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));
 h.cloud.takenHandles=['sayonara'];form.querySelector('[name=password]').value='private-password';form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));
 assert.equal(form.dataset.step,'profile');assert.equal(h.cloud.signUpInput,undefined);assert.equal(form.querySelector('[name=password]').value,'');
});
test('Busy nickname check locks navigation and ignores a second submission',async t=>{
 let release;const h=fixture(t,{defaults:true,handleGate:new Promise(r=>release=r)});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const form=h.d.querySelector('[data-cloud-auth]');
 form.querySelector('[name=email]').value='new@example.invalid';form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));form.querySelector('[name=nickname]').value='sayonara';
 form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 assert.equal(h.cloud.handleFallbacks.length,1);assert.equal(h.d.querySelector('[data-auth-prev]').disabled,true);h.w.CloudSync.closeAuth();assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
 release();await new Promise(r=>setImmediate(r));assert.equal(form.dataset.step,'password');
});

test('First real session creates the initial profile and exits fullscreen entry without a pre-auth placeholder',async t=>{
 const h=fixture(t,{defaults:true});h.app.user=null;h.app.showAuth();assert.equal(h.app.user,null);assert.equal(h.d.getElementById('cloudAuthModal').dataset.entry,'true');
 await h.w.CloudSync.authenticate('test@example.invalid','fixture-password',false);await h.idle();
 assert.ok(h.app.user);assert.equal(h.app.user.nickname,'test');assert.equal(h.d.getElementById('app').style.display,'flex');assert.ok(!h.d.getElementById('cloudAuthModal').classList.contains('active'));assert.ok(!h.d.body.classList.contains('ncd-auth-open'));
});
test('New session signup uses the chosen handle for the local and owned cloud profile',async t=>{
 const session={user:{id:'11111111-1111-4111-8111-111111111111',email:'new@example.invalid',user_metadata:{ncd_handle:'sayonara'}}};
 const h=fixture(t,{signUpResult:{data:{session},error:null}});await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');
 await h.w.CloudSync.authenticate('new@example.invalid','private-password',true,{nickname:'sayonara'});await h.idle();
 assert.equal(h.app.user.nickname,'sayonara');assert.equal(h.cloud.signUpInput.options.data.ncd_handle,'sayonara');assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.profile.nickname,'sayonara');
});

test('Returning from a revealed password clears it and masks the next password entry',t=>{
 const h=fixture(t);h.w.CloudSync.openAuth();const form=h.d.querySelector('[data-cloud-auth]');
 form.querySelector('[name=email]').value='test@example.invalid';form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 const field=form.querySelector('[name=password]'),reveal=form.querySelector('[data-auth-show-password]');field.value='private-password';reveal.click();assert.equal(field.type,'text');
 form.querySelector('[data-auth-edit-email]').click();assert.equal(field.value,'');assert.equal(field.type,'password');assert.equal(reveal.getAttribute('aria-pressed'),'false');
 form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));assert.equal(form.dataset.step,'password');assert.equal(field.type,'password');
});

test('Logout clears the active profile and private DOM while retaining owner-scoped account data',async t=>{
 const h=fixture(t);await h.login();h.app.goals=[goal('private-goal','PRIVATE ACCOUNT A')];h.app.notes={'2030-01-01':[{id:'n',content:'PRIVATE NOTE'}]};h.w.finance.replaceData({transactions:[{id:'t',amount:99}],safetyFund:{balance:500}});await h.app.saveData();await h.w.CloudSync.sync();h.app.renderGoals();h.app.openGoalDetail('private-goal');
 for(const key of ['gt_goals','gt_finance','gt_calendar','gt_profile','gt_safety_fund','customAvatarData:old','gt-cloud-backup-v1:another','gt-cloud-conflict-backup-v1:another'])h.w.localStorage.setItem(key,'PRIVATE');
 await h.w.CloudSync.logout();assert.equal(h.app.user,null);assert.equal(h.app.goals.length,0);assert.equal(Object.keys(h.app.notes).length,0);assert.equal(h.w.finance.getData().transactions.length,0);assert.equal(h.w.finance.getData().safetyFund.balance,0);
 assert.doesNotMatch(h.d.body.textContent,/PRIVATE ACCOUNT A|PRIVATE NOTE/);assert.equal(h.d.getElementById('app').style.display,'none');assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
 for(const key of Object.keys(h.w.localStorage)){if(key.startsWith('gt-account-data-v1:')||['gt-supabase-config-v1','gt-session-locked-v1','theme','goalTracker_data'].includes(key))continue;assert.fail('Unexpected private cache '+key);}
 const stored=JSON.parse(h.w.localStorage.getItem('goalTracker_data'));assert.equal(stored.user,null);assert.equal(stored.goals.length,0);
});
test('Native logout clears Preferences and an obsolete SDK instance cannot recreate tokens',async t=>{
 const nativeStore=new Map();const h=fixture(t,{nativeStore,signOutError:true});await h.login();const oldStorage=h.cloud.options.auth.storage;
 for(const key of ['gt_goals','gt_finance','gt_calendar','gt_profile','gt_safety_fund','goalTracker_finance','goaltracker.supabase.tokens.fixture.supabase.co.access_token','goaltracker.supabase.tokens.fixture.supabase.co.refresh_token'])nativeStore.set(key,'PRIVATE');
 nativeStore.set('goalTracker_data',JSON.stringify({user:{nickname:'PRIVATE'}}));
 await h.w.CloudSync.logout();await new Promise(r=>setImmediate(r));await oldStorage.setItem('gt-supabase-auth:https://fixture.supabase.co','LATE TOKEN');
 assert.equal(h.app.user,null);assert.equal(h.w.CloudSync.accountConnection(),null);assert.equal(h.w.localStorage.getItem('gt-session-locked-v1'),'true');
 for(const [key,value]of nativeStore){if(key.startsWith('gt-account-data-v1:')){assert.doesNotMatch(value,/LATE TOKEN/);continue;}assert.ok(['goalTracker_data','gt-session-locked-v1','gt-supabase-config-v1','theme'].includes(key),key);assert.doesNotMatch(value,/PRIVATE|LATE TOKEN/);}
});
test('Offline logout clears the session and pending data without confirmation',async t=>{
 const h=fixture(t);await h.login();h.app.goals=[goal('pending-local')];await h.app.saveData();h.cloud.offline=true;h.online(false);
 h.w.confirm=()=>assert.fail('Logout must not ask for confirmation');
 await h.w.CloudSync.logout();assert.equal(h.app.user,null);assert.equal(h.app.goals.length,0);
 assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
 assert.equal(h.w.localStorage.getItem('gt-session-locked-v1'),'true');
});
test('Logout always runs a final sync and uploads current edits without confirmation',async t=>{
 const h=fixture(t);await h.login();const id=h.app.user.supabaseUserId;
 h.w.confirm=()=>assert.fail('Successful final sync must not ask for confirmation');
 h.app.goals=[goal('final-edit')];
 await h.w.CloudSync.logout();
 assert.equal(h.cloud.records[id].state.goals[0].id,'final-edit');assert.equal(h.app.user,null);
 await h.login();const calls=h.cloud.calls.length;
 await h.w.CloudSync.logout();
 assert.ok(h.cloud.calls.slice(calls).some(call=>call.name==='goals.select'));
});
test('Online sync failure cannot block logout or ask for confirmation',async t=>{
 const h=fixture(t);await h.login();h.app.goals=[goal('failed-upload')];await h.app.saveData();
 h.cloud.tableError='42501';h.cloud.failOperation='goals.upsert';
 h.w.confirm=()=>assert.fail('Logout must not ask for confirmation');
 await h.w.CloudSync.logout();assert.equal(h.app.user,null);assert.equal(h.app.goals.length,0);
 assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
});
test('Offline logout with no pending edits does not ask for confirmation',async t=>{
 const h=fixture(t);await h.login();h.online(false);
 h.w.confirm=()=>assert.fail('There are no pending edits to discard');
 await h.w.CloudSync.logout();assert.equal(h.app.user,null);
});
test('Logout waits for the current sync and never leaks account A data into account B',async t=>{
 const h=fixture(t);await h.login();h.app.goals=[goal('only-a')];await h.app.saveData();await h.w.CloudSync.sync();let release;h.cloud.readGate=new Promise(r=>release=r);
 const pending=h.w.CloudSync.sync();await new Promise(r=>setImmediate(r));const exit=h.w.CloudSync.logout();assert.equal(h.w.CloudSync.logout(),exit);assert.equal(h.app.user.supabaseUserId,'11111111-1111-4111-8111-111111111111');
 h.cloud.readGate=null;release();await pending;await exit;h.setUser('22222222-2222-4222-8222-222222222222');await h.w.CloudSync.authenticate('b@example.invalid','fixture-password',false);await h.idle();
 assert.equal(h.app.user.supabaseUserId,'22222222-2222-4222-8222-222222222222');assert.equal(h.app.goals.length,0);assert.ok(!JSON.stringify(h.cloud.records['22222222-2222-4222-8222-222222222222'].state).includes('only-a'));
});
test('Two devices pull the same cloud calendar, transactions, fund and profile, with all requests owner-scoped',async t=>{
 const cloud={records:{'11111111-1111-4111-8111-111111111111':{revision:1,present:['profiles','goals','user_profile','finance_transactions','safety_fund'],state:{goals:[goal('shared')],transactions:[{id:'shared-tx',amount:12,type:'income',category:'salary',date:'2030-01-01'}],safetyFund:{balance:120,history:[]},financeOther:{},profile:{nickname:'Shared'},calendar:{notes:{'2030-01-01':[{id:'shared-note',content:'Shared calendar'}]},events:[],achievements:[]}}}}};
 const desktop=fixture(t,cloud);await desktop.login();cloud.nativeStore=new Map();const mobile=fixture(t,cloud);await mobile.login();
 assert.deepEqual(copy(mobile.app.goals),copy(desktop.app.goals));assert.deepEqual(copy(mobile.app.notes),copy(desktop.app.notes));assert.deepEqual(copy(mobile.w.finance.getData()),copy(desktop.w.finance.getData()));assert.equal(mobile.app.user.nickname,'Shared');
 assert.ok(cloud.calls.every(call=>!call.user||call.user==='11111111-1111-4111-8111-111111111111'));assert.ok(cloud.calls.some(call=>call.name==='calendar_events.select'));
});
test('Legacy calendar fallback remains account-scoped until calendar_events migration is applied',async t=>{
 const h=fixture(t,{calendarMissing:true});await h.login();h.app.notes={'2030-01-01':[{id:'legacy',content:'Plan'}]};await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 const second=fixture(t,h.cloud);await second.login();assert.equal(second.app.notes['2030-01-01'][0].content,'Plan');assert.ok(h.cloud.calls.filter(c=>/calendar_events/.test(c.name)).every(c=>c.name.endsWith('.select')));
});
test('Calendar document writes include an ID for existing schemas that require one',async t=>{
 const h=fixture(t,{calendarRequiresId:true});await h.login();h.app.notes={'2030-01-01':[{id:'required-id',content:'Plan'}]};await h.app.saveData();
 assert.equal(await h.w.CloudSync.sync(),true);
 const write=h.cloud.calls.find(c=>c.name==='calendar_events.upsert');assert.match(write.payload.id,/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
 const second=fixture(t,h.cloud);await second.login();assert.equal(second.app.notes['2030-01-01'][0].content,'Plan');
});
test('Incompatible calendar row schema falls back to the user profile document without retrying bad inserts',async t=>{
 const h=fixture(t,{calendarRequiresTitle:true});await h.login();
 h.app.notes={'2030-01-01':[{id:'keep-calendar',content:'Plan'}]};await h.app.saveData();
 assert.equal(await h.w.CloudSync.sync(),true);
 assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.calendar.notes['2030-01-01'][0].content,'Plan');
 const writes=h.cloud.calls.filter(call=>call.name==='calendar_events.upsert').length;assert.equal(writes,1);
 assert.equal(await h.w.CloudSync.sync(),true);
 assert.equal(h.cloud.calls.filter(call=>call.name==='calendar_events.upsert').length,writes);
 const second=fixture(t,h.cloud);await second.login();assert.equal(second.app.notes['2030-01-01'][0].content,'Plan');
});
test('Contradictory cached owner/profile markers cannot import account A pending data into account B',async t=>{
 const h=fixture(t);await h.login();await h.w.CloudSync.logout();h.setUser('22222222-2222-4222-8222-222222222222');
 h.app.user={id:'old',supabaseUserId:'11111111-1111-4111-8111-111111111111',nickname:'A'};h.app.goals=[goal('stale-a')];h.w.localStorage.setItem('gt-supabase-owner-v1','https://fixture.supabase.co|22222222-2222-4222-8222-222222222222');
 h.w.localStorage.setItem('gt-cloud-pending-v1:https://fixture.supabase.co|22222222-2222-4222-8222-222222222222',JSON.stringify({base:h.w.CloudSyncCore.empty(),local:{...h.w.CloudSyncCore.empty(),goals:[goal('stale-a')]}}));
 await h.w.CloudSync.authenticate('b@example.invalid','fixture-password',false);await h.idle();assert.equal(h.app.goals.length,0);assert.equal(h.app.user.supabaseUserId,'22222222-2222-4222-8222-222222222222');
});
test('A failed durable erase still purges browser private data and keeps startup locked to authorization',async t=>{
 const h=fixture(t);await h.login();h.app.goals=[goal('private')];await h.app.saveData();h.cloud.failDisk=true;
 await assert.rejects(h.w.CloudSync.logout());await new Promise(r=>setImmediate(r));assert.equal(h.app.user,null);assert.equal(h.d.getElementById('app').style.display,'none');assert.equal(h.w.localStorage.getItem('gt-session-locked-v1'),'true');assert.equal(JSON.parse(h.w.localStorage.getItem('goalTracker_data')).user,null);
});

test('A failed first pull keeps the signed-in workspace open without an auth error',async t=>{
 const h=fixture(t,{defaults:true,tableError:'42501'});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth();const form=h.d.querySelector('[data-cloud-auth]');
 form.querySelector('[name=email]').value='test@example.invalid';form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));form.querySelector('[name=password]').value='private-password';form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await h.idle();
 assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.app.user.supabaseUserId,'11111111-1111-4111-8111-111111111111');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');assert.equal(form.querySelector('[name=password]').value,'');
});
test('A mismatched late token refresh cannot replace the active account SDK cache',async t=>{
 const h=fixture(t);await h.login();const storage=h.cloud.options.auth.storage,key='gt-supabase-auth:https://fixture.supabase.co';
 await storage.setItem(key,JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111'},access_token:'current'}));await storage.setItem(key,JSON.stringify({user:{id:'account-old'},access_token:'stale'}));
 assert.equal(JSON.parse(h.w.localStorage.getItem(key)).user.id,'11111111-1111-4111-8111-111111111111');
});

test('Nickname RPC failure falls back to profiles.handle without treating lookup errors as availability',async t=>{
 for(const occupied of [false,true]){
  const h=fixture(t,{defaults:true,handleError:true,takenHandles:occupied?['sayonara_76']:[]});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const f=h.d.querySelector('[data-cloud-auth]');
  f.querySelector('[name=email]').value='new@example.invalid';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));const n=f.querySelector('[name=nickname]');n.value='@sayonara_76';n.dispatchEvent(new h.w.Event('input',{bubbles:true}));
  assert.equal(n.type,'text');assert.equal(n.autocomplete,'off');assert.equal(n.getAttribute('autocapitalize'),'off');assert.equal(n.getAttribute('spellcheck'),'false');assert.equal(n.checkValidity(),true);
  assert.equal(f.querySelector('[name=email]').disabled,true);f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));assert.equal(f.dataset.step,occupied?'profile':'password');assert.deepEqual(h.cloud.handleFallbacks,['sayonara_76']);
 }
});
test('Login distinguishes invalid credentials, network failures and unconfirmed email',async t=>{
 for(const [error,message] of [[{code:'invalid_credentials',message:'Invalid login credentials'},'Invalid login credentials'],[{message:'Failed to fetch'},'Failed to fetch'],[{code:'email_not_confirmed',message:'Email not confirmed'},'Email not confirmed']]){
  const h=fixture(t,{defaults:true,signInError:error});await new Promise(r=>setImmediate(r));await assert.rejects(h.w.CloudSync.authenticate('test@example.invalid','wrong-password',false),{message});
 }
});

test('Successful signup without a returned session logs in with the submitted credentials automatically',async t=>{
 const h=fixture(t,{defaults:true});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const f=h.d.querySelector('[data-cloud-auth]');
 const submit=async()=>{f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));};
 f.querySelector('[name=email]').value='new@example.invalid';await submit();f.querySelector('[name=nickname]').value='newhandle';await submit();f.querySelector('[name=password]').value='private-password';await submit();await h.idle();
 assert.equal(h.cloud.authInput.email,'new@example.invalid');assert.equal(h.w.CloudSync.connectionState().state,'active');assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
});
test('Startup shows auth only for a missing session and keeps restored users inside on pull failure',async t=>{
 for(const state of [{},{initialSession:{user:{id:'11111111-1111-4111-8111-111111111111',email:'test@example.invalid'}},tableError:'42703'},{sessionError:true}]){
  const h=fixture(t,{defaults:true,...state});await new Promise(r=>setTimeout(r,30));assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');assert.equal(h.d.getElementById('app').style.display,state.initialSession?'flex':'none');
  assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),!state.initialSession&&!state.sessionError);
 }
});

test('Email step rejects missing TLD, malformed labels and local parts before advancing or calling Auth',async t=>{
 const h=fixture(t,{defaults:true});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const f=h.d.querySelector('[data-cloud-auth]'),email=f.querySelector('[name=email]');assert.equal(email.type,'email');
 for(const value of ['sayonarax778@gmail','a@','a@.com','a@-bad.com','a@bad..com','a..b@example.com','a b@example.com','a@example.c']){
  email.value=value;f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));assert.equal(f.dataset.step,'email');assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'Введите корректный email (например, you@example.com)');assert.equal(h.cloud.authInput,undefined);assert.equal(h.cloud.signUpInput,undefined);
 }
 email.value='you@example.com';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));assert.equal(f.dataset.step,'profile');
});
test('Short password shows an explicit inline error and never calls Supabase',async t=>{
 const h=fixture(t,{defaults:true});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signin'});const f=h.d.querySelector('[data-cloud-auth]');f.querySelector('[name=email]').value='you@example.com';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));f.querySelector('[name=password]').value='short';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 assert.equal(f.dataset.step,'password');assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'Пароль должен быть не менее 8 символов');assert.equal(h.cloud.authInput,undefined);assert.equal(f.querySelector('[name=password]').value,'short');
 await assert.rejects(h.w.CloudSync.authenticate('you@example.com','short',true),{message:'Пароль должен быть не менее 8 символов'});
});
test('Unhandled Supabase Auth messages are shown verbatim as text',async t=>{
 const h=fixture(t,{defaults:true,signInError:{code:'provider_failure',message:'Custom provider message'}});await new Promise(r=>setImmediate(r));await assert.rejects(h.w.CloudSync.authenticate('you@example.com','password-long',false),{message:'Custom provider message'});
});

test('Native sign-in and signup persist both session tokens before opening the workspace',async t=>{
 for(const signup of [false,true]){
  const nativeStore=new Map(),session={user:{id:'11111111-1111-4111-8111-111111111111',email:'you@example.com'},access_token:'native-access',refresh_token:'native-refresh'};
  const h=fixture(t,{nativeStore,signInSession:session,...(signup?{signUpResult:{data:{session},error:null}}:{})});await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');
  const result=await h.w.CloudSync.authenticate('you@example.com','password-long',signup);assert.equal(result.hydrated,true);assert.equal(nativeStore.get('goaltracker.supabase.tokens.fixture.supabase.co.access_token'),'native-access');assert.equal(nativeStore.get('goaltracker.supabase.tokens.fixture.supabase.co.refresh_token'),'native-refresh');assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
 }
});

test('Background signed-in, refresh, focus and reconnect events cannot put errors on a pristine auth screen',async t=>{
 for(const event of ['SIGNED_IN','TOKEN_REFRESHED','INITIAL_SESSION']){
  const h=fixture(t,{defaults:true,tableError:'42703'});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({entry:true});
  h.cloud.authCallback(event,{user:{id:'11111111-1111-4111-8111-111111111111',email:'test@example.invalid'}});await new Promise(r=>setTimeout(r,30));
  for(const name of ['focus','online']){h.w.dispatchEvent(new h.w.Event(name));await new Promise(r=>setTimeout(r,30));}
  assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');assert.equal(h.d.getElementById('app').style.display,'none');
 }
});
test('Opening authorization clears prior action errors',async t=>{
 const h=fixture(t,{defaults:true,signInError:{code:'invalid_credentials'}});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signin'});const f=h.d.querySelector('[data-cloud-auth]');f.querySelector('[name=email]').value='test@example.invalid';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));f.querySelector('[name=password]').value='wrong-password';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));assert.ok(h.d.querySelector('[data-cloud-auth-status]').textContent);h.w.CloudSync.openAuth({entry:true});assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');
});
test('Aborted login shows a readable error and allows another login after logout',async t=>{
 const h=fixture(t);await h.login();await h.w.CloudSync.logout();
 h.cloud.signInError={name:'AbortError',message:'signal is aborted without reason'};
 await assert.rejects(h.w.CloudSync.authenticate('test@example.invalid','fixture-password',false),/Проверьте подключение и повторите вход/);
 assert.equal(h.app.user,null);
 h.cloud.signInError=null;await h.login();
 assert.equal(h.app.user.supabaseUserId,'11111111-1111-4111-8111-111111111111');
});

test('Goal upsert sends only supported columns and decodes legacy JSON arrays',async t=>{
 const h=fixture(t);await h.login();const source={...goal('safe-payload'),progress:42,parent_id:null,deadline:'2030-01-01',createdAt:'2026-01-01',updated_at:'2026-01-01',targetAmount:100,currentAmount:20,isCompleted:false,unknown:'do not send',tags:JSON.stringify(['work']),subgoals:JSON.stringify([{id:'step',title:'Step',attachments:[{name:'a.pdf',url:'https://example.invalid/a.pdf'}]}])};
 h.app.goals=[source];await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);const call=h.cloud.calls.filter(c=>c.name==='goals.upsert').at(-1),row=call.payload[0];
 const allowed=new Set(['id','user_id','title','description','priority','category','status','progress','subgoals','tags','parent_id']);assert.ok(Object.keys(row).every(key=>allowed.has(key)));assert.equal(call.options.onConflict,'id');assert.equal(row.progress,42);assert.equal(row.parent_id,null);assert.deepEqual(row.tags,['work']);assert.equal(row.subgoals[0].attachments[0].name,'a.pdf');assert.equal(typeof source.tags,'string');assert.equal(typeof source.subgoals,'string');
});
test('Malformed goal JSON never reaches Supabase or overwrites remote goals',async t=>{
 const h=fixture(t);await h.login();
 for(const value of [{tags:'[broken'},{tags:'{"tag":"work"}'},{subgoals:'{"id":"step"}'},{subgoals:['broken']}]){
  h.app.goals=[{...goal('invalid-json'),...value}];await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),false);
 }
 assert.equal(h.cloud.calls.some(c=>c.name==='goals.upsert'),false);assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.length,0);
});

test('Email availability blocks existing accounts on step one and allows retry with a free email',async t=>{
 const h=fixture(t,{defaults:true,takenEmails:['taken@example.invalid']});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const f=h.d.querySelector('[data-cloud-auth]');
 const submit=async()=>{f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));};
 f.querySelector('[name=email]').value=' Taken@Example.invalid ';await submit();assert.equal(f.dataset.step,'email');assert.match(h.d.querySelector('[data-cloud-auth-status]').textContent,/Этот email уже зарегистрирован/);assert.equal(h.cloud.handleChecks,undefined);assert.equal(h.cloud.signUpInput,undefined);assert.equal(h.cloud.authInput,undefined);
 f.querySelector('[name=email]').value='free@example.invalid';await submit();assert.equal(f.dataset.step,'profile');assert.deepEqual(h.cloud.emailChecks,['taken@example.invalid','free@example.invalid']);
});
test('Missing email RPC and network failures strictly block registration on email',async t=>{
 for(const state of [{emailError:{code:'PGRST202'}},{emailError:{status:404}},{emailStatus:404},{emailError:{message:'Failed to fetch'}},{emailThrow:new TypeError('Failed to fetch')}]){
  const h=fixture(t,{defaults:true,...state});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const f=h.d.querySelector('[data-cloud-auth]');f.querySelector('[name=email]').value='free@example.invalid';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));assert.equal(f.dataset.step,'email');assert.equal(f.querySelector('[type=submit]').disabled,false);assert.ok(h.d.querySelector('[data-cloud-auth-status]').textContent);assert.equal(h.cloud.signUpInput,undefined);
 }
});
test('Unexpected email RPC permission failure stays visible rather than claiming availability',async t=>{
 const h=fixture(t,{defaults:true,emailError:{code:'42501'}});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const f=h.d.querySelector('[data-cloud-auth]');f.querySelector('[name=email]').value='free@example.invalid';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));assert.equal(f.dataset.step,'email');assert.ok(h.d.querySelector('[data-cloud-auth-status]').textContent);assert.equal(f.querySelector('[type=submit]').disabled,false);
});
test('Pending email check blocks duplicate submissions and navigation',async t=>{
 let release;const h=fixture(t,{defaults:true,emailGate:new Promise(r=>release=r)});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const f=h.d.querySelector('[data-cloud-auth]');f.querySelector('[name=email]').value='free@example.invalid';
 f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));assert.equal(h.cloud.emailChecks.length,1);assert.equal(f.querySelector('[value=signin]').disabled,true);h.w.CloudSync.closeAuth();assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
 release();await new Promise(r=>setImmediate(r));assert.equal(f.dataset.step,'profile');assert.equal(f.querySelector('[type=submit]').disabled,true);
});

test('Auth modal renders exact Supabase messages safely for failed login and signup',async t=>{
 for(const signup of [false,true]){
  const message='Invalid login credentials <b>provider detail</b>';
  const h=fixture(t,{defaults:true,...(signup?{signUpResult:{data:{},error:{code:'invalid_credentials',message}}}:{signInError:{code:'invalid_credentials',message}})});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:signup?'signup':'signin'});const f=h.d.querySelector('[data-cloud-auth]');
  const submit=async()=>{f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));};
  f.querySelector('[name=email]').value='you@example.com';await submit();if(signup){f.querySelector('[name=nickname]').value='newhandle';await submit();}f.querySelector('[name=password]').value='private-password';await submit();
  const status=h.d.querySelector('[data-cloud-auth-status]');assert.equal(status.textContent,message);assert.equal(status.querySelector('b'),null);assert.equal(f.dataset.step,'password');assert.equal(f.querySelector('[type=submit]').disabled,false);assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
 }
});

test('Fresh signup opens an empty workspace and creates the owned profile in the background',async t=>{
 const session={user:{id:'11111111-1111-4111-8111-111111111111',email:'new@example.invalid',user_metadata:{ncd_handle:'newhandle'}},access_token:'new-access',refresh_token:'new-refresh'};
 const nativeStore=new Map(),h=fixture(t,{profileIdSchema:true,nativeStore,signUpResult:{data:{session},error:null}});await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');
 const result=await h.w.CloudSync.authenticate('new@example.invalid','private-password',true,{nickname:'newhandle'});await h.idle();
 assert.equal(result.hydrated,true);assert.equal(h.w.CloudSync.connectionState().state,'active');assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
 assert.deepEqual(h.cloud.profileUpserts[0],{id:'11111111-1111-4111-8111-111111111111',username:'newhandle',handle:'newhandle'});assert.equal(h.app.user.nickname,'newhandle');assert.deepEqual(Array.from(h.app.goals),[]);assert.deepEqual(Array.from(h.app.events),[]);assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');
 assert.equal(nativeStore.get('goaltracker.supabase.tokens.fixture.supabase.co.access_token'),'new-access');assert.equal(nativeStore.get('goaltracker.supabase.tokens.fixture.supabase.co.refresh_token'),'new-refresh');
});
test('First login creates only a missing profile and preserves existing goals and calendar',async t=>{
 const h=fixture(t,{profileIdSchema:true});await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');const state=copy(h.w.CloudSyncCore.empty());state.goals=[goal('existing-goal')];h.cloud.records['11111111-1111-4111-8111-111111111111']={revision:0,state,present:['goals'],calendarDocument:{...state.calendar,events:[{id:'existing-event',title:'Keep',date:'2026-10-24'}]}};
 await h.w.CloudSync.authenticate('test@example.invalid','private-password',false);await h.idle();assert.equal(h.w.CloudSync.connectionState().state,'active');assert.equal(h.app.goals[0].id,'existing-goal');assert.equal(h.app.events[0].id,'existing-event');assert.equal(h.cloud.profileUpserts[0].id,'11111111-1111-4111-8111-111111111111');
});

test('Pristine auth startup, opening modes, focus and online never query account tables or handle RPC',async t=>{
 for(const initialSession of [null,{user:null}]){
  const h=fixture(t,{defaults:true,initialSession});await new Promise(r=>setTimeout(r,30));h.app.user=null;h.w.CloudSync.openAuth();h.w.CloudSync.openAuth({mode:'signup'});h.w.CloudSync.openAuth({mode:'signin'});
  h.w.dispatchEvent(new h.w.Event('focus'));h.w.dispatchEvent(new h.w.Event('online'));h.cloud.authCallback('INITIAL_SESSION',initialSession);await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(h.cloud.calls,[]);assert.equal(h.cloud.handleChecks,undefined);assert.equal(h.cloud.emailChecks,undefined);assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');assert.equal(h.d.getElementById('cloudAuthTitle').textContent,'Ваша почта');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),true);
 }
});
test('Handle availability selects only handle and verifies empty lookups without legacy RPC',async t=>{
 const h=fixture(t,{defaults:true,handleError:true,takenHandles:['occupied']});await new Promise(r=>setImmediate(r));
 assert.equal(await h.w.CloudSync.checkAuthNickname('freehandle'),true);assert.equal(await h.w.CloudSync.checkAuthNickname('occupied'),false);assert.equal(h.cloud.handleChecks,undefined);assert.deepEqual(h.cloud.handleSelections,['handle','handle']);assert.deepEqual(h.cloud.handleFallbacks,['freehandle','occupied']);
});

test('Sign-in tab and password typing do not load account data or show a prior load failure',async t=>{
 const h=fixture(t,{defaults:true,tableError:'42501'});await new Promise(r=>setImmediate(r));await h.w.CloudSync.authenticate('test@example.invalid','private-password',false);await h.idle();assert.equal(h.w.CloudSync.connectionState().state,'load_error');
 h.w.CloudSync.openAuth({mode:'signup'});const f=h.d.querySelector('[data-cloud-auth]');f.querySelector('[value=signin]').click();const before=h.cloud.calls.length;
 f.querySelector('[name=email]').value='test@example.invalid';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));assert.equal(f.dataset.step,'password');f.querySelector('[name=password]').value='typing-password';f.querySelector('[name=password]').dispatchEvent(new h.w.Event('input',{bubbles:true}));
 h.cloud.authCallback('SIGNED_IN',{user:{id:'11111111-1111-4111-8111-111111111111',email:'test@example.invalid'}});h.w.dispatchEvent(new h.w.Event('focus'));h.w.dispatchEvent(new h.w.Event('online'));await new Promise(r=>setTimeout(r,30));
 assert.equal(h.cloud.calls.length,before);assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');assert.equal(f.dataset.step,'password');
 delete h.cloud.authInput;h.cloud.signInError={code:'invalid_credentials',message:'Invalid login credentials'};f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await h.idle();assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');assert.equal(h.cloud.authInput,undefined);assert.equal(h.d.getElementById('app').style.display,'flex');
});

test('Strict email check uses check_email and blocks occupied email with the requested text',async t=>{
 const h=fixture(t,{defaults:true,takenEmails:['taken@example.invalid']});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signup'});const f=h.d.querySelector('[data-cloud-auth]');f.querySelector('[name=email]').value='taken@example.invalid';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));
 assert.deepEqual(h.cloud.emailChecks,['taken@example.invalid']);assert.equal(f.dataset.step,'email');assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,"Этот email уже зарегистрирован. Перейдите во вкладку 'Войти'");assert.equal(h.cloud.handleChecks,undefined);assert.equal(h.cloud.signUpInput,undefined);
});
test('Successful login opens before a slow failing sync and preserves edits in the owned outbox',async t=>{
 let release;const h=fixture(t,{defaults:true,readGate:new Promise(r=>release=r),tableError:'42501'});await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth();
 const login=h.w.CloudSync.authenticate('you@example.com','private-password',false);await new Promise(r=>setImmediate(r));assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);assert.equal(h.app._accountTransition,false);
 h.app.goals=[goal('during-sync')];await h.app.saveData();release();await login;assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);assert.equal(h.app.goals[0].id,'during-sync');assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');
 const pending=JSON.parse(h.w.localStorage.getItem('gt-cloud-pending-v1:https://kvyhbbctpyeoikjqhubu.supabase.co|11111111-1111-4111-8111-111111111111'));assert.equal(pending.local.goals[0].id,'during-sync');
 h.cloud.tableError=null;await h.w.CloudSync.authenticate('you@example.com','private-password',false);await h.idle();assert.equal(h.app.goals[0].id,'during-sync');
});
test('Edits made while initial sync is slow merge with existing remote goals',async t=>{
 let release;const h=fixture(t,{readGate:new Promise(r=>release=r)});await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');const state=copy(h.w.CloudSyncCore.empty());state.goals=[goal('remote')];h.cloud.records['11111111-1111-4111-8111-111111111111']={revision:1,state};
 const login=h.w.CloudSync.authenticate('test@example.invalid','private-password',false);await new Promise(r=>setImmediate(r));h.app.goals=[goal('local')];await h.app.saveData();release();await login;await h.idle();assert.deepEqual(Array.from(h.app.goals,g=>g.id).sort(),['local','remote']);
});

test('Sign-in form completes while post-login cloud requests are still pending',async t=>{
 let release;const h=fixture(t,{defaults:true,readGate:new Promise(r=>release=r),tableError:'42501'});
 await new Promise(r=>setImmediate(r));h.w.CloudSync.openAuth({mode:'signin'});
 const f=h.d.querySelector('[data-cloud-auth]');
 f.querySelector('[name=email]').value='you@example.com';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 f.querySelector('[name=password]').value='private-password';f.dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 try {
  await new Promise(r=>setImmediate(r));
  assert.equal(h.d.getElementById('app').style.display,'flex');
  assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
  assert.equal(f.hasAttribute('aria-busy'),false);
  assert.equal(f.querySelector('[type=submit]').disabled,false);
 } finally {release();}
 await h.idle();
 assert.equal(h.d.getElementById('app').style.display,'flex');
 assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');
});

test('Every profile upsert verifies the authenticated UUID and sends only owned schema fields',async t=>{
 const h=fixture(t);await h.login();
 assert.ok(h.cloud.userChecks>0);assert.ok(h.cloud.profileUpserts.length>0);
 for(const payload of h.cloud.profileUpserts){
  assert.equal(payload.id,'11111111-1111-4111-8111-111111111111');
  assert.ok(Object.keys(payload).every(key=>['id','username','handle','data'].includes(key)));
 }
 h.cloud.profileUpserts=[];await h.w.CloudSync.saveAccountProfile('NewName');
 assert.equal(h.cloud.profileUpserts[0].username,'NewName');
});
test('Missing, invalid or mismatched verified user never triggers profile upsert or blocks entry',async t=>{
 for(const state of [{noUser:true},{userError:{code:'network_error'}},{verifiedUser:{id:'invalid-id'}},{verifiedUser:{id:'22222222-2222-4222-8222-222222222222'}}]){
  const h=fixture(t,state);await h.login();
  assert.equal(h.cloud.calls.some(call=>call.name==='profiles.upsert'),false);
  assert.equal(h.d.getElementById('app').style.display,'flex');
  assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
 }
});
test('A rejected profiles upsert stays in the background after successful sign-in',async t=>{
 const h=fixture(t,{tableError:'PGRST204',failOperation:'profiles.upsert'});await h.login();
 assert.equal(h.d.getElementById('app').style.display,'flex');
 assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
 assert.equal(h.d.querySelector('[data-cloud-auth-status]').textContent,'');
});

test('Profile schema rejection is caught and repeated sync cannot spam the same upsert',async t=>{
 const h=fixture(t,{tableError:'PGRST204',failOperation:'profiles.upsert'});await h.login();
 const attempts=()=>h.cloud.calls.filter(call=>call.name==='profiles.upsert').length;
 assert.equal(attempts(),1);
 await h.w.CloudSync.authenticate('test@example.invalid','private-password',false);await h.idle();
 assert.equal(attempts(),1);
 assert.equal(h.w.CloudSync.accountConnection().userId,'11111111-1111-4111-8111-111111111111');
 assert.equal(h.d.getElementById('app').style.display,'flex');
});

test('Cold startup restores SDK session without local profile or auth flash before slow failing hydration',async t=>{
 let release;const h=fixture(t,{defaults:true,startup:true,initialSession:{user:{id:'11111111-1111-4111-8111-111111111111',email:'saved@example.invalid'}},readGate:new Promise(r=>release=r),tableError:'42501'});
 try {
  assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
  await new Promise(r=>setImmediate(r));
  assert.equal(h.d.getElementById('app').style.display,'flex');
  assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
  assert.equal(h.cloud.authInput,undefined);
  assert.equal(h.w.CloudSync.accountConnection().userId,'11111111-1111-4111-8111-111111111111');
 } finally {release();}
 await h.idle();assert.equal(h.d.getElementById('app').style.display,'flex');
});
test('Session retrieval failure keeps splash instead of asking for credentials and recovers on focus',async t=>{
 const h=fixture(t,{defaults:true,startup:true,sessionError:true,initialSession:{user:{id:'11111111-1111-4111-8111-111111111111',email:'saved@example.invalid'}}});
 await new Promise(r=>setImmediate(r));
 assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
 assert.equal(h.d.getElementById('native-splash').style.display,'flex');
 h.cloud.sessionError=false;h.w.dispatchEvent(new h.w.Event('focus'));await h.idle();
 assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.cloud.authInput,undefined);
});

test('Restored owned offline cache remains visible if the cloud cannot load',async t=>{
 const h=fixture(t,{defaults:true,startup:true,initialSession:{user:{id:'11111111-1111-4111-8111-111111111111',email:'saved@example.invalid'}},tableError:'42501'});
 h.app.user={id:'11111111-1111-4111-8111-111111111111',supabaseUserId:'11111111-1111-4111-8111-111111111111',nickname:'Cached'};
 h.app.goals=[goal('cached-goal')];
 h.w.localStorage.setItem('gt-cloud-owner-v1','https://kvyhbbctpyeoikjqhubu.supabase.co|11111111-1111-4111-8111-111111111111');
 await h.idle();assert.equal(h.app.user.nickname,'Cached');assert.equal(h.app.goals[0].id,'cached-goal');assert.equal(h.d.getElementById('app').style.display,'flex');
});
test('Explicit native logout lock keeps startup on auth even if SDK has a previous session',async t=>{
 const h=fixture(t,{defaults:true,startup:true,nativeStore:new Map([['gt-session-locked-v1','true']]),initialSession:{user:{id:'11111111-1111-4111-8111-111111111111',email:'saved@example.invalid'}}});
 await h.idle();assert.equal(h.d.getElementById('app').style.display,'none');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),true);assert.equal(h.w.CloudSync.accountConnection(),null);
});

test('Native registered Preferences proxy restores login after a fresh WebView with empty localStorage',async t=>{
 const nativeStore=new Map();const first=fixture(t,{defaults:true,nativeStore,bridgeOnly:true,useSDKStorage:true});
 await new Promise(r=>setImmediate(r));await first.w.CloudSync.authenticate('test@example.invalid','private-password',false);await first.idle();
 const key='goaltracker.supabase.gt-supabase-auth:https://kvyhbbctpyeoikjqhubu.supabase.co';assert.ok(nativeStore.has(key));
 const second=fixture(t,{defaults:true,startup:true,nativeStore,bridgeOnly:true,useSDKStorage:true});await second.idle();
 assert.equal(second.d.getElementById('app').style.display,'flex');assert.equal(second.d.getElementById('cloudAuthModal').classList.contains('active'),false);assert.equal(second.cloud.authInput,undefined);
 await second.w.CloudSync.logout();assert.equal(nativeStore.has(key),false);
 const third=fixture(t,{defaults:true,startup:true,nativeStore,bridgeOnly:true,useSDKStorage:true});await third.idle();assert.equal(third.d.getElementById('cloudAuthModal').classList.contains('active'),true);
});
test('Desktop SDK storage restores login across a new application instance',async t=>{
 const first=fixture(t,{defaults:true,useSDKStorage:true});await new Promise(r=>setImmediate(r));await first.w.CloudSync.authenticate('test@example.invalid','private-password',false);await first.idle();
 const browserStorage=Object.fromEntries(Object.keys(first.w.localStorage).map(key=>[key,first.w.localStorage.getItem(key)]));
 const second=fixture(t,{defaults:true,startup:true,useSDKStorage:true,browserStorage});await second.idle();
 assert.equal(second.d.getElementById('app').style.display,'flex');assert.equal(second.d.getElementById('cloudAuthModal').classList.contains('active'),false);assert.equal(second.cloud.authInput,undefined);
});
test('SDK session deletion and SIGNED_OUT without explicit logout retain durable login',async t=>{
 const h=fixture(t,{defaults:true,nativeStore:new Map(),bridgeOnly:true,useSDKStorage:true});await new Promise(r=>setImmediate(r));await h.w.CloudSync.authenticate('test@example.invalid','private-password',false);await h.idle();
 const storage=h.cloud.options.auth.storage,key=h.cloud.options.auth.storageKey,before=await storage.getItem(key);
 await storage.removeItem(key);h.cloud.authCallback('SIGNED_OUT',null);await new Promise(r=>setTimeout(r,10));
 assert.equal(await storage.getItem(key),before);assert.notEqual(h.w.localStorage.getItem('gt-session-locked-v1'),'true');assert.equal(h.d.getElementById('app').style.display,'flex');
});

test('An active restored session never repeats password authentication or signup',async t=>{
 const h=fixture(t,{defaults:true,startup:true,initialSession:{user:{id:'11111111-1111-4111-8111-111111111111',email:'saved@example.invalid'}}});await h.idle();
 h.cloud.signInError={code:'invalid_credentials'};
 for(const signup of [false,true]){
  const result=await h.w.CloudSync.authenticate('saved@example.invalid','',signup);await h.idle();
  assert.equal(result.confirmationRequired,false);assert.equal(h.cloud.authInput,undefined);assert.equal(h.cloud.signUpInput,undefined);
  assert.equal(h.d.getElementById('app').style.display,'flex');
 }
});
test('Signup fallback reuses the SDK session instead of another password grant',async t=>{
 const sdkSignupSession={user:{id:'11111111-1111-4111-8111-111111111111',email:'new@example.invalid'}};
 const h=fixture(t,{defaults:true,sdkSignupSession,signUpResult:{data:{session:null,user:{identities:[{id:'new'}]}},error:null}});await new Promise(r=>setImmediate(r));
 const result=await h.w.CloudSync.authenticate('new@example.invalid','private-password',true,{nickname:'newhandle'});await h.idle();
 assert.equal(result.confirmationRequired,false);assert.equal(h.cloud.authInput,undefined);assert.ok(h.cloud.signUpInput);
});

test('Legacy profile with a non-Latin display name gets a stable searchable handle',async t=>{
 const h=fixture(t,{defaults:true,startup:true,initialSession:{user:{id:'11111111-1111-4111-8111-111111111111',email:'123@example.invalid',user_metadata:{nickname:'Имя профиля'}}}});await h.idle();
 assert.deepEqual(h.cloud.profileUpserts[0],{id:'11111111-1111-4111-8111-111111111111',username:'Имя профиля',handle:'user_111111111111411181111111111'});
});

test('Persisted account opens from local cache before SDK session refresh or cloud responds',async t=>{
 let refresh,read;const stored={user:{id:'11111111-1111-4111-8111-111111111111',email:'saved@example.invalid'},access_token:'saved-access',refresh_token:'saved-refresh'};
 const key='gt-supabase-auth:https://kvyhbbctpyeoikjqhubu.supabase.co';
 const h=fixture(t,{defaults:true,startup:true,initialSession:stored,browserStorage:{[key]:JSON.stringify(stored)},sessionGate:new Promise(r=>refresh=r),readGate:new Promise(r=>read=r)});
 h.app.user={id:stored.user.id,supabaseUserId:stored.user.id,nickname:'Cached'};h.app.goals=[goal('cached')];
 try {
  await new Promise(r=>setImmediate(r));assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.app.goals[0].id,'cached');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
 } finally {refresh();read();}
 await h.idle();
});
test('Owned cache opens without waiting for a local disk save',async t=>{
 let release;const h=fixture(t,{defaults:true,startup:true,initialSession:{user:{id:'11111111-1111-4111-8111-111111111111',email:'saved@example.invalid'}},saveGate:new Promise(r=>release=r)});
 h.app.user={id:'11111111-1111-4111-8111-111111111111',supabaseUserId:'11111111-1111-4111-8111-111111111111',nickname:'Cached'};h.app.goals=[goal('cached')];
 try {await new Promise(r=>setImmediate(r));assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.app.goals[0].id,'cached');}
 finally {release();}
 await h.idle();
});
test('Account startup timeout keeps the workspace open while an independent goals retry preserves local edits',async t=>{
 let release;const h=fixture(t,{defaults:true,startup:true,initialSession:{user:{id:'11111111-1111-4111-8111-111111111111',email:'saved@example.invalid'}},readGate:new Promise(r=>release=r)});
 h.app.user={id:'11111111-1111-4111-8111-111111111111',supabaseUserId:'11111111-1111-4111-8111-111111111111',nickname:'Cached'};h.app.goals=[goal('cached')];
 try {
  await new Promise(r=>setImmediate(r));assert.equal(h.d.getElementById('app').style.display,'flex');
  h.app.goals.push(goal('edit-during-timeout'));await h.app.saveData();
  await new Promise(r=>setTimeout(r,2650));assert.equal(h.w.CloudSync.connectionState().state,'load_error');assert.equal(h.d.getElementById('app').style.display,'flex');
  release();await h.idle();assert.deepEqual(h.app.goals.map(g=>g.id),['cached','edit-during-timeout']);assert.equal(h.cloud.profileUpserts,undefined);
 } finally {release();}
});

test('App init renders the owned local cache before attaching cloud initialization',async t=>{
 const h=fixture(t,{defaults:true});await h.idle();
 h.app.user={id:'11111111-1111-4111-8111-111111111111',supabaseUserId:'11111111-1111-4111-8111-111111111111',nickname:'Cached'};
 h.w.localStorage.setItem('gt-cloud-owner-v1','https://kvyhbbctpyeoikjqhubu.supabase.co|11111111-1111-4111-8111-111111111111');
 h.app.loadData=()=>{};h.app.bindEvents=()=>{};h.app.initTheme=()=>{};
 assert.equal(h.w.CloudSync.canOpenCachedAccount(h.app.user),true);
 h.app.showAccountLoading();let attached=false;
 h.w.CloudSync.attach=()=>{attached=true;assert.equal(h.d.getElementById('app').style.display,'flex');};
 h.app.init();assert.equal(attached,true);
});


test('Native splash hide cannot block local UI even when the plugin never resolves',async t=>{
 const h=fixture(t,{defaults:true});await h.idle();
 let calls=0;
 h.w.Capacitor={Plugins:{SplashScreen:{hide(){calls++;return new Promise(()=>{});}}}};
 h.app.showAccountLoading();
 h.app.showApp();
 assert.equal(calls,0);
 assert.equal(h.d.getElementById('app').style.display,'flex');
});

async function openNicknameStep(h) {
 await new Promise(r=>setImmediate(r)); h.w.CloudSync.openAuth({mode:'signup'});
 const form=h.d.querySelector('[data-cloud-auth]');form.querySelector('[name=email]').value='new@example.invalid';
 form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));return form;
}
function typeNickname(h,form,value) { const input=form.querySelector('[name=nickname]');input.value=value;input.dispatchEvent(new h.w.Event('input'));return input; }
const liveWait=()=>new Promise(r=>setTimeout(r,360));
test('Live handle lookup blocks pending/taken names, marks errors and enables a free name',async t=>{
 const h=fixture(t,{defaults:true,takenHandles:['occupied']});const form=await openNicknameStep(h),button=form.querySelector('[type=submit]');
 assert.equal(button.disabled,true);const input=typeNickname(h,form,'@Occupied');assert.equal(button.disabled,true);await liveWait();
 assert.equal(input.value,'occupied');assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(button.disabled,true);
 assert.equal(h.d.querySelector('[data-nickname-status]').textContent,'Этот никнейм уже занят. Придумайте другой');
 typeNickname(h,form,'free_handle');assert.equal(button.disabled,true);await liveWait();assert.equal(button.disabled,false);assert.equal(input.getAttribute('aria-invalid'),'false');
 assert.deepEqual(h.cloud.handleFallbacks,['occupied','free_handle']);assert.deepEqual(h.cloud.handleSelections,['handle','handle']);
 h.cloud.handleLookupError=true;typeNickname(h,form,'another');await liveWait();assert.equal(button.disabled,true);assert.match(h.d.querySelector('[data-nickname-status]').textContent,/Проверьте подключение/);
});
test('Late live lookup cannot authorize a different handle or override a newer result',async t=>{
 let release;const h=fixture(t,{defaults:true,handleLookup:value=>value==='slow_name'?new Promise(r=>release=r):Promise.resolve({data:{handle:value},error:null})});const form=await openNicknameStep(h);
 typeNickname(h,form,'slow_name');await liveWait();typeNickname(h,form,'occupied');await liveWait();
 release({data:null,error:null});await new Promise(r=>setImmediate(r));assert.equal(form.querySelector('[type=submit]').disabled,true);assert.match(h.d.querySelector('[data-nickname-status]').textContent,/уже занят/);
});
test('Debounced invalid names never query Supabase and leave Continue disabled',async t=>{
 const h=fixture(t,{defaults:true});const form=await openNicknameStep(h);
 typeNickname(h,form,'old_name');typeNickname(h,form,'x');await liveWait();assert.equal(h.cloud.handleFallbacks,undefined);assert.equal(form.querySelector('[type=submit]').disabled,true);
});
test('Separate accounts on separate devices expose their own persisted handle',async t=>{
 for (const [id,handle] of [['11111111-1111-4111-8111-111111111111','first_handle'],['22222222-2222-4222-8222-222222222222','second_handle']]) {
  const h=fixture(t,{defaults:true,signInSession:{user:{id,email:handle+'@example.invalid',user_metadata:{ncd_handle:handle}}}});await h.login();
  assert.equal(h.app.user.handle,handle);assert.equal(h.w.CloudSync.accountConnection().handle,handle);assert.equal(h.w.CloudSync.accountConnection().userId,id);
 }
});

test('RLS-hidden profiles cannot make a taken handle appear available',async t=>{
 const h=fixture(t,{defaults:true,takenHandles:['hidden_name'],handleLookup:async()=>({data:null,error:null})});
 assert.equal(await h.w.CloudSync.checkAuthNickname('hidden_name'),false);assert.deepEqual(h.cloud.handleVerifications,['hidden_name']);
 h.cloud.verificationError=true;await assert.rejects(h.w.CloudSync.checkAuthNickname('free_name'),/недоступна/);
});
test('Permission-restricted profile lookup verifies through the safe availability RPC',async t=>{
 const h=fixture(t,{defaults:true,takenHandles:['occupied'],handleLookup:async()=>({data:null,error:{code:'42501'}})});
 assert.equal(await h.w.CloudSync.checkAuthNickname('occupied'),false);assert.equal(await h.w.CloudSync.checkAuthNickname('free_name'),true);
});

test('Player Tag comes from the owned server profile and survives a second device login',async t=>{
 const shared={generatedTag:'#C2UJ2Q2C'};const first=fixture(t,shared);await first.login();
 assert.equal(first.app.user.shortId,'#C2UJ2Q2C');assert.equal(first.w.CloudSync.accountConnection().shortId,'#C2UJ2Q2C');
 assert.ok(shared.profileUpserts.every(payload=>!Object.hasOwn(payload,'short_id')));
 const second=fixture(t,shared);await second.login();assert.equal(second.w.CloudSync.accountConnection().shortId,'#C2UJ2Q2C');
 second.app.user={id:'another-owner',supabaseUserId:'another-owner',shortId:'#OTHER123'};
 assert.equal(second.w.CloudSync.accountConnection().shortId,null);
});

test('Production profile queries filter profiles.id and select valid column strings without aliases',async t=>{
 const h=fixture(t,{profileIdSchema:true});await h.login();
 assert.ok(h.cloud.projections.length>0);assert.ok(h.cloud.readFilters.some(filter=>filter.table==='profiles'));
 for(const filter of h.cloud.readFilters.filter(filter=>filter.table==='profiles'))assert.equal(filter.column,'id');
 for(const projection of h.cloud.projections){assert.equal(typeof projection.selected,'string');assert.doesNotMatch(projection.selected,/:|\[object Object\]/);}
});

test('Finance writes separate rows with unique IDs and onConflict id, then updates/deletes only those IDs',async t=>{
 const h=fixture(t);await h.login();
 h.w.finance.replaceData({transactions:[{id:'first-tx',type:'income',amount:100,category:'salary',description:'A',date:'2030-01-01'},{id:'second-tx',type:'expense',amount:25,category:'food',description:'B',date:'2030-01-02'}]});
 await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 const writes=h.cloud.calls.filter(call=>call.name==='finance_transactions.upsert');assert.ok(writes.length);
 for(const call of writes){assert.equal(call.options.onConflict,'id');assert.ok(Array.isArray(call.payload));assert.ok(call.payload.every(row=>row.id&&row.user_id===h.app.user.supabaseUserId&&!Object.hasOwn(row,'data')));}
 assert.equal(h.cloud.records[h.app.user.supabaseUserId].state.transactions.length,2);
 const data=h.w.finance.getData();data.transactions[1].amount=30;data.transactions.shift();h.w.finance.replaceData(data);await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 assert.deepEqual(h.cloud.records[h.app.user.supabaseUserId].state.transactions.map(row=>[row.id,row.amount]),[['second-tx',30]]);
 assert.ok(h.cloud.calls.some(call=>call.name==='finance_transactions.delete'&&call.id==='first-tx'&&call.user===h.app.user.supabaseUserId));
});
test('Transaction reads paginate beyond 500 rows and all profile projections contain only the supported columns',async t=>{
 const id='11111111-1111-4111-8111-111111111111';const h=fixture(t,{records:{[id]:{revision:1,state:{...{goals:[],transactions:[],safetyFund:{},financeOther:{},calendar:{},profile:{nickname:'Many'}},transactions:Array.from({length:520},(_,i)=>({id:'tx-'+String(i).padStart(4,'0'),amount:i,type:'income'}))}}}});await h.login();
 assert.equal(h.w.finance.getData().transactions.length,520);
 for(const projection of h.cloud.projections.filter(row=>row.table==='profiles'))for(const field of projection.selected.split(','))assert.ok(['*','id','username','handle','short_id','extra'].includes(field));
});
test('Fresh profile ID loads even while financial hydration has not completed',async t=>{
 let release;const id='11111111-1111-4111-8111-111111111111';
 const h=fixture(t,{defaults:true,financeReadGate:new Promise(resolve=>release=resolve),records:{[id]:{revision:1,handle:'fresh_handle',shortId:'#XXXXXX76',state:{goals:[],transactions:[],safetyFund:{},financeOther:{},calendar:{},profile:{nickname:'Fresh'}}}}});
 let timer,listener;
 const loaded=new Promise((resolve,reject)=>{
  listener=event=>{if(event.detail?.shortId==='#XXXXXX76'){clearTimeout(timer);resolve();}};
  h.d.addEventListener('goaltracker:player-tag',listener);
  timer=setTimeout(()=>reject(new Error('Fresh profile did not arrive before finance hydration')),1500);
 });
 try {const login=h.w.CloudSync.authenticate('test@example.invalid','fixture-password',false);await loaded;
  assert.equal(h.app.user.shortId,'#XXXXXX76');release();await login;await h.idle();
  h.app.user.shortId='#STALE123';assert.equal((await h.w.CloudSync.fetchProfile()).short_id,'#XXXXXX76');assert.equal(h.app.user.shortId,'#XXXXXX76');
 }finally{release();clearTimeout(timer);h.d.removeEventListener('goaltracker:player-tag',listener);}
});

test('Duplicate transaction IDs are rejected without uploading or losing local entries',async t=>{
 const h=fixture(t);await h.login();const before=h.cloud.calls.filter(call=>call.name==='finance_transactions.upsert').length;
 h.w.finance.replaceData({transactions:[{id:'duplicate',type:'income',amount:10},{id:'duplicate',type:'expense',amount:2}]});await h.app.saveData();
 assert.equal(await h.w.CloudSync.sync(),false);assert.equal(h.cloud.calls.filter(call=>call.name==='finance_transactions.upsert').length,before);
 assert.equal(h.w.finance.getData().transactions.length,2);
});
test('Per-transaction upsert preserves another row created by a competing device',async t=>{
 const h=fixture(t);await h.login();h.w.finance.replaceData({transactions:[{id:'local-tx',type:'income',amount:10}]});await h.app.saveData();
 h.cloud.beforeWrite=async record=>{record.state.transactions.push({id:'concurrent-tx',type:'expense',amount:3});};
 assert.equal(await h.w.CloudSync.sync(),true);assert.deepEqual(h.cloud.records[h.app.user.supabaseUserId].state.transactions.map(row=>row.id).sort(),['concurrent-tx','local-tx']);
});

test('One exported Supabase instance is reused across configuration, logout/login and bundle reevaluation',async t=>{
 const h=fixture(t);await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');const sdk=h.w.supabaseClient;
 await h.w.CloudSync.configure('https://fixture.supabase.co','sb_publishable_fixture');assert.equal(h.cloud.clientCreations,1);
 await h.login();assert.equal(h.w.CloudSync.authClient(),sdk);assert.equal(h.w.CloudSync.client,sdk);
 await h.w.CloudSync.logout();await new Promise(resolve=>setImmediate(resolve));await h.login();assert.equal(h.w.supabaseClient,sdk);assert.equal(h.w.CloudSync.authClient(),sdk);assert.equal(h.cloud.clientCreations,1);
 const api=h.w.CloudSync;h.w.eval(sync);assert.equal(h.w.CloudSync,api);assert.equal(h.cloud.clientCreations,1);
});
test('Opening settings hides Player Tag and does not request it',async t=>{
 const h=fixture(t);await h.login();
 const before=h.cloud.profileSingleReads||0;h.app.openSettingsModal();await h.idle();
 assert.equal(h.d.getElementById('settingsPlayerTag'),null);
 assert.equal(h.cloud.profileSingleReads||0,before);
});

test('An older profile response cannot replace a newer direct Player Tag read',async t=>{
 const h=fixture(t);await h.login();let release,count=0;
 h.cloud.profileReply=async()=>++count===1?new Promise(resolve=>release=()=>resolve({data:{short_id:stalePlayerTag()},error:null})):{data:{short_id:'#XXXXXX76'},error:null};
 const older=h.w.CloudSync.fetchPlayerTag();await new Promise(resolve=>setImmediate(resolve));
 await h.w.CloudSync.fetchPlayerTag();release();await older;
 assert.equal(h.app.user.shortId,'#XXXXXX76');assert.equal(h.w.CloudSync.currentPlayerTag().shortId,'#XXXXXX76');assert.equal(h.cloud.clientCreations,1);
});

test('A newer failed profile request cannot suppress a successful fresh ID read already in flight',async t=>{
 const h=fixture(t);await h.login();let release,count=0;
 h.cloud.profileReply=async()=>++count===1?new Promise(resolve=>release=()=>resolve({data:{short_id:'#XXXXXX76'},error:null})):{data:null,error:{code:'FETCH_ERROR'}};
 const reading=h.w.CloudSync.fetchPlayerTag();await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(h.w.CloudSync.fetchPlayerTag());release();const data=await reading;
 assert.equal(data.short_id,'#XXXXXX76');assert.equal(h.app.user.shortId,'#XXXXXX76');assert.equal(h.w.CloudSync.currentPlayerTag().shortId,'#XXXXXX76');
});

test('A missing finance column preserves local operations in the account document without changing the legacy table',async t=>{
 const h=fixture(t);await h.login();h.w.finance.replaceData({transactions:[{id:'unsaved-local',type:'income',amount:50}]});await h.app.saveData();
 h.cloud.tableError='42703';h.cloud.failOperation='finance_transactions.select';
 const writes=()=>h.cloud.calls.filter(call=>/^finance_transactions\.(upsert|update|delete)$/.test(call.name)).length;
 const before=writes();
 assert.equal(await h.w.CloudSync.sync(),true);assert.equal(h.w.finance.getData().transactions[0].id,'unsaved-local');
 assert.equal(writes(),before);assert.equal(h.cloud.records[h.app.user.supabaseUserId].profileSync.transactions[0].id,'unsaved-local');
 assert.equal(h.d.getElementById('app').style.display,'flex');
 for(const projection of h.cloud.projections.filter(item=>item.table==='finance_transactions'))assert.equal(projection.selected.includes('data'),false);
});
test('An account with an unavailable finance column opens an empty finance list and still loads its Player Tag',async t=>{
 const id='11111111-1111-4111-8111-111111111111';const h=fixture(t,{tableError:'42703',failOperation:'finance_transactions.select',records:{[id]:{revision:1,handle:'player_one',shortId:'#XXXXX276',state:{goals:[],transactions:[],safetyFund:{},financeOther:{},calendar:{},profile:{nickname:'Player'}}}}});await h.login();
 assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.w.finance.getData().transactions.length,0);assert.equal(h.app.user.shortId,'#XXXXX276');
});

test('Case, ELO, books and topics survive Supabase roundtrip, live updates and logout',async t=>{
 const desktop=fixture(t);await desktop.login();
 desktop.app.workspace={portfolio:[{id:'case-one',title:'NCD',role:'Developer',stack:'JavaScript',description:'Productivity',url:'https://example.com',images:['https://example.com/image.png']}],eloHistory:[{id:'rating-one',rating:1300,date:'2026-10-26T00:00:00Z'}],books:[{id:'book-one',title:'Book',total:100,pages:50}],topics:[{id:'topic-one',title:'English',notes:'Notes',steps:[],completed:false}]};
 await desktop.app.saveData();await desktop.w.CloudSync.sync();
 const mobile=fixture(t,desktop.cloud);await mobile.login();
 assert.deepEqual(copy(mobile.app.workspace),copy(desktop.app.workspace));
 desktop.app.workspace.books[0].pages=100;await desktop.app.saveData();await desktop.w.CloudSync.sync();
 await new Promise(resolve=>setTimeout(resolve,250));await mobile.idle();
 assert.equal(mobile.app.workspace.books[0].pages,100);
 await mobile.w.CloudSync.logout();assert.equal(mobile.app.workspace.portfolio.length,0);assert.equal(mobile.app.workspace.eloHistory.length,0);
});

test('Verified profiles JSONB columns receive workspace without sending it to user_profile',async t=>{
 const h=fixture(t,{workspaceColumns:true});await h.login();
 h.app.workspace={portfolio:[{id:'case-schema',title:'Project',images:[]}],eloHistory:[{id:'elo-schema',rating:1500,date:'2026-10-26'}],books:[],topics:[]};
 await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 const record=h.cloud.records[h.app.user.supabaseUserId];
 assert.equal(record.workspaceColumns.portfolio[0].title,'Project');assert.equal(record.workspaceColumns.learning_chess[0].rating,1500);
 assert.equal(Object.hasOwn(record.state.profile,'workspace'),false);
 assert.equal(h.cloud.schemaReads||0,0);
 const second=fixture(t,h.cloud);await second.login();assert.equal(second.app.workspace.portfolio[0].id,'case-schema');
});
test('Missing dedicated workspace columns use the owned profile document without losing module data',async t=>{
 for(const config of [{noWorkspaceStorage:true},{extraText:true}]){
  const h=fixture(t,config);await h.login();h.app.workspace={portfolio:[{id:'local-case',title:'Local only'}],eloHistory:[],books:[],topics:[]};await h.app.saveData();
  const writes=h.cloud.calls.filter(row=>row.name==='profiles.update').length;
  assert.equal(await h.w.CloudSync.sync(),true);assert.equal(h.app.workspace.portfolio[0].id,'local-case');
  assert.equal(h.cloud.calls.filter(row=>row.name==='profiles.update').length,writes);
  assert.equal(h.cloud.records[h.app.user.supabaseUserId].state.profile.workspace.portfolio[0].id,'local-case');
 }
});

test('Rejected profiles module update retains the legacy cloud backup and local retry data',async t=>{
 const h=fixture(t);await h.login();const id=h.app.user.supabaseUserId;
 const workspace={portfolio:[{id:'legacy-case',title:'Legacy backup'}],eloHistory:[],books:[],topics:[]};
 h.app.workspace=copy(workspace);h.cloud.records[id].state.profile.workspace=copy(workspace);
 h.cloud.tableError='42501';h.cloud.failOperation='profiles.update';await h.app.saveData();
 assert.equal(await h.w.CloudSync.sync(),false);
 assert.equal(h.cloud.records[id].state.profile.workspace.portfolio[0].id,'legacy-case');
 assert.equal(h.app.workspace.portfolio[0].id,'legacy-case');
 h.cloud.tableError=null;assert.equal(await h.w.CloudSync.sync(),true);
 assert.equal(h.cloud.records[id].profileExtra.portfolio[0].id,'legacy-case');
});

test('Chess.com nickname, ratings/history and percent books roundtrip through verified profiles fields',async t=>{
 for(const config of [{},{workspaceColumns:true}]){
  const h=fixture(t,config);await h.login();
  h.app.workspace={portfolio:[],eloHistory:[],books:[],topics:[],chess:{username:'player_one'}};
  await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
  const firstRecord=h.cloud.records[h.app.user.supabaseUserId];
  assert.equal((config.workspaceColumns?firstRecord.workspaceColumns:firstRecord.profileExtra).learning_chess.username,'player_one');
  h.app.workspace.chess.stats={rapid:{rating:1500,lastGame:123}};
  h.app.workspace.eloHistory.push({id:'api-rating',rating:1500,mode:'rapid',username:'player_one',date:'2026-10-26T00:00:00Z'});
  h.app.workspace.books=[{id:'percent-book',title:'Book',progress:45}];
  await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
  const second=fixture(t,h.cloud);await second.login();
  assert.equal(second.app.workspace.chess.username,'player_one');assert.equal(second.app.workspace.chess.stats.rapid.rating,1500);
  assert.equal(second.app.workspace.books[0].progress,45);assert.equal(second.app.workspace.eloHistory[0].mode,'rapid');
 }
});

test('Goals refresh pulls another device additions while preserving unsent local goals',async t=>{
 const h=fixture(t);await h.login();
 h.app.goals=[goal('local-unsent')];
 h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals=[goal('from-phone')];
 const before=h.cloud.calls.filter(c=>c.name==='goals.select').length;
 assert.equal(await h.w.CloudSync.refreshGoals(),true);
 assert.ok(h.cloud.calls.filter(c=>c.name==='goals.select').length>before);
 assert.deepEqual(Array.from(h.app.goals,g=>g.id).sort(),['from-phone','local-unsent']);
 assert.ok(h.d.getElementById('goalsList').textContent.includes('from-phone'));
});
test('Goal push uploads goals independently while reporting the other module failure',async t=>{
 const h=fixture(t);await h.login();
 h.cloud.tableError='42501';h.cloud.failOperation='finance_transactions.select';
 const saved=goal('direct-goal');h.app.goals=[saved];
 assert.equal(await h.w.CloudSync.pushGoals(saved),false);
 assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals.length,1);
 assert.equal(h.app.goals[0].id,'direct-goal');
 assert.match(h.d.querySelector('[data-cloud-diagnostic]').textContent,/finance_transactions\.select/);
});
test('A sync refreshes only the visible workspace instead of rebuilding hidden views',async t=>{
 const h=fixture(t);await h.login();const calls={goals:0,calendar:0,finance:0};
 h.app.renderGoals=()=>calls.goals++;h.app.renderCalendar=()=>calls.calendar++;
 h.w.renderFinanceView=()=>calls.finance++;
 h.app.currentView='profile';assert.equal(await h.w.CloudSync.sync(),true);
 assert.deepEqual(calls,{goals:0,calendar:0,finance:0});
 h.app.currentView='calendar';assert.equal(await h.w.CloudSync.sync(),true);
 assert.deepEqual(calls,{goals:0,calendar:1,finance:0});
 h.d.getElementById('settingsModal').classList.add('active');assert.equal(await h.w.CloudSync.sync(),true);
 assert.deepEqual(calls,{goals:0,calendar:1,finance:0});
 h.app.render=()=>calls.calendar++;h.app.closeModal('settingsModal');
 assert.deepEqual(calls,{goals:0,calendar:2,finance:0});
});
test('Logout button opens authorization even with unsynchronized offline data',async t=>{
 const h=fixture(t);await h.login();h.online(false);h.app.goals=[goal('offline-before-logout')];await h.app.saveData();
 h.w.confirm=()=>assert.fail('Logout must not ask for confirmation');
 h.d.querySelector('[data-cloud-logout]').click();
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(h.app.user,null);assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
});

test('Safe sync restores cloud goals from an empty device with a stale baseline for every conflict preference',async t=>{
 const h=fixture(t);await h.login();
 h.app.goals=[goal('keep-safe')];await h.app.saveData();await h.w.CloudSync.sync();
 for(const preference of [undefined,'local','remote']){
  h.app.goals=[];
  h.cloud.calls.length=0;
  assert.equal(await h.w.CloudSync.sync(preference),true);
  assert.equal(h.app.goals[0].id,'keep-safe');
  assert.equal(h.cloud.records['11111111-1111-4111-8111-111111111111'].state.goals[0].id,'keep-safe');
  assert.equal(h.cloud.calls.some(c=>c.name==='goals.delete'),false);
  assert.equal(h.cloud.calls.some(c=>c.name==='goals.upsert'&&!c.payload.length),false);
 }
});
test('Manual goals pull restores cloud goals despite an empty local list and stale baseline',async t=>{
 const h=fixture(t);await h.login();h.app.goals=[goal('manual-keep')];await h.app.saveData();await h.w.CloudSync.sync();
 h.app.goals=[];assert.equal(await h.w.CloudSync.refreshGoals(),true);
 assert.equal(h.app.goals[0].id,'manual-keep');
});
test('Rejected goal upsert logs exact Supabase status and error without logging credentials',async t=>{
 const h=fixture(t);await h.login();const logs=[];h.w.console.warn=(...args)=>logs.push(args);
 h.app.goals=[goal('invalid-id')];
 const client=h.w.CloudSync.client, original=client.from;
 client.from=function(table){const result=original.call(this,table);if(table!=='goals')return result;result.upsert=async()=>({status:400,statusText:'Bad Request',error:{code:'22P02',message:'invalid input syntax for type uuid',details:'Exact details',hint:'Exact hint'}});return result;};
 assert.equal(await h.w.CloudSync.sync(),false);
 const logged=logs.find(args=>args[0]==='[goals.upsert] Supabase request failed')[1];
 assert.equal(logged.status,400);assert.equal(logged.error.message,'invalid input syntax for type uuid');
 assert.equal(logged.error.details,'Exact details');assert.equal(logged.error.hint,'Exact hint');
 assert.ok(!JSON.stringify(logs).includes('fixture-password'));
 client.from=original;
});

test('HTTP requests refresh expired tokens together and retry a 401 only once',async t=>{
 const h=fixture(t);await h.login();
 h.app.goals=[goal('refresh-local')];await h.w.ProfileStorage.save(h.app.serialize());
 let token={user:{id:h.app.user.supabaseUserId},access_token:'expired',expires_at:1},refreshes=0;
 const auth=h.w.CloudSync.client.auth;
 auth.getSession=async()=>({data:{session:token},error:null});
 auth.refreshSession=async()=>{refreshes++;await new Promise(r=>setImmediate(r));token={...token,access_token:`fresh-${refreshes}`,expires_at:Date.now()/1000+3600};return {data:{session:token},error:null};};
 const calls=[];let unauthorized=false;
 h.w.fetch=async(input,options)=>{calls.push(options.headers.get('Authorization'));return {status:unauthorized?401:200};};
 const fetch=h.cloud.options.global.fetch,url='https://fixture.supabase.co/rest/v1/goals';
 await Promise.all([fetch(url),fetch(url)]);
 assert.equal(refreshes,1);assert.deepEqual(calls,['Bearer fresh-1','Bearer fresh-1']);
 await h.idle();await new Promise(r=>setTimeout(r,20));await h.idle();
 assert.ok(h.cloud.records[h.app.user.supabaseUserId].state.goals.some(item=>item.id==='refresh-local'));
 auth.refreshSession=async()=>{throw Error('refresh failed');};
 unauthorized=true;calls.length=0;
 await assert.rejects(fetch(url),/refresh failed/);
 assert.deepEqual(calls,['Bearer fresh-1']);
 auth.refreshSession=async()=>{refreshes++;token={...token,access_token:'fresh-2'};return {data:{session:token},error:null};};
 calls.length=0;await fetch(url);
 assert.equal(refreshes,2);assert.deepEqual(calls,['Bearer fresh-1','Bearer fresh-2']);
 await assert.rejects(fetch(url),/SUPABASE_SESSION_REJECTED/);
 assert.equal(h.w.CloudSync.connectionState().state,'reauth_required');
 assert.equal(h.d.querySelector('[data-cloud-open-auth]').hidden,false);
 h.w.CloudSync.openAuth();assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),true);
 h.cloud.signInError={code:'invalid_credentials',message:'Invalid login credentials'};
 await assert.rejects(h.w.CloudSync.authenticate('test@example.invalid','fixture-password',false));
 assert.equal(h.w.CloudSync.connectionState().state,'reauth_required');
 assert.equal(h.app.goals[0].id,'refresh-local');
 h.cloud.signInError=null;
 await h.w.CloudSync.authenticate('test@example.invalid','fixture-password',false);await h.idle();
 assert.equal(h.w.CloudSync.connectionState().state,'active');
 assert.equal(h.app.goals[0].id,'refresh-local');
 calls.length=0;await fetch('https://fixture.supabase.co/auth/v1/token');assert.equal(calls.length,1);
});

test('Sync reads and updates legacy finance documents without the OpenAPI endpoint',async t=>{
 const id='11111111-1111-4111-8111-111111111111';
 const existing={id:'legacy-finance',type:'income',amount:50,category:'other',description:'Old',date:'2026-01-01'};
 const cloud={financeDocument:true,schemaUnavailable:true,records:{[id]:{revision:1,state:{goals:[],transactions:[existing],safetyFund:{},financeOther:{},calendar:{},profile:{nickname:'Player'}}}}};
 const h=fixture(t,cloud);await h.login();
 assert.equal(h.w.finance.getData().transactions[0].id,'legacy-finance');
 h.w.finance.replaceData({...h.w.finance.getData(),transactions:[{...existing,amount:75}]});
 await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 assert.equal(cloud.records[id].state.transactions[0].amount,75);
 assert.equal(cloud.schemaReads||0,0);
 assert.ok(cloud.calls.some(call=>call.name==='finance_transactions.update'));
});

test('Workspace sync does not depend on OpenAPI permission',async t=>{
 const h=fixture(t,{schemaUnavailable:true});await h.login();
 h.app.workspace={portfolio:[{id:'case-without-openapi',title:'Saved'}],eloHistory:[],books:[],topics:[]};
 await h.app.saveData();assert.equal(await h.w.CloudSync.sync(),true);
 assert.equal(h.cloud.schemaReads||0,0);
 assert.equal(h.cloud.records[h.app.user.supabaseUserId].profileExtra.portfolio[0].id,'case-without-openapi');
});

test('Incomplete financial rows cannot overwrite local finance',async t=>{
 const h=fixture(t);await h.login();const id=h.app.user.supabaseUserId;
 h.cloud.records[id].state.transactions=[{id:'shared',type:'income',amount:50,category:'other',description:'Cloud',date:'2026-01-01'}];
 h.w.finance.replaceData({...h.w.finance.getData(),transactions:[{id:'local',type:'income',amount:75,category:'other',description:'Keep',date:'2026-01-01'}]});
 h.cloud.financeMissingColumn=true;await h.app.saveData();
 assert.equal(await h.w.CloudSync.sync(),false);
 assert.equal(h.w.finance.getData().transactions[0].description,'Keep');
 assert.equal(h.cloud.records[id].state.transactions[0].description,'Cloud');
});

test('Laptop and Android exchange goal edits, last-goal deletion, habits and gamification',async t=>{
 const cloud={};const laptop=fixture(t,cloud);await laptop.login();
 laptop.app.goals=[goal('shared-edit')];laptop.app.habits=[{id:'habit-1',title:'Read'}];laptop.app.gamification={xp:42,level:2};
 await laptop.app.saveData();assert.equal(await laptop.w.CloudSync.sync(),true);
 cloud.nativeStore=new Map();const phone=fixture(t,cloud);await phone.login();
 assert.equal(phone.app.goals[0].id,'shared-edit');assert.equal(phone.app.habits[0].title,'Read');assert.equal(phone.app.gamification.xp,42);
 phone.app.goals[0].title='Changed on phone';phone.app.habits[0].title='Read daily';phone.app.gamification.xp=55;
 await phone.app.saveData();assert.equal(await phone.w.CloudSync.sync(),true);
 assert.equal(await laptop.w.CloudSync.sync(),true);
 assert.equal(laptop.app.goals[0].title,'Changed on phone');assert.equal(laptop.app.habits[0].title,'Read daily');assert.equal(laptop.app.gamification.xp,55);
 phone.app.goals=[];await phone.app.saveData();assert.equal(await phone.w.CloudSync.sync(),true);
 assert.equal(await laptop.w.CloudSync.sync(),true);assert.equal(laptop.app.goals.length,0);
});

test('Fast goal save preserves another device edit and stops on a conflicting edit',async t=>{
 const h=fixture(t);await h.login();const id=h.app.user.supabaseUserId;
 h.app.goals=[{...goal('shared'),description:'original'}];await h.app.saveData();await h.w.CloudSync.sync();
 const local={...h.app.goals[0],title:'Local title'};
 h.cloud.records[id].state.goals[0].description='Remote description';
 h.app.goals=[local];assert.equal(await h.w.CloudSync.pushGoals(local),true);
 assert.equal(h.cloud.records[id].state.goals[0].title,'Local title');assert.equal(h.cloud.records[id].state.goals[0].description,'Remote description');
 await h.w.CloudSync.sync();
 h.cloud.records[id].state.goals[0].title='Remote title';
 const conflict={...h.app.goals[0],title:'Conflicting title'};h.app.goals=[conflict];
 assert.equal(await h.w.CloudSync.pushGoals(conflict),false);
 assert.equal(h.cloud.records[id].state.goals[0].title,'Remote title');
 assert.equal(h.app.goals[0].title,'Conflicting title');
});

test('Offline conflict after reopening retains local edit and cloud edit for user choice',async t=>{
 const cloud={};const first=fixture(t,cloud);await first.login();const id=first.app.user.supabaseUserId;
 first.app.goals=[goal('conflicted','Original')];await first.app.saveData();await first.w.CloudSync.sync();
 first.online(false);first.app.goals[0].title='Offline edit';await first.app.saveData();
 cloud.records[id].state.goals[0].title='Other device edit';
 const stored={};for(let i=0;i<first.w.localStorage.length;i++){const key=first.w.localStorage.key(i);stored[key]=first.w.localStorage.getItem(key);}
 let release;cloud.initialSession={user:{id,email:'test@example.invalid'}};cloud.browserStorage=stored;cloud.sessionGate=new Promise(resolve=>{release=resolve;});
 const second=fixture(t,cloud);await second.w.ProfileStorage.save(JSON.parse(stored.goalTracker_data));second.app.loadData();release();
 await new Promise(resolve=>setTimeout(resolve,50));await second.idle();await second.w.CloudSync.sync();
 assert.equal(second.app.goals[0].title,'Offline edit');assert.equal(cloud.records[id].state.goals[0].title,'Other device edit');
 assert.equal(second.d.querySelector('[data-cloud-conflicts]').hidden,false);
});

test('Logout completes within a second when sync and SDK signOut never settle',async t=>{
 const h=fixture(t);await h.login();
 let release;h.cloud.readGate=new Promise(resolve=>{release=resolve;});
 const pending=h.w.CloudSync.sync();await new Promise(resolve=>setImmediate(resolve));
 h.w.CloudSync.client.auth.signOut=()=>new Promise(()=>{});
 const start=Date.now(), exit=h.w.CloudSync.logout();
 assert.equal(h.w.CloudSync.logout(),exit);
 await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Logout is blocked')),1500);exit.finally(()=>clearTimeout(timer));})]);
 assert.ok(Date.now()-start<1500);assert.equal(h.app.user,null);
 assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
 assert.equal(h.w.localStorage.getItem('gt-session-locked-v1'),'true');
 h.cloud.readGate=null;release();await pending;
 assert.equal(h.app.user,null);assert.equal(h.app.goals.length,0);
});

test('An unfinished module save cannot block logout',async t=>{
 const h=fixture(t);await h.login();h.app._goalSaveInProgress=true;
 await h.w.CloudSync.logout();assert.equal(h.app.user,null);
 assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
});

test('Deleting the last known goal offline preserves a new goal from the other device',async t=>{
 const cloud={};const laptop=fixture(t,cloud);await laptop.login();
 laptop.app.goals=[goal('old')];await laptop.app.saveData();await laptop.w.CloudSync.sync();
 const phone=fixture(t,cloud);await phone.login();
 laptop.online(false);laptop.app.goals=[];await laptop.app.saveData();
 phone.app.goals.push(goal('new'));await phone.app.saveData();await phone.w.CloudSync.sync();
 laptop.online(true);assert.equal(await laptop.w.CloudSync.sync(),true);
 assert.deepEqual(Array.from(laptop.app.goals,g=>g.id),['new']);
 assert.deepEqual(cloud.records[laptop.app.user.supabaseUserId].state.goals.map(g=>g.id),['new']);
});

test('Account data survives offline logout, restart and login, then merges and uploads after reconnect',async t=>{
 const h=fixture(t);await h.login();const id=h.app.user.supabaseUserId;
 h.online(false);h.app.goals=[goal('offline-kept')];h.app.notes=h.app.normalizeNotes({'2030-01-01':[{id:'note-kept',content:'Saved note'}]});
 h.app.habits=[{id:'habit-kept',name:'Read'}];h.app.workspace={portfolio:[{id:'case-kept',title:'Case'}],eloHistory:[],books:[{id:'book-kept',title:'Book'}],topics:[]};
 h.app.gamification={badges:['kept']};h.app.settings.notificationSound=false;h.w.localStorage.setItem('goalTracker_health_local_v1',JSON.stringify({connected:true,metrics:{steps:{value:1234,unit:'count',source:'fixture',measuredAt:'2026-10-28T01:00:00Z'}},lastReadAt:'2026-10-28T01:00:00Z'}));h.w.finance.replaceData({transactions:[{id:'tx-kept',amount:42,type:'income'}],safetyFund:{balance:77,history:[]}});
 await h.app.saveData();const expected=copy(h.w.CloudSync.capture());
 h.w.confirm=()=>assert.fail('Offline logout must remain available');await h.w.CloudSync.logout();assert.equal(h.app.user,null);
 const stored=Object.fromEntries(Object.keys(h.w.localStorage).map(key=>[key,h.w.localStorage.getItem(key)]));
 const reopened=fixture(t,{browserStorage:stored,offline:true,records:h.cloud.records});
 await reopened.login();assert.deepEqual(copy(reopened.w.CloudSync.capture()),expected);assert.equal(reopened.app.settings.notificationSound,false);assert.equal(JSON.parse(reopened.w.localStorage.getItem('goalTracker_health_local_v1')).metrics.steps.value,1234);
 reopened.cloud.offline=false;
 reopened.cloud.records[id].state.goals.push(goal('other-device'));
 await reopened.w.CloudSync.bootstrapCloud(true);await reopened.idle();await reopened.w.CloudSync.sync();
 assert.deepEqual(reopened.cloud.records[id].state.goals.map(g=>g.id).sort(),['offline-kept','other-device']);
 assert.equal(reopened.cloud.records[id].state.transactions[0].amount,42);
 await reopened.w.CloudSync.logout();await reopened.login();
 assert.deepEqual(Array.from(reopened.app.goals,g=>g.id).sort(),['offline-kept','other-device']);
 assert.equal(reopened.app.workspace.books[0].id,'book-kept');
});

test('Saved account A stays private when B signs in and restores when A returns',async t=>{
 const h=fixture(t);await h.login();const accountA=h.app.user.supabaseUserId;
 h.online(false);h.app.goals=[goal('private-a')];await h.app.saveData();await h.w.CloudSync.logout();
 h.online(true);h.setUser('22222222-2222-4222-8222-222222222222');await h.login();assert.equal(h.app.goals.length,0);
 h.online(false);h.app.goals=[goal('private-b')];await h.app.saveData();await h.w.CloudSync.logout();
 h.online(true);h.setUser(accountA);await h.login();assert.deepEqual(Array.from(h.app.goals,g=>g.id),['private-a']);
 assert.ok(!JSON.stringify(h.cloud.records['22222222-2222-4222-8222-222222222222'].state).includes('private-a'));
 await h.w.CloudSync.logout();h.setUser('22222222-2222-4222-8222-222222222222');await h.login();
 assert.deepEqual(Array.from(h.app.goals,g=>g.id),['private-b']);
});

test('Native account data survives logout and a fresh WebView without browser localStorage',async t=>{
 const nativeStore=new Map();const h=fixture(t,{nativeStore});await h.login();
 h.online(false);h.app.goals=[goal('native-kept')];await h.app.saveData();await h.w.CloudSync.logout();
 const next=fixture(t,{nativeStore,offline:true});await next.login();
 assert.deepEqual(Array.from(next.app.goals,g=>g.id),['native-kept']);
});

test('An already signed-in empty profile restores recovered data instead of uploading an empty account',async t=>{
 const first=fixture(t);await first.login();const id=first.app.user.supabaseUserId,identity='https://fixture.supabase.co|'+id;
 const recovered=copy(first.w.CloudSync.capture());recovered.goals=[goal('recovered-one'),goal('recovered-two')];
 const stored=Object.fromEntries(Object.keys(first.w.localStorage).map(key=>[key,first.w.localStorage.getItem(key)]));
 stored['gt-account-data-v1:'+identity]=JSON.stringify({identity,userId:id,base:first.w.CloudSyncCore.empty(),local:recovered});
 const h=fixture(t,{browserStorage:stored,records:first.cloud.records,initialSession:{user:{id,email:'test@example.invalid'}}});
 h.app.user={...first.app.user};
 await new Promise(resolve=>setTimeout(resolve,50));await h.idle();
 assert.deepEqual(Array.from(h.app.goals,g=>g.id),['recovered-one','recovered-two']);
 await h.w.CloudSync.sync();
 assert.deepEqual(h.cloud.records[id].state.goals.map(g=>g.id),['recovered-one','recovered-two']);
});

test('A failed account snapshot write never erases the original stored profile',async t=>{
 const h=fixture(t);await h.login();h.online(false);h.app.goals=[goal('preserve-on-disk-failure')];await h.app.saveData();
 h.w.ProfileStorage.writeAccount=async()=>{throw new Error('Disk full');};
 await assert.rejects(h.w.CloudSync.logout(),/Disk full/);
 assert.equal(h.app.user,null);
 assert.equal(h.w.ProfileStorage.get().goals[0].id,'preserve-on-disk-failure');
 assert.equal(h.w.localStorage.getItem('gt-session-locked-v1'),'true');
 assert.ok(h.d.getElementById('cloudAuthModal').classList.contains('active'));
 delete h.w.ProfileStorage.writeAccount;h.online(true);await h.login();
 assert.equal(h.app.goals[0].id,'preserve-on-disk-failure');
 assert.equal(h.cloud.records[h.app.user.supabaseUserId].state.goals[0].id,'preserve-on-disk-failure');
});

test('Two restored goals reach a fresh phone and additions merge in both directions',async t=>{
 const seed=fixture(t);await seed.login();const id=seed.app.user.supabaseUserId,identity='https://fixture.supabase.co|'+id;
 const recovered=copy(seed.w.CloudSync.capture());
 recovered.goals=[{...goal('restored-first'),subgoals:[{id:'shared-step',title:'First step',completed:false,checklist:[]}]},goal('restored-second')];
 const browserStorage=Object.fromEntries(Object.keys(seed.w.localStorage).map(key=>[key,seed.w.localStorage.getItem(key)]));
 browserStorage['gt-account-data-v1:'+identity]=JSON.stringify({identity,userId:id,base:seed.w.CloudSyncCore.empty(),local:recovered});
 const desktop=fixture(t,{browserStorage,records:seed.cloud.records,initialSession:{user:{id,email:'test@example.invalid'}}});
 desktop.app.user={...seed.app.user};await new Promise(resolve=>setTimeout(resolve,50));await desktop.idle();await desktop.w.CloudSync.sync();await desktop.idle();
 const phone=fixture(t,{nativeStore:new Map(),records:desktop.cloud.records});await phone.login();
 assert.equal(phone.app.user.supabaseUserId,id);assert.deepEqual(Array.from(phone.app.goals,g=>g.id),['restored-first','restored-second']);
 phone.online(false);phone.app.goals[0].subgoals[0].checklist.push({id:'phone-item',text:'Added on phone',completed:false});await phone.app.saveData();
 desktop.app.goals[1].description='Added on laptop';await desktop.app.saveData();await desktop.w.CloudSync.sync();await desktop.idle();
 phone.online(true);await phone.w.CloudSync.sync();await phone.idle();await desktop.w.CloudSync.sync();await desktop.idle();
 for(const h of [desktop,phone]){
  assert.equal(h.app.goals[0].subgoals[0].checklist[0].text,'Added on phone');
  assert.equal(h.app.goals[1].description,'Added on laptop');assert.equal(h.app.goals.length,2);
 }
 phone.app.goals[0].subgoals[0].completed=true;await phone.app.saveData();await phone.w.CloudSync.sync();await phone.idle();
 await desktop.w.CloudSync.sync();await desktop.idle();assert.equal(desktop.app.goals[0].subgoals[0].completed,true);
});

test('A fresh phone reads and edits the two goals even when finance reads fail',async t=>{
 const desktop=fixture(t);await desktop.login();const id=desktop.app.user.supabaseUserId;
 desktop.app.goals=[{...goal('shared-one'),subgoals:[{id:'shared-step',title:'Step',completed:false}]},goal('shared-two')];
 await desktop.app.saveData();await desktop.w.CloudSync.sync();await desktop.idle();
 const phone=fixture(t,{nativeStore:new Map(),records:desktop.cloud.records,tableError:'42501',failOperation:'finance_transactions.select'});
 await phone.login();
 assert.deepEqual(Array.from(phone.app.goals,g=>g.id),['shared-one','shared-two']);
 assert.equal(phone.w.CloudSync.connectionState().state,'load_error');
 assert.match(phone.d.querySelector('[data-cloud-diagnostic]').textContent,/сервер подтвердил 2/);
 phone.app.goals[0].subgoals[0].completed=true;await phone.app.saveData();await phone.w.CloudSync.sync();await phone.idle();
 await desktop.w.CloudSync.sync();await desktop.idle();assert.equal(desktop.app.goals[0].subgoals[0].completed,true);
 desktop.app.goals[1].description='From laptop';await desktop.app.saveData();await desktop.w.CloudSync.sync();await desktop.idle();
 await phone.w.CloudSync.sync();await phone.idle();assert.equal(phone.app.goals[1].description,'From laptop');
 assert.equal(phone.cloud.records[id].state.goals.length,2);
});

test('A leftover full-sync receipt cannot silently block a phone from loading goals after a finance permission failure',async t=>{
 const desktop=fixture(t);await desktop.login();const id=desktop.app.user.supabaseUserId;
 desktop.app.goals=[goal('receipt-one'),goal('receipt-two')];await desktop.app.saveData();await desktop.w.CloudSync.sync();await desktop.idle();
 const phone=fixture(t,{nativeStore:new Map(),records:desktop.cloud.records,tableError:'42501',failOperation:'finance_transactions.select'});await phone.login();
 phone.app.goals=[];await phone.app.saveData();
 const key='gt-cloud-state-v1:https://fixture.supabase.co|'+id;
 const empty=copy(phone.w.CloudSync.capture());
 phone.w.localStorage.setItem(key,JSON.stringify({base:empty,revision:0,receipt:{before:empty,accepted:empty}}));
 await phone.w.CloudSync.sync();await phone.idle();
 assert.deepEqual(Array.from(phone.app.goals,g=>g.id),['receipt-one','receipt-two']);
 const meta=JSON.parse(phone.w.localStorage.getItem(key));
 assert.equal(meta.receipt.accepted.goals.length,2);
 assert.equal(meta.receipt.accepted.transactions.length,0);
 assert.match(phone.d.querySelector('[data-cloud-diagnostic]').textContent,/сервер подтвердил 2/);
});

test('Calendar, health, workspace, habits and fund synchronize both ways despite unavailable finance',async t=>{
 const desktop=fixture(t);await desktop.login();const id=desktop.app.user.supabaseUserId;
 const phone=fixture(t,{nativeStore:new Map(),records:desktop.cloud.records,tableError:'42501',failOperation:'finance_transactions.select'});await phone.login();
 phone.app.notes=phone.app.normalizeNotes({'2030-02-01':[{id:'phone-note',content:'From phone'}]});
 phone.app.habits=[{id:'phone-habit',name:'Read daily'}];phone.app.gamification={badges:['shared-badge']};
 phone.app.workspace={portfolio:[{id:'phone-case',title:'Case'}],eloHistory:[],books:[{id:'phone-book',title:'Book',progress:25}],topics:[{id:'topic',title:'Topic'}]};
 const health={metrics:{steps:{value:6543,unit:'count',source:'Health Connect',measuredAt:'2026-10-28T01:00:00Z'}},lastReadAt:'2026-10-28T01:00:00Z'};
 phone.w.localStorage.setItem('goalTracker_health_local_v1',JSON.stringify({...health,connected:true,granted:['steps']}));
 phone.w.localStorage.setItem('goalTracker_health_account_v1',JSON.stringify(health));
 phone.w.finance.replaceData({...phone.w.finance.getData(),safetyFund:{balance:500,history:[]}});
 await phone.app.saveData();await phone.w.CloudSync.sync();await phone.idle();
 await desktop.w.CloudSync.sync();await desktop.idle();
 assert.equal(desktop.app.notes['2030-02-01'][0].content,'From phone');
 assert.equal(desktop.app.habits[0].id,'phone-habit');assert.equal(desktop.app.workspace.books[0].progress,25);
 assert.equal(desktop.w.finance.getData().safetyFund.balance,500);
 const shared=JSON.parse(desktop.w.localStorage.getItem('goalTracker_health_account_v1'));
 assert.equal(shared.metrics.steps.value,6543);assert.equal(shared.connected,undefined);assert.equal(shared.granted,undefined);
 const cloudHealth=desktop.cloud.records[id].state.profile.health;assert.equal(cloudHealth.metrics.steps.value,6543);assert.equal(cloudHealth.connected,undefined);
 phone.online(false);phone.app.workspace.books[0].progress=75;await phone.app.saveData();
 desktop.app.notes['2030-02-01'].push({id:'desktop-note',content:'From laptop'});await desktop.app.saveData();await desktop.w.CloudSync.sync();await desktop.idle();
 phone.online(true);await phone.w.CloudSync.sync();await phone.idle();await desktop.w.CloudSync.sync();await desktop.idle();
 for(const h of [phone,desktop]){assert.equal(h.app.notes['2030-02-01'].length,2);assert.equal(h.app.workspace.books[0].progress,75);}
 assert.match(phone.d.querySelector('[data-cloud-diagnostic]').textContent,/42501/);
});

test('A failed profile document cannot hide the calendar or overwrite unsent health',async t=>{
 const desktop=fixture(t);await desktop.login();desktop.app.notes=desktop.app.normalizeNotes({'2030-03-01':[{id:'existing-note',content:'Cloud'}]});
 await desktop.app.saveData();await desktop.w.CloudSync.sync();await desktop.idle();
 const phone=fixture(t,{records:desktop.cloud.records,nativeStore:new Map(),tableError:'42501',failOperation:'user_profile.select'});await phone.login();
 assert.equal(phone.app.notes['2030-03-01'][0].id,'existing-note');
 const local={metrics:{weight:{value:75,unit:'kg',source:'Device',measuredAt:'2026-10-28T02:00:00Z'}},lastReadAt:'2026-10-28T02:00:00Z'};
 phone.w.localStorage.setItem('goalTracker_health_account_v1',JSON.stringify(local));
 phone.app.notes['2030-03-01'].push({id:'new-note',content:'Phone'});await phone.app.saveData();await phone.w.CloudSync.sync();await phone.idle();
 assert.equal(JSON.parse(phone.w.localStorage.getItem('goalTracker_health_account_v1')).metrics.weight.value,75);
 await desktop.w.CloudSync.sync();await desktop.idle();assert.equal(desktop.app.notes['2030-03-01'].length,2);
});

test('A concurrent profile update is preserved when health is retried after a document version conflict',async t=>{
 const source=fixture(t);await source.login();const id=source.app.user.supabaseUserId;
 const phone=fixture(t,{records:source.cloud.records,nativeStore:new Map(),tableError:'42501',failOperation:'finance_transactions.select'});await phone.login();
 const sample={metrics:{heartRate:{value:72,unit:'bpm',source:'Device',measuredAt:'2026-10-28T03:00:00Z'}},lastReadAt:'2026-10-28T03:00:00Z'};
 phone.w.localStorage.setItem('goalTracker_health_account_v1',JSON.stringify(sample));
 phone.cloud.beforeWrite=async record=>{record.state.profile.status='Concurrent profile edit';};
 await phone.w.CloudSync.sync();await phone.idle();await phone.w.CloudSync.sync();await phone.idle();
 assert.equal(phone.cloud.records[id].state.profile.status,'Concurrent profile edit');
 assert.equal(phone.cloud.records[id].state.profile.health.metrics.heartRate.value,72);
 assert.equal(JSON.parse(phone.w.localStorage.getItem('goalTracker_health_account_v1')).metrics.heartRate.value,72);
});

test('Health keeps the newest measured reading while merging different metrics from two devices',t=>{
 const h=fixture(t),base=h.w.CloudSyncCore.empty();base.profile.health={metrics:{},lastReadAt:null};
 const local=copy(base),remote=copy(base);
 local.profile.health={metrics:{steps:{value:1000,unit:'count',source:'A',measuredAt:'2026-10-28T01:00:00Z'},weight:{value:70,unit:'kg',source:'A',measuredAt:'2026-10-28T02:00:00Z'}},lastReadAt:'2026-10-28T02:00:00Z'};
 remote.profile.health={metrics:{steps:{value:2000,unit:'count',source:'B',measuredAt:'2026-10-28T03:00:00Z'}},lastReadAt:'2026-10-28T03:00:00Z'};
 const result=h.w.CloudSyncCore.merge(base,local,remote);
 assert.equal(result.conflicts.length,0);assert.equal(result.value.profile.health.metrics.steps.value,2000);assert.equal(result.value.profile.health.metrics.weight.value,70);
});

test('Finance 42703 uses the owned profile ledger without deleting cached or legacy transactions',async t=>{
 const desktop=fixture(t);await desktop.login();const id=desktop.app.user.supabaseUserId;
 desktop.w.finance.replaceData({...desktop.w.finance.getData(),transactions:[{id:'original-tx',type:'income',amount:100,category:'Work',description:'Before schema error',date:'2030-01-01'}]});
 await desktop.app.saveData();await desktop.w.CloudSync.sync();await desktop.idle();
 desktop.cloud.tableError='42703';desktop.cloud.failOperation='finance_transactions.select';
 assert.equal(await desktop.w.CloudSync.sync(),true);await desktop.idle();
 assert.equal(desktop.w.finance.getData().transactions[0].id,'original-tx');
 assert.equal(desktop.cloud.records[id].profileSync.transactionsStorage,'profile-v1');
 const phone=fixture(t,{records:desktop.cloud.records,nativeStore:new Map(),tableError:'42703',failOperation:'finance_transactions.select'});await phone.login();
 assert.equal(phone.w.finance.getData().transactions[0].id,'original-tx');
 const next=[...copy(phone.w.finance.getData().transactions),{id:'phone-tx',type:'expense',amount:30,category:'Food',description:'Phone',date:'2030-01-02'}];
 phone.w.finance.replaceData({...phone.w.finance.getData(),transactions:next});await phone.app.saveData();await phone.w.CloudSync.sync();await phone.idle();
 // A repaired primary table must not override the already selected profile ledger.
 desktop.cloud.tableError=null;await desktop.w.CloudSync.sync();await desktop.idle();
 assert.deepEqual(Array.from(desktop.w.finance.getData().transactions,item=>item.id).sort(),['original-tx','phone-tx']);
 assert.equal(desktop.cloud.records[id].state.transactions.length,1);
 assert.ok(!desktop.cloud.calls.some(call=>call.name==='finance_transactions.delete'));
});

test('Desktop file session restores after renderer storage is lost and explicit logout removes it',async t=>{
 const desktopStore=new Map();const first=fixture(t,{defaults:true,desktopStore,useSDKStorage:true});
 await new Promise(resolve=>setImmediate(resolve));await first.w.CloudSync.authenticate('test@example.invalid','fixture-password',false);await first.idle();
 assert.ok(desktopStore.has('gt-supabase-auth:https://kvyhbbctpyeoikjqhubu.supabase.co'));
 const second=fixture(t,{defaults:true,startup:true,desktopStore,useSDKStorage:true});await second.idle();
 assert.equal(second.d.getElementById('app').style.display,'flex');assert.equal(second.cloud.authInput,undefined);
 assert.equal(second.d.getElementById('cloudAuthModal').classList.contains('active'),false);
 await second.w.CloudSync.logout();
 assert.equal(desktopStore.size,0);
 const third=fixture(t,{defaults:true,startup:true,desktopStore,useSDKStorage:true});await third.idle();
 assert.equal(third.d.getElementById('cloudAuthModal').classList.contains('active'),true);
});
test('Missing SDK session never clears a saved owned profile or opens registration',async t=>{
 const id='11111111-1111-4111-8111-111111111111';
 const h=fixture(t,{defaults:true,startup:true,cachedProfile:{user:{id,supabaseUserId:id,nickname:'Saved'},goals:[goal('keep-me')]}});
 await h.idle();assert.equal(h.app.user.supabaseUserId,id);assert.equal(h.app.goals[0].id,'keep-me');
 assert.equal(h.d.getElementById('app').style.display,'flex');assert.equal(h.d.getElementById('cloudAuthModal').classList.contains('active'),false);
 assert.notEqual(h.w.localStorage.getItem('gt-session-locked-v1'),'true');
});

test('Background goal refresh never resurrects the last durably deleted goal',async t=>{
 const h=fixture(t);await h.login();
 h.app.goals=[goal('delete-on-refresh')];await h.app.saveData();await h.w.CloudSync.sync();
 h.app.goals=[];await h.app.saveData();
 await h.w.CloudSync.refreshGoals();
 assert.equal(h.app.goals.length,0);
 assert.equal(JSON.parse(h.w.localStorage.getItem('goalTracker_data')).goals.length,0);
 await h.w.CloudSync.sync();
 assert.equal(h.cloud.records[h.app.user.supabaseUserId].state.goals.length,0);
 await h.w.CloudSync.refreshGoals();assert.equal(h.app.goals.length,0);
});

test('Goal drafts retain focus, selection and enabled inputs through background cloud updates',async t=>{
 const h=fixture(t);await h.login();h.app.currentView='goals';
 h.app.goals=[goal('focus-goal','Исходное название')];await h.app.saveData();await h.w.CloudSync.sync();
 for(const editing of [false,true]) {
  h.app.openGoalModal(editing?'focus-goal':null);
  const input=h.d.getElementById('goalTitle'),form=h.d.getElementById('goalForm');
  assert.equal(h.d.activeElement,input);
  let disabled=false;
  const observer=new h.w.MutationObserver(records=>{if(records.some(record=>record.oldValue===null))disabled=true;});
  observer.observe(input,{attributes:true,attributeFilter:['disabled'],attributeOldValue:true});
  input.value='Но';input.setSelectionRange(1,1);input.dispatchEvent(new h.w.Event('input',{bubbles:true}));
  h.cloud.records[h.app.user.supabaseUserId].state.goals.push(goal('remote-'+editing));
  await h.w.CloudSync.sync();await h.w.CloudSync.refreshGoals();
  assert.equal(disabled,false,'Cloud apply must never disable the draft input');
  assert.equal(h.d.activeElement,input);assert.equal(input.value,'Но');assert.equal(input.selectionStart,1);
  assert.equal(h.d.getElementById('goalForm'),form);assert.equal(h.d.getElementById('goalTitle'),input);
  input.value='Новая цель';input.dispatchEvent(new h.w.Event('input',{bubbles:true}));
  assert.equal(h.d.activeElement,input);assert.equal(h.app.goals.find(g=>g.id==='focus-goal').title,'Исходное название');
  observer.disconnect();h.app.closeModal('goalModal');await h.w.CloudSync.sync();
  assert.ok(h.app.goals.some(g=>g.id==='remote-'+editing));
 }
});

test('Opening a goal form during an in-flight cloud apply keeps its input enabled and focused',async t=>{
 for(const stage of ['flush','save']) {
  const h=fixture(t);await h.login();h.app.currentView='goals';
  h.cloud.records[h.app.user.supabaseUserId].state.goals.push(goal('arrived-'+stage));
  const original=h.w.ProfileStorage[stage];let opened=false;
  h.w.ProfileStorage[stage]=async(...args)=>{
   if(!opened){opened=true;h.app.openGoalModal();h.d.getElementById('goalTitle').value='Черновик';}
   return original?.(...args);
  };
  await h.w.CloudSync.sync();
  assert.ok(opened);const input=h.d.getElementById('goalTitle');
  assert.equal(input.disabled,false);assert.equal(h.d.activeElement,input);assert.equal(input.value,'Черновик');
  h.w.ProfileStorage[stage]=original;h.app.closeModal('goalModal');await h.w.CloudSync.sync();
  assert.ok(h.app.goals.some(g=>g.id==='arrived-'+stage));
 }
});
