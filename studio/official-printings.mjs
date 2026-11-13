import {tokenSpec} from './variants.mjs';
import {printingSpec} from './decklist.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {id,now} from './store.mjs';
const run=promisify(execFile),UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const key=s=>String(s||'').normalize('NFKC').replace(/[’‘]/g,"'").replace(/\s*\/\/\s*/g,' // ').toLowerCase().replace(/\s+/g,' ').trim();
const names=card=>[card.name,...(card.card_faces||[]).map(f=>f.name)].map(key);
export const printingFaces=card=>card.image_uris?[{...card,name:card.name,image_uris:card.image_uris}]:(card.card_faces||[]).filter(f=>f.image_uris);
// Scryfall `prefer:` modes (valid with unique=cards) and art-treatment search filters for automatic official art.
export const OFFICIAL_PREFERENCES=['newest','oldest','default','atypical','promo','usd-low','usd-high','notub'];
export const OFFICIAL_TREATMENTS={any:'',borderless:'is:borderless',fullart:'is:fullart',extendedart:'is:extendedart',showcase:'is:showcase',retro:'frame:old',textless:'is:textless'};
export const artChoice=({prefer='newest',treatment='any'}={})=>{prefer=prefer||'newest';treatment=treatment||'any';if(!OFFICIAL_PREFERENCES.includes(prefer))throw Error('Invalid art preference.');if(!Object.hasOwn(OFFICIAL_TREATMENTS,treatment))throw Error('Invalid art treatment.');return {prefer,treatment};};
const write=(filename,data)=>{const temp=filename+'.'+id()+'.tmp';fs.writeFileSync(temp,data);fs.renameSync(temp,filename);};
export class OfficialPrintings{
 constructor(store,{fetcher=fetch,notify=()=>{},python='python3',gap=550}={}){
  Object.assign(this,{store,fetcher,notify,python,gap});this.chain=Promise.resolve();this.last=0;this.cooldown=0;this.inflight=new Map();this.locks=new Set();
  store.db.exec('CREATE TABLE IF NOT EXISTS official_printings(id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS official_catalog_pages(cache_key TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL)');
 }
 populate(deckId,{art_set_id,prefer,treatment}={}){
  const choice=artChoice({prefer,treatment}),request={first_available:true,...(choice.prefer!=='newest'&&{prefer:choice.prefer}),...(choice.treatment!=='any'&&{treatment:choice.treatment})};
  const deck=this.store.deck(deckId);if(!deck)throw Error('Deck not found.');if(deck.archived)throw Error('Restore this deck before populating artwork.');if(art_set_id&&art_set_id!==deck.active_art_set_id)throw Error('The artwork set changed. Reopen the deck before populating artwork.');
  const candidates=deck.cards.filter(card=>!card.active_version_id&&!this.locks.has(card.id)&&!this.store.get("SELECT id FROM jobs WHERE card_id=? AND status IN ('queued','running')",card.id)&&!(card.art_mode==='official'&&card.printing_json!=='{}'&&!card.printing_error));
  this.store.transaction(()=>{for(const card of candidates)this.store.run("UPDATE cards SET art_mode='official',printing_json=?,printing_error='',approval='unreviewed' WHERE id=?",JSON.stringify(request),card.id);if(candidates.length)this.store.touch(deckId);});this.notify();this.schedule();return {queued:candidates.length,art_set_id:deck.active_art_set_id};
 }
 async firstAvailable(cardId,choice={}){
  const {prefer,treatment}=artChoice(choice),preferred=prefer!=='newest',filtered=treatment!=='any';
  // Most specific first: preferred printing with the treatment, any printing with the treatment (newest first),
  // then the preferred printing without it, and finally the newest available printing. English before other languages.
  const attempts=[preferred&&filtered&&{unique:'cards',prefer,treatment},filtered&&{unique:'prints',treatment},preferred&&{unique:'cards',prefer},{unique:'prints'}].filter(Boolean);
  for(const language of ['en','all'])for(const attempt of attempts){
   let page=1;
   do{
    let result;try{result=await this.catalog(cardId,{...attempt,page,language});}catch(e){if(e.scryfall_status===404)break;throw e;}
    for(const item of result.cards){const printing=await this.printing(item.id);if(!['missing','placeholder'].includes(printing.image_status)&&printingFaces(printing).every(face=>face.image_uris.png||face.image_uris.large))return printing;}
    if(!result.has_more)break;page++;
   }while(page<=100);
  }throw Error('No matching official card image is available from Scryfall. You can choose a printing manually or switch to custom artwork.');
 }
 pending(){return this.store.get("SELECT c.* FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.art_mode='official' AND c.active_version_id IS NULL AND c.printing_json!='{}' AND c.printing_error='' AND d.archived=0 ORDER BY c.created_at,c.rowid LIMIT 1");}
 schedule(){
  if(this.closed||this.timer||this.active||!this.pending())return;
  this.timer=setTimeout(()=>{this.timer=null;if(this.closed)return;this.active=this.importNext().catch(()=>{}).finally(()=>{this.active=null;this.schedule();});},Math.max(25,this.cooldown-Date.now()));this.timer.unref?.();
 }
 async importNext(){
  const card=this.pending();if(!card)return;
  try{
   const requested=JSON.parse(card.printing_json);let printing;
   if(requested.first_available===true)printing=await this.firstAvailable(card.id,requested);
   else{
    const spec=printingSpec(requested);if(!spec)throw Error('The requested printing is missing its set or collector number.');
    const cached=this.store.all('SELECT data FROM official_printings').map(r=>JSON.parse(r.data)).find(c=>c.set?.toLowerCase()===spec.set&&String(c.collector_number).toLowerCase()===spec.collector_number.toLowerCase()&&c.lang==='en');
    printing=cached||await this.api('/cards/'+encodeURIComponent(spec.set)+'/'+encodeURIComponent(spec.collector_number));
    if(String(printing.set).toLowerCase()!==spec.set||String(printing.collector_number).toLowerCase()!==spec.collector_number.toLowerCase())throw Error('Scryfall returned a different set or collector number.');
   }
   if(!this.matches({...card,metadata:JSON.parse(card.metadata||'{}'),token_spec:JSON.parse(card.token_spec||'{}')},printing))throw Error(`That printing is ${printing.name}, not ${card.name}. Check the card name, set and collector number.`);
   const current=this.store.get('SELECT * FROM cards WHERE id=?',card.id);if(!current||current.art_mode!=='official'||current.active_version_id||current.printing_json!==card.printing_json)return;
   this.save(printing);await this.select(card.id,printing.id);
  }catch(e){if(Date.now()<this.cooldown)return;this.store.run('UPDATE cards SET printing_error=? WHERE id=? AND art_mode=\'official\' AND active_version_id IS NULL AND printing_json=?',String(e.message).slice(0,2000),card.id,card.printing_json);this.notify();}
 }
 retryImport(cardId){const card=this.writable(cardId);if(card.art_mode!=='official'||card.active_version_id||!(JSON.parse(card.printing_json).first_available===true||printingSpec(JSON.parse(card.printing_json))))throw Error('There is no pending official printing to retry.');this.store.run("UPDATE cards SET printing_error='' WHERE id=?",cardId);this.notify();this.schedule();return {ok:true};}
 async close(){this.closed=true;clearTimeout(this.timer);await this.active;}
 target(cardId){const card=this.store.get('SELECT * FROM cards WHERE id=?',cardId);if(!card)throw Error('Card not found.');return {...card,metadata:JSON.parse(card.metadata||'{}'),token_spec:JSON.parse(card.token_spec||'{}')};}
 writable(cardId){const card=this.target(cardId);if(this.store.deck(card.deck_id).archived)throw Error('Restore this deck before changing its artwork.');if(this.store.get("SELECT id FROM jobs WHERE card_id=? AND status IN ('queued','running')",cardId))throw Error('Wait for or cancel this card’s generation before choosing artwork.');return card;}
 async api(endpoint){
  const task=this.chain.catch(()=>{}).then(async()=>{
   if(Date.now()<this.cooldown)throw Error('Scryfall is rate limiting requests. Please try again in a minute.');
   const delay=this.last+this.gap-Date.now();if(delay>0)await new Promise(r=>setTimeout(r,delay));this.last=Date.now();
   let response;try{response=await this.fetcher('https://api.scryfall.com'+endpoint,{headers:{Accept:'application/json','User-Agent':'CardStudio/1.0 (local personal deck builder)'},signal:AbortSignal.timeout(20000)});}catch{throw Error('Could not reach Scryfall. Check your connection and try again.');}
   if(response.status===429){this.cooldown=Date.now()+Math.max(60000,(Number(response.headers.get('retry-after'))||0)*1000);throw Error('Scryfall is rate limiting requests. Please try again in a minute.');}
   const data=await response.json();if(!response.ok){const error=Error(data.details||'Scryfall could not find this card.');error.scryfall_status=response.status;throw error;}return data;
  });this.chain=task;return task;
 }
 save(card){if(!UUID.test(card.id))throw Error('Invalid Scryfall card identifier.');this.store.run('INSERT OR REPLACE INTO official_printings VALUES(?,?,?)',card.id,JSON.stringify(card),now());}
 async printing(printingId){if(!UUID.test(printingId||''))throw Error('Choose a valid Scryfall printing.');const cached=this.store.get('SELECT data FROM official_printings WHERE id=?',printingId);if(cached)return JSON.parse(cached.data);const card=await this.api('/cards/'+printingId);this.save(card);return card;}
 matches(target,card){
  const oracle=target.metadata.oracle_id;if(oracle)return oracle===card.oracle_id||(card.card_faces||[]).some(f=>f.oracle_id===oracle);
  const wanted=key(target.metadata.name||target.name);if(!names(card).some(n=>n===wanted||n.split(' // ')[0]===wanted.split(' // ')[0]))return false;
  if(target.entry_kind==='token'){
   const spec=target.token_spec;if(!/token/i.test(card.type_line||''))return false;
   for(const field of ['power','toughness','oracle_text'])if(spec[field]!=null&&key(spec[field])!==key(card[field]))return false;
   if(spec.colors&&[...spec.colors].sort().join()!==[...(card.colors||[])].sort().join())return false;
   if(spec.type_line&&key(spec.type_line)!==key(card.type_line))return false;
  }return true;
 }
 describe(card){const faces=printingFaces(card);return {id:card.id,name:card.name,set:card.set,set_name:card.set_name,collector_number:card.collector_number,released_at:card.released_at,lang:card.lang,rarity:card.rarity,artist:card.artist||[...new Set(faces.map(f=>f.artist).filter(Boolean))].join(', '),border_color:card.border_color,full_art:card.full_art,frame:card.frame,frame_effects:card.frame_effects||[],highres_image:card.highres_image,image_status:card.image_status,scryfall_uri:card.scryfall_uri,faces:faces.map((f,i)=>({name:f.name,preview:`/official-printing-images/${card.id}/${i}/normal`,image:`/official-printing-images/${card.id}/${i}/${f.image_uris.png?'png':'large'}`,format:f.image_uris.png?'png':'large'}))};}
 async catalog(cardId,{page=1,unique='prints',language='en',prefer='',treatment='any'}={}){
  const target=this.target(cardId);page=Number(page);if(!Number.isInteger(page)||page<1||page>100)throw Error('Invalid page.');if(!['art','prints','cards'].includes(unique))throw Error('Invalid printing filter.');
  if(prefer)artChoice({prefer});const filter=OFFICIAL_TREATMENTS[artChoice({treatment}).treatment];
  if(!['en','all'].includes(language))throw Error('Invalid language filter.');
  let oracle=target.metadata.oracle_id;
  if(!oracle&&target.entry_kind!=='token'){
   const named=await this.api('/cards/named?'+new URLSearchParams({exact:(target.metadata.name||target.name).split(' // ')[0]}));if(!this.matches(target,named))throw Error('Scryfall returned a different card.');oracle=named.oracle_id;this.save(named);
   if(oracle){target.metadata={...target.metadata,...named};this.store.run('UPDATE cards SET metadata=? WHERE id=?',JSON.stringify(target.metadata),cardId);}
  }
  const query=(oracle?`oracleid:${oracle} game:paper`:`!"${target.name.replaceAll('"','')}" t:token game:paper`)+(language==='en'?' lang:en':'')+(filter?' '+filter:'')+(prefer?' prefer:'+prefer:'');
  const cacheKey=JSON.stringify({query,page,unique,language}),cached=this.store.get('SELECT * FROM official_catalog_pages WHERE cache_key=?',cacheKey);
  let data,stale=false;
  if(cached&&Date.now()-Date.parse(cached.updated_at)<86400000)data=JSON.parse(cached.data);
  else try{
   data=await this.api('/cards/search?'+new URLSearchParams({q:query,unique,include_multilingual:String(language==='all'),order:'released',dir:'desc',page:String(page)}));
   for(const card of data.data||[])this.save(card);this.store.run('INSERT OR REPLACE INTO official_catalog_pages VALUES(?,?,?)',cacheKey,JSON.stringify(data),now());
  }catch(e){if(!cached)throw e;data=JSON.parse(cached.data);stale=true;}
  const cards=(data.data||[]).filter(c=>this.matches(target,c)&&printingFaces(c).length);
  return {card_id:cardId,cards:cards.map(c=>this.describe(c)),page,has_more:!!data.has_more,total:data.total_cards,stale};
 }
 async image(printingId,face=0,kind='normal'){
  face=Number(face);if(!Number.isInteger(face)||face<0||face>1||!['small','normal','large','png','art_crop'].includes(kind))throw Error('Invalid printing image.');
  const requestKey=[printingId,face,kind].join('/');if(this.inflight.has(requestKey))return this.inflight.get(requestKey);
  const task=(async()=>{
   const card=await this.printing(printingId),url=printingFaces(card)[face]?.image_uris[kind];if(!url)throw Error('This printing has no image for that face or size.');
   const address=new URL(url);if(address.protocol!=='https:'||!/(^|\.)scryfall\.io$/.test(address.hostname))throw Error('Untrusted image host.');
   const directory=path.join(this.store.directory,'official-images',printingId);fs.mkdirSync(directory,{recursive:true});const filename=path.join(directory,`${face}-${kind}${kind==='png'?'.png':'.jpg'}`);if(fs.existsSync(filename))return filename;
   const response=await this.fetcher(address.href,{headers:{Accept:'image/png,image/jpeg','User-Agent':'CardStudio/1.0 (local personal deck builder)'},signal:AbortSignal.timeout(30000),redirect:'error'});
   if(!response.ok)throw Error('Could not download the official image. Please try again.');
   if(!/^image\/(png|jpeg)(;|$)/i.test(response.headers.get('content-type')||''))throw Error('Scryfall did not return an image.');
   const limit=16*1024*1024;if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('Image exceeds the download limit.');}
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('Image exceeds the download limit.');chunks.push(chunk);}write(filename,Buffer.concat(chunks));return filename;
  })();this.inflight.set(requestKey,task);try{return await task;}finally{this.inflight.delete(requestKey);}
 }
 async select(cardId,printingId){
  if(this.locks.has(cardId))throw Error('An official printing is already being saved for this card.');this.locks.add(cardId);let directory;
  try{
   const target=this.writable(cardId),artSetId=this.store.artSets.ensure(target.deck_id),printing=await this.printing(printingId);if(!this.matches(target,printing))throw Error('Choose a printing of this same Magic card.');
   const faces=printingFaces(printing);if(!faces.length||faces.length>2)throw Error('No supported card images are available for this printing.');
   const versionId=id();directory=path.join(this.store.directory,'decks',target.deck_id,'cards',cardId,'versions',versionId);fs.mkdirSync(directory,{recursive:true});
   const saved=[];
   for(let i=0;i<faces.length;i++){
    const source=await this.image(printingId,i,faces[i].image_uris.png?'png':'large'),destination=path.join(directory,i?'official-back.png':'official-front.png');
    const {stdout}=await run(this.python,['-c',`from PIL import Image\nimport json,sys\nim=Image.open(sys.argv[1]); im.load()\nif im.width>6000 or im.height>6000: raise ValueError('Unexpected image dimensions')\nim.save(sys.argv[2], format='PNG')\nprint(json.dumps({'width':im.width,'height':im.height,'dpi':round(min(im.width/63*25.4,im.height/88*25.4))}))`,source,destination],{timeout:20000});
    saved.push({label:i?'back':'front',name:faces[i].name,image_path:destination,...JSON.parse(stdout)});
   }
   const provenance={source:'scryfall',printing_id:printing.id,oracle_id:printing.oracle_id,scryfall_uri:printing.scryfall_uri,set:printing.set,set_name:printing.set_name,collector_number:printing.collector_number,downloaded_at:now(),faces:saved,notes:'Original full-card scans at native resolution; no AI generation or custom frame composition.'};
   const report=path.join(directory,'report.json'),manifest=path.join(directory,'manifest.json');write(path.join(directory,'scryfall.json'),JSON.stringify(printing,null,2));write(report,JSON.stringify(provenance,null,2));write(manifest,JSON.stringify({kind:'official-printing',...provenance},null,2));
   this.writable(cardId);if(this.store.artSets.ensure(target.deck_id)!==artSetId)throw Error('The artwork set changed during this download. Choose this printing again in the intended set.');
   this.store.transaction(()=>{if(target.entry_kind==='token'){const spec=tokenSpec({...printing,name:target.name});this.store.run('UPDATE cards SET token_spec=? WHERE id=?',JSON.stringify(spec),cardId);}this.store.run('UPDATE cards SET metadata=? WHERE id=?',JSON.stringify(printing),cardId);this.store.addVersion(cardId,{id:versionId,source_type:'official',art_provider:'official',image_path:saved[0].image_path,manifest_path:manifest,report_path:report,faces:saved,summary:{...printing,official_printing:provenance},note:`Official · ${printing.set_name} · #${printing.collector_number}`});});
   this.notify();return {version_id:versionId,printing:this.describe(printing),faces:saved};
  }catch(e){if(directory)fs.rmSync(directory,{recursive:true,force:true});throw e;}finally{this.locks.delete(cardId);}
 }
 useCustom(cardId){
  if(this.locks.has(cardId))throw Error('Wait for the printing download to finish.');const card=this.writable(cardId),version=this.store.get("SELECT v.id FROM versions v JOIN deck_art_versions a ON a.version_id=v.id WHERE v.card_id=? AND a.set_id=? AND v.source_type='custom' ORDER BY v.number DESC LIMIT 1",cardId,this.store.artSets.ensure(card.deck_id));
  if(version)this.store.activate(cardId,version.id);else{this.store.run("UPDATE cards SET art_mode='custom',active_version_id=NULL,printing_json='{}',printing_error='',approval='unreviewed' WHERE id=?",cardId);this.store.touch(card.deck_id);}this.notify();return {ok:true,version_id:version?.id||null};
 }
}
