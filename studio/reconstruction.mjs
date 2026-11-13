import fs from 'node:fs';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {id} from './store.mjs';import {printingFaces,reconstructable} from './official-printings.mjs';
const run=promisify(execFile);
export class Reconstruction {
 constructor(store,official,root,{notify=()=>{},python='python3'}={}){Object.assign(this,{store,official,root,notify,python});}
 async create(cardId,{printing_id,art_images=[]}={}){
  if(!Array.isArray(art_images)||art_images.length>2)throw Error('Supply up to two artwork references.');
  if(this.official.locks.has(cardId))throw Error('Artwork for this card is already being saved.');this.official.locks.add(cardId);let directory;
  try{
   const target=this.official.writable(cardId),setId=this.store.artSets.ensure(target.deck_id),printing=await this.official.printing(printing_id);
   if(!this.official.matches(target,printing))throw Error('Choose a printing of this same Magic card.');
   if(!reconstructable(printing))throw Error('This layout needs a dedicated reconstruction template; its original scan is still available.');
   const faces=printingFaces(printing);if(!faces.length||faces.length>2)throw Error('This printing has no supported artwork faces.');
   const versionId=id();directory=path.join(this.store.directory,'decks',target.deck_id,'cards',cardId,'versions',versionId);fs.mkdirSync(directory,{recursive:true});
   const artPaths=[],sources=[];
   for(let i=0;i<faces.length;i++){
    if(art_images[i]){const upload=art_images[i];if(typeof upload!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(upload))throw Error('Upload PNG, JPEG or WebP artwork.');const bytes=Buffer.from(upload.split(',')[1],'base64');if(bytes.length>16*1024*1024)throw Error('Artwork exceeds 16 MB.');const file=path.join(directory,`uploaded-art-${i}`);fs.writeFileSync(file,bytes);artPaths.push(file);sources.push('user-uploaded-official-art');}
    else{artPaths.push(await this.official.image(printing.id,i,'art_crop'));sources.push('scryfall-art-crop');}
   }
   const snapshot=path.join(directory,'scryfall.json');fs.writeFileSync(snapshot,JSON.stringify(printing,null,2));const request=path.join(directory,'reconstruction-request.json');fs.writeFileSync(request,JSON.stringify({directory,printing_path:snapshot,art_paths:artPaths,art_sources:sources}));
   const {stdout}=await run(this.python,[path.join(this.root,'studio/reconstruct_card.py'),request],{timeout:180000,maxBuffer:4000000});const built=JSON.parse(stdout.trim().split('\n').at(-1));
   this.official.writable(cardId);if(this.store.artSets.ensure(target.deck_id)!==setId)throw Error('The artwork set changed. Choose reconstruction again in the intended set.');
   this.store.transaction(()=>{this.store.run('UPDATE cards SET metadata=? WHERE id=?',JSON.stringify(printing),cardId);this.store.addVersion(cardId,{...built,id:versionId,source_type:'reconstructed',art_provider:'official',customization_json:JSON.stringify({title_mode:'original',flavor_mode:'style',rarity:'original'}),note:`Reconstructed MTG · ${printing.set_name} #${printing.collector_number} · 1200 PPI text; English Oracle wording`});});
   this.notify();return {version_id:versionId,art_quality:built.art_quality};
  }catch(error){if(directory)fs.rmSync(directory,{recursive:true,force:true});throw error;}finally{this.official.locks.delete(cardId);}
 }
}
