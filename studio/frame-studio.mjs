import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {id,now,cleanText} from './store.mjs';
import {inside} from './runner.mjs';
import {rateLimitWait} from './rate-limits.mjs';
import {visualEdits,previewContext} from './frame-visual.mjs';
import {frameControls} from './frame-controls.mjs';
import {briefFields,candidatePlan,candidateRequest,reviewArt,designerPrompt} from './frame-design.mjs';
import {frameDeckSource,frameDeckContext} from './frame-deck-context.mjs';

// Frame generation always runs at this effort, overriding ~/.codex/config.toml.
const CODEX_REASONING_EFFORT='high';
export const FRAME_LAYOUTS=['creature','artifact','enchantment','instant','sorcery','land','planeswalker','token','transform_front','transform_back','adventure','prepare','saga'];
export const BUILTIN_FRAME={id:'builtin-v2.4',name:'Bloomburrow inspired',brief:'Bloomburrow-inspired borderless frames with coloured bevels, legendary crests, attached original-name tabs, translucent rules panels and real Magic typography.',status:'ready',builtin:true,layouts:FRAME_LAYOUTS};

// Concept notes are free-form: lists are joined and long text trimmed rather than failing a finished design.
const conceptText=(value,max)=>cleanText((Array.isArray(value)?value.join(', '):typeof value==='string'?value:value==null?'':String(value)).replaceAll('\0','').slice(0,max),max);
// A printed Magic frame treatment to recreate: its name, notes and real reference cards (local images, with sources).
function frameReference(frames,value){
  if(value==null)return {};
  if(typeof value!=='object'||Array.isArray(value))throw new Error('Invalid frame reference.');
  const images=value.images||[];if(!Array.isArray(images)||images.length>6)throw new Error('Use at most six reference images.');
  return {title:cleanText(value.title||'',160),set_code:cleanText(value.set_code||'',12),set_name:cleanText(value.set_name||'',120),treatment:cleanText(value.treatment||'',160),notes:cleanText(value.notes||'',4000),
   images:images.map(image=>{const file=fs.realpathSync(path.resolve(frames.root,String(image?.path||'')));if(!(inside(frames.root,file)||inside(frames.store.directory,file))||!/\.(png|jpe?g)$/i.test(file))throw new Error('Reference images must be local PNG or JPEG files inside the project or library.');
    return {path:file,name:cleanText(image.name||'',200),source_url:cleanText(image.source_url||'',500),artist:cleanText(image.artist||'',200)};})};
}
// Each version keeps its own copy of the reference cards it was designed from.
function snapshotReference(reference,directory){
  if(!reference?.title&&!reference?.images?.length)return null;
  const folder=path.join(directory,'references');fs.mkdirSync(folder,{recursive:true});
  return {...reference,images:(reference.images||[]).filter(image=>fs.existsSync(image.path)).map((image,i)=>{const target=path.join(folder,`reference-${i}${path.extname(image.path).toLowerCase()}`);fs.copyFileSync(image.path,target);return {...image,path:target,original_path:image.path};})};
}
// The designer's concept step: 2–3 distinct ideas and the chosen one, whose level must match the option's target.
function frameConcept(directory,target){
  const file=path.join(directory,'concept.json');if(!fs.existsSync(file))throw new Error('The frame designer did not record its concepts (concept.json).');
  const data=JSON.parse(fs.readFileSync(file,'utf8')),concepts=Array.isArray(data.concepts)?data.concepts:[],chosen=concepts[data.chosen];
  if(concepts.length<2||!chosen)throw new Error('concept.json needs at least two concepts and a valid chosen index.');
  if(!['classic','stylised','showcase'].includes(chosen.flavour_level))throw new Error('The chosen concept needs a flavour_level of classic, stylised or showcase.');
  if(target&&chosen.flavour_level!==target)throw new Error(`This option targets the ${target} flavour level, but its chosen concept is ${chosen.flavour_level}.`);
  return {name:conceptText(chosen.name||'',120),signature_element:conceptText(chosen.signature_element||'',400),flavour_level:chosen.flavour_level,motif:conceptText(chosen.motif||'',400),materials:conceptText(chosen.materials||'',400),rationale:conceptText(data.rationale||'',1200),alternatives:concepts.filter(c=>c!==chosen).map(c=>conceptText(c.name||'',120))};
}
export class FrameStudio{
  constructor(store,root,queue,notify,options={}){
    this.store=store;this.root=root;this.queue=queue;this.notify=notify;this.options=options;this.running=new Map();this.closed=false;this.timer=null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS frame_sets(id TEXT PRIMARY KEY,name TEXT NOT NULL,brief TEXT NOT NULL,current_version_id TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS frame_versions(id TEXT PRIMARY KEY,set_id TEXT NOT NULL REFERENCES frame_sets(id),status TEXT NOT NULL,directory TEXT NOT NULL,config_path TEXT,proof_path TEXT,error TEXT,progress TEXT,created_at TEXT NOT NULL,finished_at TEXT,retry_count INTEGER NOT NULL DEFAULT 0,not_before TEXT);`);
    for(const table of ['frame_sets','frame_versions'])if(!store.all(`PRAGMA table_info(${table})`).some(c=>c.name==='controls'))store.db.exec(`ALTER TABLE ${table} ADD COLUMN controls TEXT NOT NULL DEFAULT '{}'`);
    for(const table of ['frame_sets','frame_versions'])if(!store.all(`PRAGMA table_info(${table})`).some(c=>c.name==='visual_edits'))store.db.exec(`ALTER TABLE ${table} ADD COLUMN visual_edits TEXT NOT NULL DEFAULT '{}'`);
    if(!store.all('PRAGMA table_info(frame_sets)').some(c=>c.name==='deck_art_set_id'))store.db.exec("ALTER TABLE frame_sets ADD COLUMN deck_art_set_id TEXT NOT NULL DEFAULT ''");
    // Structured brief fields, and the three-option groups: picked_group records that the user chose from that group.
    for(const [table,column,type]of [['frame_sets','template_source',"TEXT NOT NULL DEFAULT ''"],['frame_sets','brief_fields',"TEXT NOT NULL DEFAULT '{}'"],['frame_sets','picked_group',"TEXT NOT NULL DEFAULT ''"],['frame_sets','reference',"TEXT NOT NULL DEFAULT '{}'"],['frame_versions','candidate_group',"TEXT NOT NULL DEFAULT ''"],['frame_versions','candidate_direction',"TEXT NOT NULL DEFAULT ''"],['frame_versions','concept',"TEXT NOT NULL DEFAULT '{}'"]])
      if(!store.all(`PRAGMA table_info(${table})`).some(c=>c.name===column))store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    this.livePreviewChildren=new Set();
    this.previewTasks=new Map();this.previewChain=Promise.resolve();
    const builtinDirectory=path.join(store.directory,'frame-sets',BUILTIN_FRAME.id,'versions','included-v1');fs.mkdirSync(builtinDirectory,{recursive:true});
    store.transaction(()=>{
      store.run('INSERT OR IGNORE INTO frame_sets(id,name,brief,current_version_id,created_at) VALUES(?,?,?,?,?)',BUILTIN_FRAME.id,store.get("SELECT value FROM settings WHERE key='builtin_frame_name'")?.value||BUILTIN_FRAME.name,BUILTIN_FRAME.brief,'included-v1',now());
      store.run("INSERT OR IGNORE INTO frame_versions(id,set_id,status,directory,proof_path,progress,created_at,finished_at) VALUES(?,?,'ready',?,?,?,?,?)",'included-v1',BUILTIN_FRAME.id,builtinDirectory,path.join(builtinDirectory,'previews','contact-sheet.jpg'),'Included validated template family',now(),now());
      store.run("INSERT OR IGNORE INTO settings(key,value) VALUES('default_frame_set',?)",BUILTIN_FRAME.id);
    });
  }
  recoverRunning(){
    this.store.run("UPDATE frame_versions SET status='failed',error='Studio stopped during template generation. Generate a new revision to retry.' WHERE status='running' AND set_id NOT IN (SELECT id FROM frame_sets WHERE template_source!='')");
    // Magic Set Editor imports are deterministic, so an interrupted one simply runs again.
    for(const v of this.store.all("SELECT v.*,s.template_source FROM frame_versions v JOIN frame_sets s ON s.id=v.set_id WHERE v.status='running' AND s.template_source!=''"))this.runTemplateImport(v.id,v.template_source,v.directory);
  }
  tasks(){return this.store.all("SELECT v.id,v.set_id,v.status,v.error,v.progress,v.created_at,v.finished_at,v.retry_count,v.not_before,s.name AS frame_name FROM frame_versions v JOIN frame_sets s ON s.id=v.set_id WHERE v.id!='included-v1' ORDER BY v.created_at DESC,v.rowid DESC");}
  taskDetail(jobId){const task=this.tasks().find(j=>j.id===jobId);if(!task)throw Error('Frame task not found.');const row=this.store.get('SELECT directory FROM frame_versions WHERE id=?',jobId),logs=[];for(const name of ['events.jsonl','validation.log']){const file=path.join(row.directory,name);if(!fs.existsSync(file))continue;const stat=fs.statSync(file),length=Math.min(stat.size,48000),buffer=Buffer.alloc(length),fd=fs.openSync(file,'r');try{fs.readSync(fd,buffer,0,length,stat.size-length);logs.push(name+'\n'+buffer.toString('utf8'));}finally{fs.closeSync(fd);}}return {...task,log:logs.join('\n\n')};}
  defaultId(){return this.store.get("SELECT value FROM settings WHERE key='default_frame_set'")?.value||BUILTIN_FRAME.id;}
  get active(){return this.running.keys().next().value||null;}
  list(){return this.store.all(`SELECT s.*,v.status,v.error,v.progress,v.not_before,v.retry_count FROM frame_sets s LEFT JOIN frame_versions v ON v.id=(SELECT id FROM frame_versions WHERE set_id=s.id ORDER BY created_at DESC,rowid DESC LIMIT 1) ORDER BY s.created_at DESC`).map(set=>({...set,controls:JSON.parse(set.controls),visual_edits:JSON.parse(set.visual_edits),brief_fields:JSON.parse(set.brief_fields||'{}'),reference:JSON.parse(set.reference||'{}'),is_default:set.id===this.defaultId(),layouts:FRAME_LAYOUTS}));}
  detail(setId){const set=this.store.get('SELECT * FROM frame_sets WHERE id=?',setId);if(!set)throw new Error('Frame set not found.');return {...set,controls:JSON.parse(set.controls),visual_edits:JSON.parse(set.visual_edits),brief_fields:JSON.parse(set.brief_fields||'{}'),reference:JSON.parse(set.reference||'{}'),is_default:set.id===this.defaultId(),layouts:FRAME_LAYOUTS,versions:this.store.all('SELECT * FROM frame_versions WHERE set_id=? ORDER BY created_at DESC,rowid DESC',setId).map(v=>({...v,controls:JSON.parse(v.controls),visual_edits:JSON.parse(v.visual_edits),concept:JSON.parse(v.concept||'{}')}))};}
  snapshot(setId){const set=this.detail(setId||this.defaultId()),version=this.store.get("SELECT * FROM frame_versions WHERE id=? AND status='ready'",set.current_version_id);if(!version)throw new Error('This frame set has no validated version yet.');return {id:set.id,name:set.name,version_id:version.id,config_path:version.config_path,rules_sizing:set.controls.rules_sizing==='full'?'full':'fit'};}
  update(setId,data){
    const set=this.detail(setId),name=cleanText(data.name??set.name,120),brief=cleanText(data.brief??set.brief,20000),controls=frameControls(data.controls??set.controls),visual=visualEdits(data.visual_edits??set.visual_edits);
    if(!name||!brief)throw new Error('Set name and brief cannot be blank.');
    if(visual.source_version_id&&!set.versions.some(v=>v.id===visual.source_version_id&&v.status==='ready'))throw new Error('Visual edits must reference a validated version in this set.');
    const source=frameDeckSource(this.store,data.deck_art_set_id??set.deck_art_set_id),fields=briefFields(data.brief_fields??set.brief_fields);
    this.store.run('UPDATE frame_sets SET name=?,brief=?,controls=?,visual_edits=?,deck_art_set_id=?,brief_fields=? WHERE id=?',name,brief,JSON.stringify(controls),JSON.stringify(visual),source?.set.id||'',JSON.stringify(fields),setId);this.notify();return this.detail(setId);
  }
  // Generated custom illustrations (never official or reconstructed scans) whose card structure suits a preview layout.
  // Custom illustrations suited to a structure, from every deck or only the versions chosen in one deck artwork set.
  artCandidates(layout,artSetId=''){
    if(!FRAME_LAYOUTS.includes(layout))throw new Error('Choose a supported card structure.');
    const source=artSetId?frameDeckSource(this.store,artSetId):null;
    const chosen=source&&new Set((source.active?this.store.all('SELECT active_version_id AS id FROM cards WHERE deck_id=?',source.deck.id):this.store.all('SELECT version_id AS id FROM deck_art_cards WHERE set_id=?',source.set.id)).map(r=>r.id).filter(Boolean));
    const rows=this.store.all(`SELECT v.id,v.summary,v.manifest_path,c.name,c.entry_kind,d.name AS deck_name FROM versions v JOIN cards c ON c.id=v.card_id JOIN decks d ON d.id=c.deck_id WHERE v.source_type='custom' AND v.manifest_path IS NOT NULL`).filter(row=>!chosen||chosen.has(row.id)).map(row=>({...row,summary:JSON.parse(row.summary||'{}'),...(source?{deck_name:`${source.deck.name} · ${source.set.name}`}:{})}));
    const type=row=>(row.summary.faces?.[0]||row.summary).type_line||'',has=(row,word)=>new RegExp('\\b'+word+'\\b').test(type(row).split(' — ')[0]);
    const token=row=>row.entry_kind==='token'||row.summary.layout==='token'||has(row,'Token'),double=row=>row.summary.faces?.length===2,special=row=>token(row)||double(row)||['adventure','prepare','saga'].includes(row.summary.layout)||has(row,'Saga');
    const match={creature:r=>!special(r)&&has(r,'Creature'),artifact:r=>!special(r)&&has(r,'Artifact')&&!has(r,'Creature')&&!has(r,'Land'),enchantment:r=>!special(r)&&has(r,'Enchantment')&&!has(r,'Creature')&&!has(r,'Artifact'),instant:r=>!special(r)&&has(r,'Instant'),sorcery:r=>!special(r)&&has(r,'Sorcery'),land:r=>!special(r)&&has(r,'Land'),planeswalker:r=>!special(r)&&has(r,'Planeswalker'),token,transform_front:double,transform_back:double,adventure:r=>r.summary.layout==='adventure',prepare:r=>r.summary.layout==='prepare',saga:r=>r.summary.layout==='saga'||has(r,'Saga')};
    // Structures nobody has illustrated yet borrow the closest ordinary card art.
    const fallback={planeswalker:'creature',token:'creature',adventure:'creature',prepare:'creature',saga:'enchantment',transform_front:'creature',transform_back:'creature'};
    const face=layout==='transform_back'?1:0,usable=row=>{const art=(row.summary.faces?.[face]||row.summary.faces?.[0]||row.summary).art;if(!art)return null;const filename=path.resolve(path.dirname(row.manifest_path),art);return fs.existsSync(filename)&&(inside(this.root,filename)||inside(this.store.directory,filename))?filename:null;};
    for(const kind of [layout,fallback[layout]].filter(Boolean)){const found=rows.filter(match[kind]).map(row=>({...row,art_path:usable(row)})).filter(row=>row.art_path);if(found.length)return {matched:kind===layout,kind,rows:found};}
    return {matched:false,kind:null,rows:rows.map(row=>({...row,art_path:usable(row)})).filter(row=>row.art_path)};
  }
  sampleArt(layout,exclude='',artSetId=''){
    const {matched,kind,rows}=this.artCandidates(layout,artSetId),pool=rows.length>1?rows.filter(r=>r.id!==exclude):rows;if(!pool.length)throw new Error(artSetId?'This artwork set has no custom illustrations yet. Choose another set.':'Generate some custom card art first; there are no illustrations to preview yet.');
    const row=pool[Math.floor(Math.random()*pool.length)];return {version_id:row.id,layout,art_set_id:artSetId||'',name:row.name,deck_name:row.deck_name,matched,matched_kind:kind,available:rows.length};
  }
  preview(setId,data){
    const set=this.detail(setId),version=set.versions.find(v=>v.id===(data.version_id||set.current_version_id)&&v.status==='ready');if(!version)throw new Error('Choose a validated frame version.');
    if(this.livePreviewChildren.size>=2)throw new Error('A preview is rendering. Try again in a moment.');
    const request={name:set.name,config_path:version.config_path,controls:frameControls(data.controls||{}),context:previewContext(data.context)};
    if(data.art_version_id){const art=this.artCandidates(request.context.layout,data.art_set_id||'').rows.find(r=>r.id===data.art_version_id);if(!art)throw new Error('That artwork is not available for this card structure. Shuffle to choose another.');request.art_path=art.art_path;}
    return new Promise((resolve,reject)=>{const child=execFile(this.options.python||process.env.CARDFORGE_PYTHON||'python3',[path.join(this.root,'studio/preview_frame_edit.py')],{cwd:this.root,timeout:30000,maxBuffer:8000000},(error,stdout,stderr)=>{this.livePreviewChildren.delete(child);if(error){const interrupted=this.closed||error.killed||error.signal;const failure=new Error(interrupted?'The preview renderer was interrupted. Please retry in a moment.':stderr.trim().split('\n').at(-1)||error.message);failure.status=interrupted?503:400;return reject(failure);}try{resolve(JSON.parse(stdout));}catch(e){reject(e);}});this.livePreviewChildren.add(child);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));});
  }
  makeDefault(setId){this.snapshot(setId);this.store.run("INSERT INTO settings(key,value) VALUES('default_frame_set',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",setId);this.notify();return this.detail(setId);}
  ensureIncludedPreviews(){
    const version=this.store.get('SELECT * FROM frame_versions WHERE id=?','included-v1');
    const validation=path.join(version.directory,'previews','validation.json');if(fs.existsSync(validation)&&FRAME_LAYOUTS.every(k=>JSON.parse(fs.readFileSync(validation,'utf8')).layouts.includes(k)))return Promise.resolve();
    if(this.includedPreviewTask)return this.includedPreviewTask;
    this.includedPreviewTask=new Promise((resolve,reject)=>{this.includedPreviewChild=execFile(this.options.python||process.env.CARDFORGE_PYTHON||'python3',[path.join(this.root,'studio/verify_template.py'),'--builtin',version.directory],{cwd:this.root,timeout:120000,maxBuffer:2000000},error=>{this.includedPreviewChild=null;this.includedPreviewTask=null;error?reject(error):resolve();});});return this.includedPreviewTask;
  }
  ensureVariant(version,filename){
    const destination=path.join(version.directory,'previews',filename);if(fs.existsSync(destination))return Promise.resolve();
    const matrix=filename==='colour-matrix.jpg'||filename.startsWith('colour-'),baseline=filename.match(/^(adventure|prepare|saga)(?:\.frame)?\.png$/); if(baseline){const baseKey=version.id+'/'+baseline[1];if(this.previewTasks.has(baseKey))return this.previewTasks.get(baseKey);const args=[path.join(this.root,'studio/render_frame_preview.py'),version.config_path||'--builtin',version.directory,'layout',baseline[1]];const promise=this.previewChain.then(()=>new Promise((resolve,reject)=>{this.cachePreviewChild=execFile(this.options.python||process.env.CARDFORGE_PYTHON||'python3',args,{cwd:this.root,timeout:120000,maxBuffer:1000000},error=>{this.cachePreviewChild=null;error?reject(error):resolve();});}));this.previewChain=promise.catch(()=>{});this.previewTasks.set(baseKey,promise);promise.finally(()=>this.previewTasks.delete(baseKey)).catch(()=>{});return promise;}
    const key=version.id+'/'+(matrix?'matrix':filename);if(this.previewTasks.has(key))return this.previewTasks.get(key);
    const match=filename.match(/^([a-z_]+)\.(W|U|B|R|G|C|M|WU|UB|BR|RG|GW|WB|UR|BG|RW|GU)\.(normal|legendary)\.(plain|alias)\.png$/);
    if(!matrix&&(!match||!FRAME_LAYOUTS.includes(match[1])))throw new Error('Invalid preview variant.');
    const args=[path.join(this.root,'studio/render_frame_preview.py'),version.config_path||'--builtin',version.directory,...(matrix?['matrix']:match.slice(1))];
    const promise=this.previewChain.then(()=>new Promise((resolve,reject)=>{this.cachePreviewChild=execFile(this.options.python||process.env.CARDFORGE_PYTHON||'python3',args,{cwd:this.root,timeout:180000,maxBuffer:1000000},error=>{this.cachePreviewChild=null;error?reject(error):resolve();});}));
    this.previewChain=promise.catch(()=>{});this.previewTasks.set(key,promise);promise.finally(()=>this.previewTasks.delete(key)).catch(()=>{});return promise;
  }
  create(data){const name=cleanText(data.name,120),brief=cleanText(data.brief,20000),controls=frameControls(data.controls||{});if(!name||!brief)throw new Error('Give the frame set a name and describe its design.');const source=frameDeckSource(this.store,data.deck_art_set_id);const setId=id();this.store.run('INSERT INTO frame_sets(id,name,brief,created_at,controls,deck_art_set_id,brief_fields,reference) VALUES(?,?,?,?,?,?,?,?)',setId,name,brief,now(),JSON.stringify(controls),source?.set.id||'',JSON.stringify(briefFields(data.brief_fields||{})),JSON.stringify(frameReference(this,data.reference)));return this.generate(setId,{brief,controls,options:data.options,decoration_inputs:data.decoration_inputs});}
  generate(setId,data={}){
    let set=this.detail(setId);
    if(set.template_source)throw new Error('This frame comes from a Magic Set Editor template. Choose another template from the library instead of regenerating it.');
    if(this.store.get("SELECT id FROM frame_versions WHERE set_id=? AND status IN ('queued','running')",setId))throw new Error('This frame set already has a generation in progress.');
    set=this.update(setId,data);if(set.visual_edits.annotations.some(a=>!a.note.trim()))throw new Error('Add a change note to every highlighted region before generating.');const brief=set.brief;
    const count=data.options===undefined?1:Number(data.options);if(![1,3].includes(count))throw new Error('Generate one option or three options.');
    const plan=candidatePlan(set.controls.flavour_level||'agent',count),group=count>1?id():'';
    const referenceFile=path.join(this.root,'assets/frame-references/index.json');
    const references=fs.existsSync(referenceFile)?JSON.parse(fs.readFileSync(referenceFile,'utf8')).references.filter(r=>['bordered','borderless','legendary-bordered','legendary-borderless','planeswalker','planeswalker-borderless','adventure','prepare','saga'].includes(r.id)).map(r=>({...r,local_image:path.join(this.root,'assets',r.image.replace(/^\//,''))})):[];
    if(data.decoration_inputs!==undefined&&(!Array.isArray(data.decoration_inputs)||data.decoration_inputs.length>8))throw new Error('Use at most eight decoration inputs.');
    const previous=set.visual_edits.source_version_id?{id:set.id,name:set.name,version_id:set.visual_edits.source_version_id,config_path:set.versions.find(v=>v.id===set.visual_edits.source_version_id).config_path}:this.snapshotOrNull(setId);
    let review=null;
    // Options of one group are designed in parallel; each knows where the others work so they stay distinct.
    const slots=plan.map(candidate=>{const versionId=id();return {candidate,versionId,directory:path.join(this.store.directory,'frame-sets',setId,'versions',versionId)};});
    for(const {candidate,versionId,directory} of slots){
      fs.mkdirSync(directory,{recursive:true});
      const siblings=slots.filter(s=>s.versionId!==versionId).map(s=>({direction:s.candidate.direction,label:s.candidate.label,directory:s.directory}));
      const deckContext=frameDeckContext(this.store,this.root,this.queue,frameDeckSource(this.store,set.deck_art_set_id),directory);
      // Every option is reviewed on the same real illustrations, so they compare fairly.
      review??=reviewArt(this,deckContext);
      const decorationInputs=[];
      for(const [i,input]of (data.decoration_inputs||[]).entries()){
        if(!input||typeof input.path!=='string')throw new Error('Decoration inputs need local PNG paths.');const source=fs.realpathSync(path.resolve(this.root,input.path));if(!inside(this.root,source)||path.extname(source).toLowerCase()!=='.png'||fs.statSync(source).size>16000000)throw new Error('Use a local PNG decoration inside the project (up to 16 MB).');const target=path.join(directory,'inputs','ornament-'+i+'.png');fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);decorationInputs.push({path:target,role:cleanText(input.role||'ornament',120),prompt:cleanText(input.prompt||'',8000),sha256:createHash('sha256').update(fs.readFileSync(target)).digest('hex')});
      }
      const reference=snapshotReference(set.reference,directory);
      fs.writeFileSync(path.join(directory,'request.json'),JSON.stringify({name:set.name,brief,brief_fields:set.brief_fields,...(reference?{reference}:{}),design_process:2,candidate:{...candidateRequest(candidate),group,count},siblings,review_art:review,deck_context:deckContext,decoration_inputs:decorationInputs,controls:set.controls,visual_edits:set.visual_edits,references,previous,output_directory:directory},null,2));
      this.store.run('INSERT INTO frame_versions(id,set_id,status,directory,created_at,controls,visual_edits,candidate_group,candidate_direction) VALUES(?,?,?,?,?,?,?,?,?)',versionId,setId,'queued',directory,now(),JSON.stringify(set.controls),JSON.stringify(set.visual_edits),group,count>1?candidate.direction:'');
    }
    this.notify();this.schedule();return this.detail(setId);
  }
  // Deleting removes the set from Frame Studio. Decks and artwork sets using it switch to the default frame (the included
  // one when the default itself is deleted). Version folders stay on disk for card versions and queued jobs that copied them.
  remove(setId){
    const set=this.detail(setId);
    if(setId===BUILTIN_FRAME.id)throw new Error('The included frame set cannot be deleted.');
    if(this.store.get("SELECT 1 FROM frame_versions WHERE set_id=? AND status IN ('queued','running')",setId))throw new Error('This frame set is still being designed. Wait for it to finish before deleting it.');
    const result=this.store.transaction(()=>{
      if(this.defaultId()===setId)this.store.run("UPDATE settings SET value=? WHERE key='default_frame_set'",BUILTIN_FRAME.id);
      const fallback=this.defaultId(),decks=this.store.run('UPDATE decks SET frame_set_id=? WHERE frame_set_id=?',fallback,setId).changes;let artSets=0;
      for(const row of this.store.all('SELECT id,config_json FROM deck_art_sets')){let config;try{config=JSON.parse(row.config_json||'{}');}catch{continue;}if(config?.frame_set_id!==setId)continue;config.frame_set_id=fallback;this.store.run('UPDATE deck_art_sets SET config_json=? WHERE id=?',JSON.stringify(config),row.id);artSets++;}
      this.store.run('DELETE FROM frame_versions WHERE set_id=?',setId);this.store.run('DELETE FROM frame_sets WHERE id=?',setId);
      return {deleted:set.id,name:set.name,decks,art_sets:artSets,fallback};
    });
    this.notify();return result;
  }
  snapshotOrNull(setId){try{return this.snapshot(setId);}catch{return null;}}
  // Magic Set Editor templates (Full Magic Pack): a browsable catalogue, rendered gallery previews and one-click import.
  get python(){return this.options.python||process.env.CARDFORGE_PYTHON||'python3';}
  get msePreviews(){return path.join(this.store.directory,'mse','previews');}
  async templateCatalog(){
    if(!this.catalogTask)this.catalogTask=new Promise((resolve,reject)=>execFile(this.python,[path.join(this.root,'studio/mse_frames.py'),'catalog'],{cwd:this.root,timeout:300000,maxBuffer:20000000},(error,stdout,stderr)=>{if(error){this.catalogTask=null;return reject(new Error(stderr.trim().split('\n').at(-1)||error.message));}resolve(JSON.parse(stdout));}));
    const catalog=await this.catalogTask,imported=new Map(this.store.all("SELECT id,template_source FROM frame_sets WHERE template_source!=''").map(r=>[r.template_source,r.id]));
    return {pack_revision:catalog.pack_revision,templates:catalog.templates.map(t=>({...t,preview:fs.existsSync(path.join(this.msePreviews,t.id+'.jpg')),preview_failed:fs.existsSync(path.join(this.msePreviews,t.id+'.failed')),frame_set_id:imported.get(t.id)||null}))};
  }
  async templatePreview(styleId){
    const catalog=await this.templateCatalog(),entry=catalog.templates.find(t=>t.id===styleId);if(!entry)throw new Error('Unknown Magic Set Editor template.');
    const rendered=path.join(this.msePreviews,styleId+'.jpg');if(fs.existsSync(rendered))return rendered;
    if(!entry.sample)throw new Error('This template has no preview yet.');return path.join(this.root,'vendor/Full-Magic-Pack',entry.sample);
  }
  async importTemplate(data){
    const styleId=String(data.stylesheet||''),catalog=await this.templateCatalog(),entry=catalog.templates.find(t=>t.id===styleId);
    if(!entry)throw new Error('Unknown Magic Set Editor template.');if(!entry.usable)throw new Error('Only normal-card templates can be used as a frame set.');
    if(entry.frame_set_id)return this.detail(entry.frame_set_id);
    const setId=id(),versionId=id(),directory=path.join(this.store.directory,'frame-sets',setId,'versions',versionId);fs.mkdirSync(directory,{recursive:true});
    const name=cleanText(data.name||(entry.full_name&&!/^(by |after |before )/i.test(entry.full_name)&&entry.full_name!==entry.name?`${entry.full_name} — ${entry.name}`:entry.name),120),brief=`Magic Set Editor template “${entry.name}” (${entry.group.replace(/^magic\//,'')}) from the Full Magic Pack, drawn by Magic Set Editor with the pack's official fonts.`;
    this.store.transaction(()=>{
      this.store.run('INSERT INTO frame_sets(id,name,brief,created_at,template_source) VALUES(?,?,?,?,?)',setId,name,brief,now(),styleId);
      this.store.run("INSERT INTO frame_versions(id,set_id,status,directory,created_at,progress) VALUES(?,?,'running',?,?,?)",versionId,setId,directory,now(),'Rendering every card type with Magic Set Editor');
    });
    this.notify();this.runTemplateImport(versionId,styleId,directory);return this.detail(setId);
  }
  runTemplateImport(versionId,styleId,directory){
    this.templateImports??=new Set();
    const child=execFile(this.python,[path.join(this.root,'studio/mse_frames.py'),'import',styleId,directory],{cwd:this.root,timeout:30*60*1000,maxBuffer:4000000},(error,stdout,stderr)=>{
      this.templateImports.delete(child);if(this.closed)return;
      fs.writeFileSync(path.join(directory,'validation.log'),stdout+'\n'+stderr);
      try{
        if(error)throw new Error(stderr.trim().split('\n').at(-1)||error.message);
        const checked=JSON.parse(stdout.trim().split('\n').at(-1));if(!checked.valid||FRAME_LAYOUTS.some(kind=>!checked.layouts.includes(kind)))throw new Error('The template did not cover all required card types.');
        this.store.transaction(()=>{
          this.store.run("UPDATE frame_versions SET status='ready',config_path=?,proof_path=?,finished_at=?,error=NULL,progress=? WHERE id=?",checked.config_path,checked.proof_path,now(),'Rendered by Magic Set Editor. Planeswalkers, sagas and adventures use the included frame.',versionId);
          this.store.run('UPDATE frame_sets SET current_version_id=? WHERE id=(SELECT set_id FROM frame_versions WHERE id=?)',versionId,versionId);
        });
      }catch(e){this.store.run("UPDATE frame_versions SET status='failed',error=?,finished_at=? WHERE id=?",String(e.message||e).slice(-6000),now(),versionId);}
      this.notify();
    });
    this.templateImports.add(child);
  }
  activate(versionId){const v=this.store.get("SELECT * FROM frame_versions WHERE id=? AND status='ready'",versionId);if(!v)throw new Error('Choose a validated frame version.');this.store.run('UPDATE frame_sets SET current_version_id=?,picked_group=? WHERE id=?',v.id,v.candidate_group||'',v.set_id);this.notify();}
  // Up to three designers run at once, so the three options of a group finish together.
  get concurrency(){return Number(this.options.frameConcurrency||3);}
  schedule(){if(this.closed||this.running.size>=this.concurrency)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.next(),250);this.timer.unref();}
  async next(){
    if(this.closed||this.running.size>=this.concurrency)return;
    const v=this.store.get("SELECT * FROM frame_versions WHERE status='queued' ORDER BY created_at,rowid LIMIT 1");if(!v)return;
    const wait=Math.max(this.queue.cooldownFor('codex'),v.not_before?Date.parse(v.not_before):0)-Date.now();
    if(wait>0){this.timer=setTimeout(()=>this.next(),Math.min(wait,60000));this.timer.unref();return;}
    this.running.set(v.id,null);this.store.run("UPDATE frame_versions SET status='running',progress='Starting Codex frame designer' WHERE id=?",v.id);this.notify();this.schedule();
    try{
      const req=JSON.parse(fs.readFileSync(path.join(v.directory,'request.json'),'utf8'));
      if(req.visual_edits?.source_version_id){
        fs.writeFileSync(path.join(v.directory,'visual-edits.json'),JSON.stringify({controls:req.controls,...req.visual_edits},null,2));
        const contexts=[req.visual_edits.context,...req.visual_edits.annotations.map(a=>previewContext(a))],unique=[...new Map(contexts.map(c=>[JSON.stringify(c),c])).values()];req.review_images=[];
        for(const [i,context]of unique.entries()){
          const input=path.join(v.directory,'review-request-'+i+'.json'),output=path.join(v.directory,'visual-review-'+i+'.png');fs.writeFileSync(input,JSON.stringify({...req,context}));
          await this.process(this.options.python||process.env.CARDFORGE_PYTHON||'python3',[path.join(this.root,'studio/preview_frame_edit.py'),input,output],v,false);req.review_images.push({context,path:output});
        }
        fs.writeFileSync(path.join(v.directory,'request.json'),JSON.stringify(req,null,2));
      }
      const prompt=designerPrompt(v.directory,FRAME_LAYOUTS);
      fs.writeFileSync(path.join(v.directory,'prompt.txt'),prompt);
      await this.process(this.options.binary||process.env.CODEX_BIN||'codex',['exec','--json','--skip-git-repo-check','--sandbox','workspace-write','-c','approval_policy="never"','-c','web_search="live"','-c',`model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,'-c','sandbox_workspace_write.network_access=true','-C',this.root,'--output-schema',path.join(this.root,'studio/frame-result.schema.json'),'-o',path.join(v.directory,'result.json'),prompt],v,true);
      const result=JSON.parse(fs.readFileSync(path.join(v.directory,'result.json'),'utf8'));if(result.status!=='completed')throw new Error(result.message||'Frame designer could not finish.');
      fs.writeFileSync(path.join(v.directory,'request.json'),JSON.stringify(req,null,2));
      const config=path.resolve(this.root,result.config_path);if(!inside(v.directory,config))throw new Error('Frame configuration escaped its version directory.');
      const concept=req.design_process?frameConcept(v.directory,req.candidate?.target):{};
      this.store.run('UPDATE frame_versions SET progress=? WHERE id=?','Validating every required frame template',v.id);this.notify();
      const output=await this.process(this.options.python||process.env.CARDFORGE_PYTHON||'python3',[path.join(this.root,'studio/verify_template.py'),config,v.directory,path.join(v.directory,'request.json'),'--final'],v,false);
      const checked=JSON.parse(output.trim().split('\n').at(-1));if(!checked.valid||FRAME_LAYOUTS.some(kind=>!checked.layouts.includes(kind)))throw new Error('The set does not cover all required templates.');
      this.store.transaction(()=>{
        this.store.run("UPDATE frame_versions SET status='ready',config_path=?,proof_path=?,finished_at=?,error=NULL,progress=?,concept=? WHERE id=?",config,checked.proof_path,now(),checked.design_review?.warnings?.length?'Passed with notes: '+checked.design_review.warnings.join(' '):'All required templates passed',JSON.stringify({...concept,review:checked.design_review||null}),v.id);
        // A single option, or the middle option of three, becomes current unless the user already picked from this group.
        const set=this.store.get('SELECT * FROM frame_sets WHERE id=?',v.set_id),current=this.store.get("SELECT id FROM frame_versions WHERE id=? AND status='ready'",set.current_version_id);
        if(!v.candidate_group||!current||(v.candidate_direction==='prompt'&&set.picked_group!==v.candidate_group))this.store.run('UPDATE frame_sets SET current_version_id=? WHERE id=?',v.id,v.set_id);
      });
    }catch(e){
      const message=String(e.message||e).slice(-6000),retry=rateLimitWait(message,v.retry_count+1);
      if(!this.closed&&retry&&v.retry_count<8){const until=Date.now()+retry.delay;this.store.run("UPDATE frame_versions SET status='queued',error=?,not_before=?,retry_count=retry_count+1 WHERE id=?",message,new Date(until).toISOString(),v.id);this.queue.setProviderCooldown('codex',until);}
      else this.store.run("UPDATE frame_versions SET status='failed',error=?,finished_at=? WHERE id=?",message,now(),v.id);
    }finally{this.running.delete(v.id);this.notify();this.schedule();}
  }
  process(binary,args,version,jsonEvents){return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{cwd:this.root,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',env:process.env});if(this.running.has(version.id))this.running.set(version.id,child);let stdout='',stderr='',pending='';
    const log=fs.createWriteStream(path.join(version.directory,jsonEvents?'events.jsonl':'validation.log'),{flags:'a'});
    const timer=setTimeout(()=>this.queue.kill(child),60*60*1000);timer.unref();
    child.stdout.on('data',chunk=>{const text=chunk.toString();stdout=(stdout+text).slice(-2000000);log.write(text);if(jsonEvents){pending+=text;let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);try{const event=JSON.parse(line),message=event.item?.text||event.message;if(message){this.store.run('UPDATE frame_versions SET progress=? WHERE id=?',String(message).slice(0,1000),version.id);this.notify();}}catch{}}}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-20000);log.write(chunk);});
    child.on('error',e=>{clearTimeout(timer);log.end();reject(e);});child.on('close',code=>{clearTimeout(timer);log.end();code===0?resolve(stdout):reject(new Error(stderr||stdout||'Frame designer exited with code '+code));});
  });}
  close(){this.closed=true;clearTimeout(this.timer);for(const child of this.running.values())if(child)this.queue.kill(child);if(this.includedPreviewChild)this.includedPreviewChild.kill('SIGTERM');if(this.cachePreviewChild)this.cachePreviewChild.kill('SIGTERM');for(const child of this.templateImports||[])child.kill('SIGTERM');for(const child of this.livePreviewChildren)child.kill('SIGTERM');}
}
