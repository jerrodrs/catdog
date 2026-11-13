import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../store.mjs';import {JobQueue} from '../runner.mjs';
const root=path.resolve(new URL('../..',import.meta.url).pathname);
async function finished(queue,jobId){const start=Date.now();while(Date.now()-start<20000){const job=queue.store.get('SELECT * FROM jobs WHERE id=?',jobId);if(['succeeded','failed','cancelled'].includes(job.status))return job;await new Promise(r=>setTimeout(r,30));}throw Error('Provider workflow timed out');}
function stallQueue(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'card-studio-stall-')),store=new Store(dir),queue=new JobQueue(store,root,{binary:'/does-not-exist-codex',grokBinary:path.join(root,'studio/tests/fixtures/fake-grok-card.py'),imageProviderStatus:()=>[{id:'grok-cli',available:true}],stallMs:400,stallRetryMs:10});t.after(async()=>{queue.close();while(queue.activeJobs.size)await new Promise(r=>setTimeout(r,20));store.close();fs.rmSync(dir,{recursive:true,force:true});});const deck=store.createDeck({name:'Stalled Grok stream',image_provider:'grok-cli',style:'A test art direction'},[{name:'Sol Ring',quantity:1,section:'main'}]);return {store,queue,deck};}

test('a silent provider stream is killed and retried in a fresh attempt directory',async t=>{
 const {store,queue,deck}=stallQueue(t);
 const job=await finished(queue,queue.enqueue(deck.id,{mode:'all',instructions:'GROK_STALL_ONCE'})[0]);assert.equal(job.status,'succeeded',job.error);assert.equal(job.retry_count,1);assert.match(job.directory,/attempt-2$/);
 const events=store.all('SELECT kind FROM events WHERE job_id=?',job.id).map(e=>e.kind);assert.ok(events.includes('stalled'));assert.ok(events.includes('agent_thinking'));
 assert.equal(queue.cooldownFor('grok-cli')<=Date.now(),true);
});
test('a provider that keeps stalling fails clearly after the stall retry limit',async t=>{
 const {queue,deck}=stallQueue(t);
 const job=await finished(queue,queue.enqueue(deck.id,{mode:'all',instructions:'GROK_STALL_ALWAYS'})[0]);assert.equal(job.status,'failed');assert.equal(job.retry_count,2);assert.match(job.error,/no output .* stalled/);
});
