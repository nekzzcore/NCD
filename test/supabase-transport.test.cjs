const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'sync.js'), 'utf8');
// Exercise the shipped transport with the shipped SDK, without starting the UI.
const transport = source.slice(source.indexOf('    let requestRefresh ='), source.indexOf('    function tokenKeys()'));
const url = 'https://fixture.supabase.co', key = 'sb_publishable_fixture';
const uid = '11111111-1111-4111-8111-111111111111';
const token = (label, expiry = Math.floor(Date.now()/1000)+3600) => ({
    access_token: Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:uid,exp:expiry,role:'authenticated',label})).toString('base64url')+'.signature',
    refresh_token:'fixture-refresh-'+label, token_type:'bearer', expires_in:3600, expires_at:expiry,
    user:{id:uid,email:'fixture@example.invalid',aud:'authenticated'}
});
async function fixture(t, initial, network, manualTimeouts = false) {
    const timers = new Set(), storage = new Map(), deadlines = new Map();
    if (initial) storage.set('fixture-auth', JSON.stringify(initial));
    const context = vm.createContext({
        URL, Headers, Request, Response, AbortController, DOMException, TextEncoder, TextDecoder,
        console, crypto:globalThis.crypto, WebSocket:globalThis.WebSocket,
        setTimeout(fn, ms) { if(manualTimeouts && [10000,30000].includes(ms)){const timer={};deadlines.set(timer,{fn,ms});return timer;} const timer=setTimeout(()=>{timers.delete(timer);fn();}, ms);timers.add(timer);return timer; },
        clearTimeout(timer) { deadlines.delete(timer);timers.delete(timer);clearTimeout(timer); },
        setInterval, clearInterval,
        window:{fetch:network}, localStorage:{getItem:()=>null},
        initial, storage, config:{url,key},
        expire(ms){for(const [timer,entry] of deadlines)if(entry.ms===ms){deadlines.delete(timer);entry.fn();}}
    });
    t.after(()=>{for(const timer of timers)clearTimeout(timer);});
    vm.runInContext(fs.readFileSync(path.join(root,'vendor/supabase/supabase.js'),'utf8'),context);
    vm.runInContext(`
        let client, session=initial, authCycle=0, loggingOut=false, authPending=false;
        const LOCK='lock', activeRequests=new Set();
        let pushes=0, lastStatus='';
        function status(value) {lastStatus=value;}
        async function pushGoals() {pushes++;}
        ${transport}
        client=supabase.createClient(config.url,config.key,{global:{fetch:boundedFetch},auth:{
            autoRefreshToken:false,detectSessionInUrl:false,persistSession:true,storageKey:'fixture-auth',
            storage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}
        }});
        client.auth.onAuthStateChange((event,next)=>{
            if(event==='TOKEN_REFRESHED') pushAfterTokenRefresh(client,authCycle,next);
            if(next) session=next;
        });
        globalThis.harness={client,fetch:boundedFetch,expire,get pushes(){return pushes;},get rejected(){return needsReauthentication();},
            changeOwner(){session={user:{id:'another-user'}};authCycle++;},get lastStatus(){return lastStatus;}};
    `,context);
    await context.harness.client.auth.getSession();
    return context.harness;
}
const json = (body, status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const settle = () => new Promise(resolve=>setTimeout(resolve,15));

test('real SDK can sign in again after logout when mobile Auth takes more than ten seconds',async t=>{
    let release, started;
    const waiting=new Promise(resolve=>{started=resolve;});
    const h=await fixture(t,token('before-logout'),async(input,options)=>{
        if(String(input).includes('/auth/v1/logout'))return json({});
        started();
        await new Promise((resolve,reject)=>{
            release=resolve;
            options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
        });
        return json(token('after-logout'));
    },true);
    assert.equal((await h.client.auth.signOut({scope:'local'})).error,null);
    const login=h.client.auth.signInWithPassword({email:'fixture@example.invalid',password:'fixture-password'});
    await waiting;
    h.expire(10000); // The former transport cancelled the login here.
    release();
    const result=await login;
    assert.equal(result.error,null);
    assert.equal(result.data.session.access_token,token('after-logout').access_token);
});

test('Auth timeout has a useful reason even when WebView rejects with a generic abort',async t=>{
    let started;
    const waiting=new Promise(resolve=>{started=resolve;});
    const h=await fixture(t,null,async(input,options)=>{
        started();
        return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('signal is aborted without reason','AbortError')),{once:true}));
    },true);
    const request=h.fetch(url+'/auth/v1/token');
    const rejected=assert.rejects(request,error=>error.name==='TimeoutError' && /не ответил вовремя/.test(error.message));
    await waiting;h.expire(30000);await rejected;
});

test('real SDK refreshes an expired session and sends its JWT plus apikey to REST',async t=>{
    const fresh=token('fresh'), calls=[];
    const h=await fixture(t,token('expired',1),async(input,options)=>{
        calls.push({url:String(input),headers:new Headers(options.headers)});
        return String(input).includes('/auth/v1/token')?json(fresh):json([]);
    });
    const result=await h.client.from('goals').select('id');
    assert.equal(result.error,null);
    assert.equal(calls.filter(call=>call.url.includes('/auth/v1/token')).length,1);
    const rest=calls.find(call=>call.url.includes('/rest/v1/goals'));
    assert.equal(rest.headers.get('authorization'),'Bearer '+fresh.access_token);
    assert.equal(rest.headers.get('apikey'),key);
    await settle();assert.equal(h.pushes,1);
});

