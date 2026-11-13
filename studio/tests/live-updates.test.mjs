import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness(refresh){
 const context=vm.createContext({document:{addEventListener(){}},window:{addEventListener(){}},console,URL,Set,Map,Date});
 const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/boot\(\);\s*$/,'').replace(/^import .*;\n/gm,'');
 vm.runInContext(source+'\nglobalThis.start=createLiveUpdates;',context);
 let now=0,next=0;const timers=new Map(),handlers=new Map(),visibility=new Map();
 const clock={setTimeout(fn,delay){const id=++next;timers.set(id,{fn,time:now+delay});return id;},clearTimeout(id){timers.delete(id);},setInterval(fn,delay){const id=++next;timers.set(id,{fn,time:now+delay,repeat:delay});return id;},clearInterval(id){timers.delete(id);}};
 const events={addEventListener(name,fn){handlers.set(name,fn);},close(){this.closed=true;}};
 const doc={visibilityState:'visible',addEventListener(name,fn){visibility.set(name,fn);},removeEventListener(name){visibility.delete(name);}};
 const live=context.start({refresh,events,doc,clock});
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 async function advance(ms){const end=now+ms;for(;;){const entry=[...timers].filter(([,t])=>t.time<=end).sort((a,b)=>a[1].time-b[1].time)[0];if(!entry)break;const [id,timer]=entry;now=timer.time;if(timer.repeat)timer.time+=timer.repeat;else timers.delete(id);timer.fn();await settle();}now=end;}
 return {live,events,doc,timers,advance,settle,emit:name=>handlers.get(name)?.(),visibility:()=>visibility.get('visibilitychange')?.()};
}

test('continuous generation messages cannot starve live deck refreshes',async()=>{
 let calls=0;const h=harness(async()=>{calls++;});
 for(let i=0;i<20;i++){h.emit('change');await h.advance(100);}
 assert.ok(calls>=6,`Only ${calls} refreshes during a continuous stream`);
 h.live.dispose();
});

test('live refreshes serialize slow requests and retain a completion received in flight',async()=>{
 let calls=0,release;const h=harness(()=>{calls++;return calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve();});
 h.emit('change');await h.advance(250);assert.equal(calls,1);
 for(let i=0;i<10;i++)h.emit('change');await h.advance(1000);assert.equal(calls,1);
 release();await h.settle();await h.advance(250);assert.equal(calls,2);
 h.live.dispose();
});

test('polling, reconnects and returning to the tab recover missed generation events',async()=>{
 let calls=0;const h=harness(async()=>{calls++;});
 await h.advance(10250);assert.equal(calls,1);
 h.doc.visibilityState='hidden';await h.advance(20000);assert.equal(calls,1);
 h.doc.visibilityState='visible';h.visibility();await h.advance(250);assert.equal(calls,2);
 h.emit('open');await h.advance(250);assert.equal(calls,3);
 h.live.dispose();assert.equal(h.events.closed,true);assert.equal(h.timers.size,0);
});
