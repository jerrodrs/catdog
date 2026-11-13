import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {inside} from './runner.mjs';import {availableParallelism} from 'node:os';
const run=promisify(execFile);
const COLOURS={W:'White',U:'Blue',B:'Black',R:'Red',G:'Green'};
const PAIRS=['WU','UB','BR','RG','GW','WB','UR','BG','RW','GU'];
// Matches cardforge.frames.template_key: pairs and 3+ colours have their own palettes, none is colourless.
export function paletteFamily(card){
 const s=card.summary||{},face=s.faces?.[0]||s,source=card.entry_kind==='token'&&card.token_spec?.colors?card.token_spec:face;
 const colours=[...new Set((source.colors||[]).filter(c=>c!=='C'))];
 if(colours.length===2)return PAIRS.find(p=>colours.every(c=>p.includes(c)));
 return colours.length===1?colours[0]:colours.length?'M':'C';
}
const typeLine=card=>{const s=card.summary||{};return (card.entry_kind==='token'&&card.token_spec?.type_line)||s.faces?.[0]?.type_line||s.type_line||'';};
const legendary=card=>/\bLegendary\b/.test(typeLine(card).split(' — ')[0]);
const familyLabel=family=>COLOURS[family]||(family==='M'?'Multicolour':family==='C'?'Colourless':[...family].map(c=>COLOURS[c]).join('–'));
// Ordinary single-faced spells/creatures show a palette most plainly; lands and tokens are last resorts.
const plainness=card=>(card.section==='sideboard')*8+(card.entry_kind==='token')*4+(!!card.summary?.faces)*2+/\bLand\b/.test(typeLine(card));
export function frameSamples(deck){
 const eligible=deck.cards.filter(c=>c.active_version_id&&c.art_mode!=='official'&&c.summary&&Object.keys(c.summary).length);
 const byFamily=new Map();for(const card of eligible){const family=paletteFamily(card);if(!byFamily.has(family))byFamily.set(family,[]);byFamily.get(family).push(card);}
 const pick=cards=>[...cards].sort((a,b)=>legendary(a)-legendary(b)||plainness(a)-plainness(b))[0];
 const samples=[];
 for(const family of Object.keys(COLOURS))if(byFamily.has(family))samples.push({key:family,family,card:pick(byFamily.get(family))});
 // One multicolour slot: the deck's most common multicolour palette.
 const multi=[...byFamily.keys()].filter(f=>f==='M'||PAIRS.includes(f)).sort((a,b)=>byFamily.get(b).length-byFamily.get(a).length)[0];
 if(multi)samples.push({key:'multicolour',family:multi,card:pick(byFamily.get(multi))});
 if(byFamily.has('C'))samples.push({key:'C',family:'C',card:pick(byFamily.get('C'))});
 const used=new Set(samples.map(s=>s.card.id)),legends=eligible.filter(legendary).sort((a,b)=>(b.section==='commander')-(a.section==='commander')||used.has(a.id)-used.has(b.id)||plainness(a)-plainness(b));
 if(legends[0])samples.push({key:'legendary',family:paletteFamily(legends[0]),card:legends[0],legendary:true});
 return samples.map(({key,family,card,legendary:legend})=>({key,family,label:legend?(card.section==='commander'?'Legendary · commander':'Legendary'):familyLabel(family),card_id:card.id,name:card.name,version_id:card.active_version_id}));
}
export class DeckFramePreview{
 constructor(store,root,frames,borders,{python='python3',runPreview=run}={}){
  Object.assign(this,{store,root,frames,borders,python,runPreview});
  this.active={native:0,mse:0};this.waiters={native:[],mse:[]};this.inflight=new Map();this.interests=new Map();this.selections=new Map();this.controllers=new Map();this.msePending=[];this.mseRunning=false;this.mseTimer=null;
  this.limits={native:Math.min(3,availableParallelism()),mse:1};
  const sources=['studio/preview_deck_frame.py','studio/verify_result.py','assets/frame-palettes.json',...fs.readdirSync(path.join(root,'cardforge')).filter(f=>f.endsWith('.py')).sort().map(f=>'cardforge/'+f)];
  this.code=createHash('sha256').update(sources.map(f=>fs.readFileSync(path.join(root,f))).join('\0')).digest('hex');
 }
 frame(frameSetId){const snapshot=this.frames.snapshot(frameSetId);if(snapshot.config_path&&!this.inside(snapshot.config_path))throw new Error('Frame configuration is outside the library.');return snapshot;}
 inside(filename){return inside(this.root,filename)||inside(this.store.directory,filename);}
 selectionKey(deck,session){return session?deck.id+':'+deck.active_art_set_id+':'+String(session).slice(0,128):null;}
 frameKey(frame){return frame.id+':'+frame.version_id+':'+frame.rules_sizing;}
 select(deck,frame,session,generation=0){
  const key=this.selectionKey(deck,session);if(!key)return;
  generation=Number(generation)||0;
  if(generation<(this.selections.get(key)?.generation||0))return;
  this.selections.delete(key);this.selections.set(key,{frame:this.frameKey(frame),generation});
  while(this.selections.size>64)this.selections.delete(this.selections.keys().next().value);
  for(const [jobKey,controller] of this.controllers)if(!this.wanted(jobKey))controller.abort();
 }
 current(deck,frame,session){const key=this.selectionKey(deck,session);return !key||this.selections.get(key)?.frame===this.frameKey(frame);}
 stamp(filename){if(!this.inside(filename))throw new Error('Preview asset is outside the library.');const stat=fs.statSync(filename);return [filename,stat.size,stat.mtimeMs,stat.ctimeMs];}
 job(deck,frame,cardId){
  const card=deck.cards.find(c=>c.id===cardId);if(!card?.active_version_id||card.art_mode==='official')throw new Error('Choose an illustrated custom card from this deck.');
  const version=this.store.get('SELECT * FROM versions WHERE id=?',card.active_version_id);if(!version?.manifest_path||!fs.existsSync(version.manifest_path)||!this.inside(version.manifest_path))throw new Error('This card version has no saved manifest to preview.');
  const source=path.join(path.dirname(version.manifest_path),'source-manifest.json'),manifest=fs.existsSync(source)?source:version.manifest_path,data=JSON.parse(fs.readFileSync(manifest,'utf8')),summary=JSON.parse(version.summary||'{}');
  const saved=data.cards?.find(c=>c.id===summary.id)||data.cards?.[0];if(!saved)throw new Error('This version has no saved card to preview.');
  const front=saved.faces?.[0]||saved;
  const dependencies=[this.stamp(manifest),...(front.art?[this.stamp(path.resolve(path.dirname(manifest),front.art))]:[])];
  const config=frame.config_path?JSON.parse(fs.readFileSync(frame.config_path,'utf8')):null;
  if(frame.config_path)dependencies.push(this.stamp(frame.config_path));
  const request={manifest_path:version.manifest_path,card_id:summary.id,card:{entry_kind:card.entry_kind,token_spec:card.token_spec,customization:card.customization},frame_set:{config_path:frame.config_path||null,rules_sizing:frame.rules_sizing},allowed_roots:[this.root,this.store.directory],border_settings:this.borders.settings(version),width:900};
  const key=createHash('sha256').update(JSON.stringify({version:version.id,frame:frame.version_id,request,dependencies,code:this.code,border_code:this.borders.code})).digest('hex');
  const directory=path.join(this.store.directory,'frame-preview-cache');
  return {key,request,frame,directory,destination:path.join(directory,key+'.png'),lane:config?.renderer==='mse'?'mse':'native'};
 }
 list(deck,frameSetId,session='',generation=0){
  const frame=this.frame(frameSetId);this.select(deck,frame,session,generation);
  const result={frame:{id:frame.id,name:frame.name,version_id:frame.version_id},samples:frameSamples(deck).map(sample=>{
   try{return {...sample,preview_key:this.job(deck,frame,sample.card_id).key};}catch(e){return {...sample,error:e.message};}
  })};
  // Start the entire MSE sample set together, even when the browser limits
  // concurrent image requests to fewer connections than there are samples.
  if(session&&this.current(deck,frame,session)&&frame.config_path&&JSON.parse(fs.readFileSync(frame.config_path,'utf8')).renderer==='mse')
   for(const sample of result.samples)if(sample.preview_key)void this.image(deck,frameSetId,sample.card_id,{session,expectedKey:sample.preview_key}).catch(()=>{});
  return result;
 }
 wanted(key){return [...(this.interests.get(key)?.values()||[])].some(interest=>this.current(interest.deck,interest.frame,interest.session));}
 queueMse(job){
  return new Promise((resolve,reject)=>{
   this.msePending.push({job,resolve,reject});
   if(!this.mseTimer&&!this.mseRunning)this.mseTimer=setTimeout(()=>{this.mseTimer=null;void this.flushMse();},35);
  });
 }
 async flushMse(){
  if(this.mseRunning)return;
  const waiting=this.msePending.splice(0),ready=[];
  for(const item of waiting)if(this.wanted(item.job.key))ready.push(item);else item.reject(new Error('A different frame preview was selected.'));
  if(!ready.length)return;
  const first=ready[0].job,group=item=>item.job.request.frame_set.config_path===first.request.frame_set.config_path&&item.job.frame.version_id===first.frame.version_id;
  const batch=ready.filter(group).slice(0,8),included=new Set(batch);
  this.msePending.push(...ready.filter(item=>!included.has(item)));
  this.mseRunning=true;
  try{
   fs.mkdirSync(first.directory,{recursive:true});
   const input=path.join(first.directory,'batch-'+createHash('sha256').update(batch.map(item=>item.job.key).join(':')).digest('hex')+'.json');
   fs.writeFileSync(input,JSON.stringify({jobs:batch.map(({job})=>({...job.request,destination:job.destination}))}));
   const {stdout}=await this.runPreview(this.python,[path.join(this.root,'studio/preview_deck_frame.py'),input],{cwd:this.root,timeout:120000,maxBuffer:1000000});
   const results=JSON.parse(stdout).results;
   for(const [index,item] of batch.entries()){
    const result=results?.[index];
    if(result?.error||!result?.image_path||!fs.existsSync(item.job.destination))item.reject(new Error(result?.error||'Frame preview was not produced.'));else item.resolve();
   }
  }catch(e){for(const item of batch)item.reject(new Error((e.stderr||'').trim().split('\n').at(-1)||e.message));}
  finally{this.mseRunning=false;if(this.msePending.length)void this.flushMse();}
 }
 async image(deck,frameSetId,cardId,{session='',expectedKey=null}={}){
  const frame=this.frame(frameSetId),job=this.job(deck,frame,cardId),{key,request,directory,destination,lane}=job;
  if(expectedKey&&expectedKey!==key)throw new Error('Preview inputs changed. Reopen the frame preview.');
  if(!this.current(deck,frame,session))throw new Error('A different frame preview was selected.');
  if(fs.existsSync(destination))return destination;
  if(!this.interests.has(key))this.interests.set(key,new Map());
  this.interests.get(key).set(this.selectionKey(deck,session),{deck,frame,session});
  if(!this.inflight.has(key))this.inflight.set(key,(async()=>{
   try{
    if(lane==='mse'){await this.queueMse(job);return;}
    if(this.active.native>=this.limits.native)await new Promise(resolve=>this.waiters.native.push(resolve));
    this.active.native++;
    try{
     if(!this.wanted(key))throw new Error('A different frame preview was selected.');
     if(fs.existsSync(destination))return;
     fs.mkdirSync(directory,{recursive:true});const input=path.join(directory,key+'.json');fs.writeFileSync(input,JSON.stringify({...request,destination}));
     const controller=new AbortController();this.controllers.set(key,controller);
     await this.runPreview(this.python,[path.join(this.root,'studio/preview_deck_frame.py'),input],{cwd:this.root,timeout:120000,maxBuffer:1000000,signal:controller.signal});
    }finally{this.active.native--;this.waiters.native.shift()?.();this.controllers.delete(key);}
   }catch(e){throw new Error((e.stderr||'').trim().split('\n').at(-1)||e.message);}
   finally{this.inflight.delete(key);this.interests.delete(key);}
  })());
  await this.inflight.get(key);
  return destination;
 }
}
