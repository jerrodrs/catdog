import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {printCount} from './printing.mjs';

const fields=['paper','landscape','face_mode','duplex_edge','page_range','packaging','quality','card_width','card_height','margin','gap','bleed','paper_width','paper_height','quantities','include_tokens','include_sideboard','crop_marks','calibration','skip_missing','copies'];
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function rememberedPrintSettings(settings,plan){
 const values={...settings,...Object.fromEntries(fields.filter(key=>key in plan).map(key=>[key,plan[key]]))};
 values.paper_width=plan.landscape?plan.height:plan.width;values.paper_height=plan.landscape?plan.width:plan.height;
 values.page_range=plan.selected_pages?.join(', ')||'';
 for(const [key,value] of Object.entries({quantities:true,include_tokens:true,include_sideboard:false,skip_missing:false}))values[key]=settings[key]??value;
 return Object.fromEntries(fields.filter(key=>values[key]!==undefined).map(key=>[key,values[key]]));
}

export class PrintHistory{
 constructor(store,borders){Object.assign(this,{store,borders});}
 key(scope){return 'print-export:'+hash(scope);}
 latest(scope){const row=this.store.get('SELECT value FROM settings WHERE key=?',this.key(scope));return row?JSON.parse(row.value):null;}
 files(entry){
  return [entry.image_path,entry.back_path,entry.report_path].filter(Boolean).map(filename=>{
   const stat=fs.statSync(filename);return {filename,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs};
  });
 }
 fingerprint(resolved,plan){
  return hash({scope:resolved.print_scope,plan,entries:resolved.entries.map(entry=>({id:entry.id,quantity:entry.quantity,
   files:this.files(entry),border:resolved.print_scope.kind==='tray'?entry.border_settings:this.borders.settings(entry)})),border_code:this.borders.code});
 }
 match(resolved,settings,plan){
  const record=this.latest(resolved.print_scope);
  if(!record||resolved.missing.length&&!settings.skip_missing)return null;
  if(!fs.existsSync(path.join(this.store.directory,'exports',record.export_id+(record.settings.packaging==='per_page'?'.zip':'.pdf'))))return null;
  try{return record.fingerprint===this.fingerprint(resolved,plan)?record:null;}catch{return null;}
 }
 remember(resolved,settings,plan,exportId,fingerprint=this.fingerprint(resolved,plan),completedAt=new Date().toISOString()){
  const record={export_id:exportId,fingerprint,settings:rememberedPrintSettings(settings,plan),completed_at:completedAt};
  this.store.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',this.key(resolved.print_scope),JSON.stringify(record));
  return record;
 }
 // Older completed manifests predate the index. Adopt one only when its saved
 // versions, order, quantities, borders, set label and file dates still match.
 adoptLegacy(scope,label,settings,resolve,planPrint){
  if(this.latest(scope))return;
  const directory=path.join(this.store.directory,'exports');if(!fs.existsSync(directory))return;
  const candidates=fs.readdirSync(directory).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).map(name=>({name,mtime:fs.statSync(path.join(directory,name)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
  for(const {name} of candidates){
   try{
    const saved=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
    if(saved.deck_name!==label||!saved.plan||!Array.isArray(saved.entries)||saved.print_scope&&canonical(saved.print_scope)!==canonical(scope))continue;
    const exportId=name.slice(0,-5),output=path.join(directory,exportId+(saved.plan.packaging==='per_page'?'.zip':'.pdf'));
    if(!fs.existsSync(output)||saved.plan.packaging==='per_page'&&!Array.isArray(saved.pages))continue;
    const restored=rememberedPrintSettings(saved.settings||{},saved.plan),effective={...settings,...restored},resolved=resolve(effective),plan=planPrint(effective,printCount(resolved.entries,effective));
    if(canonical(plan)!==canonical(saved.plan)||resolved.entries.length!==saved.entries.length)continue;
    const completed=fs.statSync(output).mtimeMs;
    if(!resolved.entries.every((entry,i)=>{
     const old=saved.entries[i];return entry.id===old.id&&entry.quantity===old.quantity&&entry.image_path===(old.original_image_path||old.image_path)
      &&canonical(this.borders.settings(entry))===canonical(old.border_settings)
      &&this.files(entry).every(file=>file.mtime<=completed);
    }))continue;
    if(saved.plan.packaging!=='per_page'){
     const fd=fs.openSync(output,'r');try{const stat=fs.fstatSync(fd),tail=Buffer.alloc(Math.min(128,stat.size));fs.readSync(fd,tail,0,tail.length,stat.size-tail.length);if(!tail.includes(Buffer.from('%%EOF')))continue;}finally{fs.closeSync(fd);}
    }
    this.remember(resolved,effective,plan,exportId,undefined,new Date(completed).toISOString());return;
   }catch{/* Ignore unrelated, incomplete or stale export snapshots. */}
  }
 }
}