test('real SDK refreshes once for simultaneous 401s, including a late stale response',async t=>{
    const fresh=token('renewed');let refreshes=0, requests=0, releaseLate;
    const h=await fixture(t,token('old'),async(input,options)=>{
        if(String(input).includes('/auth/v1/token')) {refreshes++;return json(fresh);}
        requests++;
        if(new Headers(options.headers).get('authorization')==='Bearer '+fresh.access_token)return json([]);
        if(requests===2)await new Promise(resolve=>{releaseLate=resolve;});
        return json({code:'PGRST301',message:'JWT expired'},401);
    });
    const first=h.client.from('goals').select('id').then(value=>value);
    const second=h.client.from('goals').select('id').then(value=>value);
    assert.equal((await first).error,null);
    releaseLate();assert.equal((await second).error,null);
    assert.equal(refreshes,1);assert.equal(requests,4);
    await settle();assert.equal(h.pushes,1);
});

test('persistent 401 stops repeated HTTP requests and does not start another push',async t=>{
    let refreshes=0, requests=0;
    const h=await fixture(t,token('old'),async input=>{
        if(String(input).includes('/auth/v1/token')) {refreshes++;return json(token('rejected'));}
        requests++;return json({code:'PGRST301',message:'Invalid JWT'},401);
    });
    assert.equal((await h.client.from('goals').select('id')).status,401);
    await settle();assert.equal(h.rejected,true);assert.equal(h.pushes,0);
    await h.client.from('goals').select('id');
    assert.equal(refreshes,1);assert.equal(requests,2);
    assert.match(h.lastStatus,/Войдите повторно/);
});

test('anonymous registration RPC uses publishable key only as apikey and never refreshes on 401',async t=>{
    const calls=[];
    const h=await fixture(t,null,async(input,options)=>{calls.push({url:String(input),headers:new Headers(options.headers)});return json({message:'Unauthorized'},401);});
    const result=await h.client.rpc('ncd_handle_available',{candidate:'fixture'});
    assert.equal(result.status,401);assert.equal(calls.length,1);
    assert.equal(calls[0].headers.get('authorization'),null);
    assert.equal(calls[0].headers.get('apikey'),key);
    assert.equal(h.rejected,false);
});

test('rejected refresh token retains local session and offers sign-in without a retry loop',async t=>{
    let refreshes=0, requests=0;
    const h=await fixture(t,token('old'),async input=>{
        if(String(input).includes('/auth/v1/token')) {refreshes++;return json({code:'refresh_token_not_found',message:'Invalid Refresh Token'},400);}
        requests++;return json({code:'PGRST301',message:'JWT expired'},401);
    });
    assert.ok((await h.client.from('goals').select('id')).error);
    assert.equal(h.rejected,true);await settle();assert.equal(h.pushes,0);
    assert.equal(refreshes,1);assert.equal(requests,1);
});

test('Request uploads replay their body and are cancelled if the account changes during refresh',async t=>{
    const fresh=token('fresh'), bodies=[];let h;
    h=await fixture(t,token('old'),async(input,options)=>{
        if(String(input).includes('/auth/v1/token'))return json(fresh);
        if (typeof input.text === 'function') bodies.push(await input.text());
        return new Headers(options.headers).get('authorization')==='Bearer '+fresh.access_token?json({}):json({},401);
    });
    const response=await h.fetch(new Request(url+'/storage/v1/object/test',{method:'POST',body:'attachment'}));
    assert.equal(response.status,200);assert.deepEqual(bodies,['attachment','attachment']);
    h.client.auth.refreshSession=async()=>{h.changeOwner();return {data:{session:fresh},error:null};};
    // Force a stale-token rejection after a different session was accepted by the server.
    h.client.auth.getSession=async()=>({data:{session:token('old')}});
    await assert.rejects(h.fetch(url+'/rest/v1/goals'),/SUPABASE_SESSION_CHANGED/);
});

test('missing SDK session blocks private data requests and exposes reauthentication',async t=>{
    let requests=0;
    const h=await fixture(t,token('cached'),async()=>{requests++;return json([]);});
    h.client.auth.getSession=async()=>({data:{session:null},error:null});
    await assert.rejects(h.fetch(url+'/rest/v1/goals'),/SUPABASE_SESSION_REQUIRED/);
    assert.equal(requests,0);assert.equal(h.rejected,true);
});

test('A stalled SDK getSession cannot keep a data request pending past its deadline',async t=>{
 let requests=0;
 const h=await fixture(t,token('cached'),async()=>{requests++;return json([]);},true);
 h.client.auth.getSession=()=>new Promise(()=>{});
 const request=h.fetch(url+'/rest/v1/goals');
 const rejected=assert.rejects(request,error=>error.name==='TimeoutError');
 await new Promise(resolve=>setImmediate(resolve));h.expire(10000);await rejected;
 assert.equal(requests,0);
});
