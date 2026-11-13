import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const run=promisify(execFile);
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {id,now} from './store.mjs';
import {borderSettings} from './borders.mjs';
import {printingFaces} from './official-printings.mjs';

// A tray item owns a frozen image, so switching or deleting its source deck
// cannot silently change a pending print selection.
export class PrintStudio {
 constructor(store,official,borders){
  Object.assign(this,{store,official,borders});
  store.db.exec('CREATE TABLE IF NOT EXISTS print_imports(id TEXT PRIMARY KEY,name TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL)');
  store.db.exec('CREATE TABLE IF NOT EXISTS print_tray_items(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,quantity INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL)');
 }
 list(){const items=this.store.all('SELECT * FROM print_tray_items ORDER BY created_at,rowid').map(row=>({...JSON.parse(row.data),id:row.id,quantity:row.quantity,preview:'/print-tray-assets/'+row.id+'/front',back_preview:JSON.parse(row.data).back_path?'/print-tray-assets/'+row.id+'/back':null}));return {items,count:items.reduce((n,i)=>n+i.quantity,0)};}
 quantity(value){const n=Number(value??1);if(!Number.isInteger(n)||n<1||n>999)throw Error('Choose 1–999 copies per image.');return n;}
 library({query='',deck_id='',art_set_id='',history='false',source='all',page=1}={}){
  page=Number(page);if(!Number.isInteger(page)||page<1||page>10000)throw Error('Invalid library page.');if(!['all','custom','official','uploaded','reconstructed'].includes(source))throw Error('Invalid artwork source.');
  if(source==='uploaded'){const rows=this.store.all('SELECT * FROM print_imports WHERE name LIKE ? ORDER BY created_at DESC,rowid DESC LIMIT 49 OFFSET ?', '%'+String(query).slice(0,200)+'%',(page-1)*48);return {page,has_more:rows.length>48,cards:rows.slice(0,48).map(row=>({...JSON.parse(row.data),name:row.name,display_name:row.name,import_id:row.id,preview:'/print-import-assets/'+row.id+'/front',has_back:!!JSON.parse(row.data).back_path,source_type:'imported',deck_name:'Uploaded images',art_set_name:'Print library',number:1}))};}
  const where=['(c.name LIKE ? OR v.summary LIKE ?)'],args=['%'+String(query).slice(0,200)+'%','%'+String(query).slice(0,200)+'%'];
  if(deck_id){where.push('d.id=?');args.push(deck_id);}if(art_set_id){where.push('s.id=?');args.push(art_set_id);}if(source!=='all'){where.push('v.source_type=?');args.push(source);}
  if(history!=='true')where.push('v.id=CASE WHEN s.id=d.active_art_set_id THEN c.active_version_id ELSE ac.version_id END');
  const rows=this.store.all(`SELECT v.id AS version_id,v.number,v.source_type,v.summary,v.faces_json,c.name,d.id AS deck_id,d.name AS deck_name,s.id AS art_set_id,s.name AS art_set_name FROM versions v JOIN cards c ON c.id=v.card_id JOIN decks d ON d.id=c.deck_id JOIN deck_art_versions av ON av.version_id=v.id JOIN deck_art_sets s ON s.id=av.set_id LEFT JOIN deck_art_cards ac ON ac.set_id=s.id AND ac.card_id=c.id WHERE ${where.join(' AND ')} ORDER BY v.created_at DESC,v.rowid DESC,s.id LIMIT 49 OFFSET ?`,...args,(page-1)*48);
  return {page,has_more:rows.length>48,cards:rows.slice(0,48).map(row=>{const summary=JSON.parse(row.summary);return {...row,summary:undefined,faces_json:undefined,display_name:summary.display_name||row.name,preview:'/assets/'+row.version_id+'/thumb?border_revision='+this.store.get("SELECT value FROM settings WHERE key='border_revision'")?.value,has_back:JSON.parse(row.faces_json||'[]').some(f=>f.label==='back')};})};
 }
 async search({query='',page=1}={}){
  if(typeof query!=='string'||!query.trim()||query.length>500)throw Error('Enter a Magic card name or Scryfall search.');page=Number(page);if(!Number.isInteger(page)||page<1||page>100)throw Error('Invalid printing page.');
  try{const result=await this.official.api('/cards/search?'+new URLSearchParams({q:query.trim(),unique:'prints',order:'name',page:String(page)}));for(const card of result.data||[])this.official.save(card);return {page,total:result.total_cards,has_more:!!result.has_more,cards:(result.data||[]).filter(card=>printingFaces(card).length).map(card=>this.official.describe(card))};}
  catch(error){if(error.scryfall_status===404)return {page,total:0,has_more:false,cards:[]};throw error;}
 }
 async importImages({name,front,back=null,bleed_mm=0}={}){
  if(typeof name!=='string'||!name.trim()||name.length>180)throw Error('Name the imported card.');bleed_mm=Number(bleed_mm);if(!Number.isFinite(bleed_mm)||bleed_mm<0||bleed_mm>5)throw Error('Existing bleed must be between 0 and 5 mm per edge.');
  const importId=id(),directory=path.join(this.store.directory,'print-imports',importId);fs.mkdirSync(directory,{recursive:true});
  try{const files=[];for(const [i,data] of [front,back].entries()){if(i===1&&!data)continue;if(typeof data!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(data))throw Error('Choose PNG, JPEG or WebP card images.');const bytes=Buffer.from(data.split(',')[1],'base64');if(bytes.length>16*1024*1024)throw Error('Each image must be at most 16 MB.');const file=path.join(directory,'original-'+i);fs.writeFileSync(file,bytes);files.push(file);}
   const request=path.join(directory,'import-request.json');fs.writeFileSync(request,JSON.stringify({directory,files,bleed_mm}));
   const {stdout}=await run(this.borders.python,[path.join(this.borders.root,'studio/image_import.py'),request],{timeout:60000,maxBuffer:1000000});const result=JSON.parse(stdout),data={image_path:result.faces[0].image_path,back_path:result.faces[1]?.image_path||null,quality:result.faces};fs.writeFileSync(path.join(directory,'provenance.json'),JSON.stringify(result,null,2));this.store.run('INSERT INTO print_imports VALUES(?,?,?,?)',importId,name.trim(),JSON.stringify(data),now());return {id:importId,name:name.trim(),...data};
  }catch(error){fs.rmSync(directory,{recursive:true,force:true});throw error;}
 }
 importAsset(importId,face){const row=this.store.get('SELECT data FROM print_imports WHERE id=?',importId);if(!row||!['front','back'].includes(face))throw Error('Imported image not found.');const file=JSON.parse(row.data)[face==='front'?'image_path':'back_path'];if(!file)throw Error('Imported face not found.');return file;}
 async prepare(item){
  if(!item||typeof item!=='object'||Array.isArray(item)||[item.version_id,item.printing_id,item.import_id].filter(Boolean).length!==1)throw Error('Choose a saved artwork version or an official printing.');
  const quantity=this.quantity(item.quantity);let data,sourceKey;
  if(item.import_id){const row=this.store.get('SELECT * FROM print_imports WHERE id=?',item.import_id);if(!row)throw Error('Imported image not found.');data={...JSON.parse(row.data),name:row.name,display_name:row.name,import_id:row.id,source_type:'imported',border_settings:{style:'none',width_mm:0}};sourceKey=JSON.stringify(['import',row.id]);}
  else if(item.version_id){
   const row=this.store.get(`SELECT v.*,c.name,c.deck_id,c.border_settings AS card_border,d.name AS deck_name,d.active_art_set_id,d.border_settings AS deck_border,s.id AS set_id,s.name AS set_name,s.config_json,ac.state_json FROM versions v JOIN cards c ON c.id=v.card_id JOIN decks d ON d.id=c.deck_id JOIN deck_art_versions av ON av.version_id=v.id JOIN deck_art_sets s ON s.id=av.set_id LEFT JOIN deck_art_cards ac ON ac.set_id=s.id AND ac.card_id=c.id WHERE v.id=? AND s.id=?`,item.version_id,item.art_set_id||'');
   if(!row)throw Error('Choose a saved version and its artwork set.');
   const current=row.active_art_set_id===row.set_id,config=JSON.parse(row.config_json),state=JSON.parse(row.state_json||'{}');
   const override=borderSettings(JSON.parse((current?row.card_border:state.border_settings)||'{}'),{inherit:true});
   const settings=row.source_type==='official'?{style:'none',width_mm:0}:override.style?override:borderSettings(JSON.parse((current?row.deck_border:config.border_settings)||'null'));
   const finished=await this.borders.version(row,{settings}),back=JSON.parse(finished.faces_json||'[]').find(face=>face.label==='back');
   data={name:row.name,display_name:JSON.parse(row.summary).display_name||row.name,image_path:finished.image_path,back_path:back?.image_path||null,source_type:row.source_type,version_id:row.id,version_number:row.number,deck_id:row.deck_id,deck_name:row.deck_name,art_set_id:row.set_id,art_set_name:row.set_name,border_settings:settings};
   sourceKey=JSON.stringify(['version',row.id,row.set_id,settings]);
  }else{
   const card=await this.official.printing(item.printing_id),faces=printingFaces(card);if(!faces.length||faces.length>2)throw Error('This printing has no supported card images.');
   const images=[];for(let i=0;i<faces.length;i++)images.push(await this.official.image(card.id,i,faces[i].image_uris.png?'png':'large'));
   data={name:card.name,display_name:card.flavor_name||card.name,source_type:'official',printing_id:card.id,set_name:card.set_name,set:card.set,collector_number:card.collector_number,scryfall_uri:card.scryfall_uri,image_path:images[0],back_path:images[1]||null,border_settings:{style:'none',width_mm:0}};
   sourceKey=JSON.stringify(['official',card.id]);
  }
  return {quantity,data,source_key:createHash('sha256').update(sourceKey).digest('hex')};
 }
 async add({items}={}){
  if(!Array.isArray(items)||!items.length||items.length>500)throw Error('Choose 1–500 images to add.');
  const prepared=[];for(const item of items)prepared.push(await this.prepare(item));
  const count=this.list().count+prepared.reduce((n,i)=>n+i.quantity,0);if(count>1000)throw Error('The print tray holds up to 1,000 copies.');
  const created=[];
  try{this.store.transaction(()=>{for(const item of prepared){const old=this.store.get('SELECT * FROM print_tray_items WHERE source_key=?',item.source_key);if(old){const quantity=this.quantity(old.quantity+item.quantity);this.store.run('UPDATE print_tray_items SET quantity=? WHERE id=?',quantity,old.id);continue;}
   const itemId=id(),directory=path.join(this.store.directory,'print-tray',itemId);fs.mkdirSync(directory,{recursive:true});created.push(directory);
   for(const field of ['image_path','back_path'])if(item.data[field]){const source=item.data[field],ext=path.extname(source).toLowerCase();if(!['.png','.jpg','.jpeg'].includes(ext))throw Error('Unsupported print image format.');const destination=path.join(directory,(field==='image_path'?'front':'back')+ext);fs.copyFileSync(source,destination);item.data[field]=destination;}
   this.store.run('INSERT INTO print_tray_items VALUES(?,?,?,?,?)',itemId,item.source_key,item.quantity,JSON.stringify(item.data),now());
  }});}catch(error){for(const directory of created)fs.rmSync(directory,{recursive:true,force:true});throw error;}
  return this.list();
 }
 update(itemId,{quantity}={}){quantity=this.quantity(quantity);const item=this.store.get('SELECT quantity FROM print_tray_items WHERE id=?',itemId);if(!item)throw Error('Print tray item not found.');if(this.list().count-item.quantity+quantity>1000)throw Error('The print tray holds up to 1,000 copies.');this.store.run('UPDATE print_tray_items SET quantity=? WHERE id=?',quantity,itemId);return this.list();}
 remove(itemId){if(itemId){const row=this.store.get('SELECT id FROM print_tray_items WHERE id=?',itemId);if(!row)throw Error('Print tray item not found.');this.store.run('DELETE FROM print_tray_items WHERE id=?',itemId);}else this.store.run('DELETE FROM print_tray_items');return this.list();}
 asset(itemId,face){const row=this.store.get('SELECT data FROM print_tray_items WHERE id=?',itemId);if(!row||!['front','back'].includes(face))throw Error('Print image not found.');const file=JSON.parse(row.data)[face==='front'?'image_path':'back_path'];if(!file)throw Error('Print image not found.');return file;}
 entries(settings={}){
  const tray=this.list().items,selection=settings.items??tray.map(item=>({id:item.id,quantity:item.quantity}));
  if(!Array.isArray(selection)||!selection.length||selection.length>500||new Set(selection.map(i=>i?.id)).size!==selection.length)throw Error('Choose images from the print tray.');
  const entries=[];for(const choice of selection){const item=tray.find(item=>item.id===choice?.id);if(!item)throw Error('The print tray changed. Reopen print settings.');const quantity=this.quantity(choice.quantity??item.quantity);if(settings.face_mode==='backs'&&!item.back_path)continue;entries.push({...item,image_path:settings.face_mode==='backs'?item.back_path:item.image_path,back_path:settings.face_mode==='backs'?null:item.back_path,quantity});}
  return {entries,missing:[],title:'Print tray',print_scope:{kind:'tray',item_ids:selection.map(item=>item.id).sort()}};
 }
}
