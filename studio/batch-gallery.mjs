import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
function within(root,file){const relative=path.relative(fs.realpathSync(root),fs.realpathSync(file));return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
export const batchWaitingSql=alias=>`EXISTS(SELECT 1 FROM generation_batches b JOIN json_each(b.anchor_card_ids) anchor
 WHERE b.id=${alias}.batch_id AND CAST(anchor.key AS INTEGER)<COALESCE((SELECT CAST(current.key AS INTEGER) FROM json_each(b.anchor_card_ids) current WHERE current.value=${alias}.card_id),2147483647)
 AND NOT EXISTS(SELECT 1 FROM versions ready JOIN jobs prerequisite ON prerequisite.id=ready.job_id WHERE prerequisite.batch_id=b.id AND prerequisite.status='succeeded' AND ready.card_id=anchor.value))`;
export function batchVersions(store,job){
 if(!job.batch_id)return [];
 const rows=store.all(`SELECT v.id AS version_id,v.card_id,v.image_path,v.manifest_path,v.scene_json,v.summary,v.report_path,c.name,c.variant_index
 FROM versions v JOIN jobs j ON j.id=v.job_id JOIN cards c ON c.id=v.card_id
 WHERE j.batch_id=? AND j.deck_id=? AND j.status='succeeded' AND v.card_id!=? ORDER BY v.created_at DESC,v.rowid DESC`,job.batch_id,job.deck_id,job.card_id||'');
 const seen=new Set();return rows.filter(row=>!seen.has(row.card_id)&&seen.add(row.card_id));
}
function atomicJson(file,value){const temporary=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2));fs.renameSync(temporary,file);}
export function syncBatchGallery(store,job,root){
 const batch=store.get('SELECT * FROM generation_batches WHERE id=? AND deck_id=?',job.batch_id,job.deck_id);if(!batch)throw Error('Generation batch does not belong to this deck.');
 const directory=path.join(store.directory,'generation-batches',batch.id);fs.mkdirSync(path.join(directory,'images'),{recursive:true});
 const cards=batchVersions(store,{...job,card_id:null}).reverse().map(version=>{
  const manifest=JSON.parse(fs.readFileSync(version.manifest_path,'utf8')),card=manifest.cards?.[0];
  const faces=card?.faces||[card];const images=faces.map((face,index)=>{
   const source=face?.art?path.resolve(path.dirname(version.manifest_path),face.art):index===0?version.image_path:null;if(!source||!fs.existsSync(source))throw Error('Completed batch artwork is missing.');
   if(!within(store.directory,source)&&!within(root,source))throw Error('Batch artwork is outside the application.');
   const extension=path.extname(source).toLowerCase();if(!['.png','.jpg','.jpeg','.webp'].includes(extension))throw Error('Batch review needs a supported image.');
   const relative='images/'+version.version_id+'-'+index+extension,destination=path.join(directory,relative);if(!fs.existsSync(destination)){const temporary=destination+'.'+randomUUID()+'.tmp';fs.copyFileSync(source,temporary);fs.renameSync(temporary,destination);}return relative;
  });
  return {version_id:version.version_id,card_id:version.card_id,name:version.name+(version.variant_index?' · art '+version.variant_index:''),scene:JSON.parse(version.scene_json||'{}'),images};
 });
 const index={batch_id:batch.id,anchor_card_ids:JSON.parse(batch.anchor_card_ids),scope:'same-batch-only',purpose:'visual-consistency-review-only',updated_at:new Date().toISOString(),cards};atomicJson(path.join(directory,'index.json'),index);return {directory,index};
}
export function galleryReferences(directory,index,cardId){return index.cards.filter(card=>card.card_id!==cardId).map(card=>({...card,image_path:path.join(directory,card.images[0])}));}
export function validateBatchReview(store,job,request){
 if(!request.generation_batch)return null;
 const filename=path.join(job.directory,'batch-consistency-review.json');if(!fs.existsSync(filename))throw Error('Save batch-consistency-review.json after checking the current batch gallery.');const review=JSON.parse(fs.readFileSync(filename,'utf8'));
 if(review.batch_id!==job.batch_id||!Array.isArray(review.reviewed_version_ids)||review.reviewed_version_ids.length>20||typeof review.notes!=='string'||!review.notes.trim()||review.notes.length>6000)throw Error('Invalid batch consistency review.');
 const permitted=new Set(batchVersions(store,job).map(v=>v.version_id));if(review.reviewed_version_ids.some(id=>typeof id!=='string'||!permitted.has(id)))throw Error('Consistency review referenced a card outside this generation batch.');
 if(request.batch_consistency.initial_reference_count>0&&!review.reviewed_version_ids.length)throw Error('Review at least one completed card from this batch before finishing.');return review;
}
