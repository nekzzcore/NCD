const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../health-3d.js'),'utf8');
function fixture(continuous=true,isMobile=false){
 let now=0,id=0,active=continuous;const rafs=new Map(),timers=new Map(),frames=[];
 const context={performance:{now:()=>now},requestAnimationFrame:fn=>{rafs.set(++id,fn);return id;},cancelAnimationFrame:id=>rafs.delete(id),setTimeout:(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id)};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('    function createFrameLoop('),source.indexOf('    function initHealth3D('))+'\nthis.makeLoop=createFrameLoop;',context);
 const loop=context.makeLoop(dt=>{frames.push({time:now,dt});return false;},()=>active,isMobile);
 return {loop,frames,rafs,timers,setActive:value=>active=value,tick(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}const callbacks=[...rafs.values()];rafs.clear();callbacks.forEach(fn=>fn(now));}};
}
test('Mobile animated scene never renders above 30 FPS, with delta independent of display refresh rate',()=>{
 for(const hz of [60,120,144]){
  const h=fixture(true,true);h.loop.start();for(let i=0;i<hz*2;i++)h.tick(1000/hz);
  assert.ok(h.frames.length>20);assert.ok(h.frames.length<=61);
  for(let i=1;i<h.frames.length;i++){
   const elapsed=h.frames[i].time-h.frames[i-1].time;assert.ok(elapsed>=1000/30-0.01);assert.ok(Math.abs(h.frames[i].dt-elapsed/1000)<0.0001);
  }
 }
});
test('Static scene goes idle and coalesces controls/resize changes into one render',()=>{
 const h=fixture(false);h.loop.start();h.tick(1);assert.equal(h.frames.length,1);assert.equal(h.rafs.size+h.timers.size,0);
 for(let i=0;i<10;i++)h.loop.invalidate();assert.equal(h.rafs.size+h.timers.size,1);
 h.tick(40);assert.equal(h.frames.length,2);assert.equal(h.rafs.size+h.timers.size,0);
});
test('Leaving health stops both pending RAF and timer; re-entry starts with zero delta',()=>{
 const h=fixture(true,true);h.loop.start();assert.equal(h.rafs.size,1);h.loop.stop();assert.equal(h.rafs.size,0);
 h.loop.start();h.tick(1);assert.equal(h.timers.size,1);h.loop.stop();assert.equal(h.timers.size,0);
 h.tick(5000);assert.equal(h.frames.length,1);h.loop.invalidate();assert.equal(h.rafs.size+h.timers.size,0);
 h.loop.start();h.tick(1);assert.equal(h.frames.at(-1).dt,0);
});

 test('Desktop renders on every native RAF at 60, 120 and 144 Hz without throttle timers',()=>{
 for(const hz of [60,120,144]){
  const h=fixture();h.loop.start();
  for(let i=0;i<hz*2;i++){h.tick(1000/hz);assert.equal(h.timers.size,0);}
  assert.equal(h.frames.length,hz*2);
  for(const frame of h.frames.slice(1))assert.ok(Math.abs(frame.dt-1/hz)<0.0001);
  h.loop.stop();assert.equal(h.rafs.size,0);h.tick(1000);assert.equal(h.frames.length,hz*2);
 }
});

