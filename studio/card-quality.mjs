import fs from 'node:fs';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {id,now} from './store.mjs';
const run=promisify(execFile);
export class CardQuality {
 constructor(store,root,{notify=()=>{},python='python3',workers=2,autoStart=true}={}){
  Object.assign(this,{store,root,notify,python,workers});this.active=new Set();this.closed=false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS quality_jobs(id TEXT PRIMARY KEY,card_id TEXT NOT NULL,art_set_id TEXT NOT NULL,source_version_id TEXT NOT NULL,version_id TEXT NOT NULL,status TEXT NOT NULL,directory TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);CREATE INDEX IF NOT EXISTS quality_jobs_status ON quality_jobs(status,created_at)`);
  if(!store.all('PRAGMA table_info(quality_jobs)').some(c=>c.name==='owner_pid'))store.db.exec('ALTER TABLE quality_jobs ADD COLUMN owner_pid INTEGER');
  for(const job of store.all("SELECT id,owner_pid FROM quality_jobs WHERE status='running'")){let alive=false;try{if(job.owner_pid){process.kill(job.owner_pid,0);alive=true;}}catch{}if(!alive)store.run("UPDATE quality_jobs SET status='queued',error=NULL WHERE id=?",job.id);}
  if(autoStart){this.timer=setInterval(()=>{try{this.schedule();const status=JSON.stringify(this.store.all('SELECT status,COUNT(*) n FROM quality_jobs GROUP BY status'));if(status!==this.lastStatus){this.lastStatus=status;this.notify();}}catch(error){console.error('Quality queue waiting for database:',error.message);}},1500);this.timer.unref();this.schedule();}
 }
 list(){return this.store.all('SELECT q.*,c.name AS card_name,d.name AS deck_name,s.name AS art_set_name FROM quality_jobs q LEFT JOIN cards c ON c.id=q.card_id LEFT JOIN decks d ON d.id=c.deck_id LEFT JOIN deck_art_sets s ON s.id=q.art_set_id ORDER BY q.created_at DESC,q.rowid DESC');}
 enqueue({deck_id=null,card_ids=null}={}){
  if(card_ids!==null&&(!Array.isArray(card_ids)||!card_ids.length||card_ids.some(id=>typeof id!=='string')))throw Error('Choose cards to refresh.');
  const rows=this.store.all(`SELECT c.id AS card_id,c.deck_id,s.id AS set_id,v.* FROM deck_art_sets s JOIN decks d ON d.id=s.deck_id JOIN cards c ON c.deck_id=d.id LEFT JOIN deck_art_cards ac ON ac.set_id=s.id AND ac.card_id=c.id JOIN versions v ON v.id=CASE WHEN s.id=d.active_art_set_id THEN c.active_version_id ELSE ac.version_id END WHERE v.source_type='custom'${deck_id?' AND d.id=?':''}`, ...(deck_id?[deck_id]:[]));
  let queued=0,already_current=0;this.store.transaction(()=>{for(const row of rows){if(card_ids&&!card_ids.includes(row.card_id))continue;
   let report={};try{report=JSON.parse(fs.readFileSync(row.report_path));}catch{}if(report.dpi>=1200){already_current++;continue;}
   if(this.store.get("SELECT id FROM quality_jobs WHERE source_version_id=? AND art_set_id=? AND status IN ('queued','running','succeeded')",row.id,row.set_id))continue;
   if(!row.manifest_path||!fs.existsSync(row.manifest_path))throw Error('Saved artwork manifest is missing for '+JSON.parse(row.summary).name);
   const jobId=id(),versionId=id(),directory=path.join(this.store.directory,'decks',row.deck_id,'cards',row.card_id,'versions',versionId);fs.mkdirSync(directory,{recursive:true});
   fs.writeFileSync(path.join(directory,'style.txt'),row.style_text||'');fs.writeFileSync(path.join(directory,'scene.json'),row.scene_json||'{}');
   fs.writeFileSync(path.join(directory,'quality-request.json'),JSON.stringify({source_version_id:row.id,manifest_path:row.manifest_path,card_id:JSON.parse(row.summary).id,directory}));
   this.store.run("INSERT INTO quality_jobs(id,card_id,art_set_id,source_version_id,version_id,status,directory,error,created_at,finished_at) VALUES(?,?,?,?,?,'queued',?,NULL,?,NULL)",jobId,row.card_id,row.set_id,row.id,versionId,directory,now());queued++;
  }},{immediate:true});this.notify();this.schedule();return {queued,already_current};
 }
 schedule(){if(this.closed)return;while(this.active.size<this.workers){const global=this.store.get("SELECT COUNT(*) n FROM quality_jobs WHERE status='running'").n;if(global>=this.workers)return;
  const job=this.store.get("SELECT * FROM quality_jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1");if(!job)return;
  if(!this.store.run("UPDATE quality_jobs SET status='running',owner_pid=? WHERE id=? AND status='queued'",process.pid,job.id).changes)continue;
  const task=this.work(job).catch(error=>{console.error('Quality refresh will recover on restart:',job.id,error.message);}).finally(()=>{this.active.delete(task);this.notify();this.schedule();});this.active.add(task);
 }}
 async work(job){try{
  const source=this.store.get('SELECT * FROM versions WHERE id=?',job.source_version_id);if(!source||source.source_type!=='custom')throw Error('Source custom version no longer exists.');
  const {stdout}=await run(this.python,[path.join(this.root,'studio/refresh_quality.py'),path.join(job.directory,'quality-request.json')],{timeout:180000,maxBuffer:4000000});
  const built=JSON.parse(stdout.trim().split('\n').at(-1));
  this.store.transaction(()=>{
   this.store.addVersion(job.card_id,{...built,id:job.version_id,style_text:source.style_text,scene_json:source.scene_json,customization_json:source.customization_json,art_provider:source.art_provider,note:'1200 PPI quality refresh · existing artwork preserved'},{artSetId:job.art_set_id,activate:false});
   const card=this.store.get('SELECT * FROM cards WHERE id=?',job.card_id),deck=this.store.get('SELECT active_art_set_id FROM decks WHERE id=?',card.deck_id);
   if(deck.active_art_set_id===job.art_set_id&&card.active_version_id===source.id){this.store.activate(card.id,job.version_id);this.store.run('UPDATE cards SET approval=? WHERE id=?',card.approval,card.id);}
   else if(deck.active_art_set_id!==job.art_set_id){const saved=this.store.get('SELECT * FROM deck_art_cards WHERE set_id=? AND card_id=?',job.art_set_id,card.id);if(saved?.version_id===source.id){const state=JSON.parse(saved.state_json);state.active_version_id=job.version_id;this.store.run('UPDATE deck_art_cards SET version_id=?,state_json=? WHERE set_id=? AND card_id=?',job.version_id,JSON.stringify(state),job.art_set_id,card.id);}}
   this.store.run("UPDATE quality_jobs SET status='succeeded',finished_at=? WHERE id=?",now(),job.id);this.store.touch(card.deck_id);
  },{immediate:true});
 }catch(error){this.store.run("UPDATE quality_jobs SET status='failed',error=?,finished_at=? WHERE id=?",String(error.message).slice(-4000),now(),job.id);}}
 retry(jobId){const job=this.store.get("SELECT * FROM quality_jobs WHERE id=? AND status='failed'",jobId);if(!job)throw Error('Choose a failed quality refresh.');this.store.run("UPDATE quality_jobs SET status='queued',error=NULL,finished_at=NULL WHERE id=?",jobId);this.notify();this.schedule();return {ok:true};}
 async close(){this.closed=true;clearInterval(this.timer);await Promise.allSettled([...this.active]);}
}
