import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const run=promisify(execFile);
export const DEFAULT_BORDER={style:'black',width_mm:1.2};
export function borderSettings(value,{inherit=false}={}){
 if(value==null)return inherit?{}:{...DEFAULT_BORDER};if(typeof value!=='object'||Array.isArray(value))throw Error('Invalid outer border settings.');
 if(Object.keys(value).some(k=>!['style','width_mm'].includes(k)))throw Error('Unknown outer border setting.');
 const style=value.style??(inherit?'inherit':'black');if(inherit&&style==='inherit')return {};
 if(!['none','black','classic','modern','white','silver','gold'].includes(style))throw Error('Choose a supported outer border.');
 const width_mm=Number(value.width_mm??(['classic','white','silver','gold'].includes(style)?2:1.2));if(!Number.isFinite(width_mm)||width_mm<0||width_mm>2.2)throw Error('Border width must be between 0 and 2.2 mm.');return style==='none'||width_mm===0?{style:'none',width_mm:0}:{style,width_mm};
}
export class BorderFinish{
 constructor(store,root,{python='python3'}={}){Object.assign(this,{store,root,python});this.active=0;this.waiters=[];this.inflight=new Map();this.code=createHash('sha256').update(fs.readFileSync(path.join(root,'cardforge/borders.py'))).digest('hex');}
 settings(version){if(version.source_type==='official')return {style:'none',width_mm:0};const card=this.store.get('SELECT * FROM cards WHERE id=?',version.card_id),deck=this.store.get('SELECT * FROM decks WHERE id=?',card.deck_id),override=borderSettings(JSON.parse(card.border_settings||'{}'),{inherit:true});return override.style?override:borderSettings(JSON.parse(deck.border_settings));}
 async image(version,{back=false,frame=false,settings:requestedSettings=null,thumbnail=false}={}){
  const face=back?JSON.parse(version.faces_json||'[]').find(f=>f.label==='back'):null,source=back?face?.[frame?'frame_path':'image_path']:version[frame?'frame_path':'image_path'];if(!source)return source;
  const settings=version.source_type==='official'?{style:'none',width_mm:0}:requestedSettings||this.settings(version);if(!thumbnail&&(version.source_type==='official'||settings.style==='none'))return source;
  const stat=fs.statSync(source),parsed=path.parse(source),reportPath=path.join(parsed.dir,parsed.name.replace(/\.frame$/i,'')+'.report.json'),report=fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath,'utf8')):{};
  const metadata=typeof version.summary==='string'?JSON.parse(version.summary):version.summary||{},card=metadata.faces?.[back?1:0]||metadata.card_faces?.[back?1:0]||metadata;
  const key=createHash('sha256').update(JSON.stringify({source,size:stat.size,mtime:stat.mtimeMs,settings,code:this.code,report,card:{power:card.power,loyalty:card.loyalty},official:version.source_type==='official',frame,thumbnail})).digest('hex');const directory=path.join(this.store.directory,'border-cache');fs.mkdirSync(directory,{recursive:true});const destination=path.join(directory,key+(thumbnail?'.thumb.webp':'.png'));if(fs.existsSync(destination))return destination;if(this.inflight.has(key))return this.inflight.get(key);
  const task=(async()=>{if(this.active>=2)await new Promise(resolve=>this.waiters.push(resolve));this.active++;
   try{if(fs.existsSync(destination))return destination;const input=path.join(directory,key+'.json');fs.writeFileSync(input,JSON.stringify({source,destination,settings,report,card,official:version.source_type==='official',frame,thumbnail}));await run(this.python,[path.join(this.root,'cardforge/borders.py'),input],{timeout:60000,maxBuffer:1000000});return destination;}finally{this.active--;this.waiters.shift()?.();}
  })();this.inflight.set(key,task);try{return await task;}finally{this.inflight.delete(key);}
 }
 async version(version,{settings=this.settings(version)}={}){const image_path=await this.image(version,{settings}),faces=JSON.parse(version.faces_json||'[]');for(const face of faces)if(face.label==='back')face.image_path=await this.image(version,{back:true,settings});return {...version,image_path,faces_json:JSON.stringify(faces),border_settings:settings,original_image_path:version.image_path};}
 async entries(entries){return Promise.all(entries.map(async entry=>{const version=this.store.get('SELECT * FROM versions WHERE id=?',entry.id),finished=await this.version(version),back=JSON.parse(finished.faces_json).find(f=>f.label==='back')?.image_path||null;return {...entry,image_path:entry.image_path===version.image_path?finished.image_path:back,back_path:entry.back_path?back:null,border_settings:finished.border_settings,original_image_path:entry.image_path};}));}
}
