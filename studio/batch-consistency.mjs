// Read only this generation batch's live peer gallery.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
function gallery(request){
 const context=request.batch_consistency,batch=request.generation_batch;if(!context||!batch)return null;if(context.batch_id!==batch.id)throw Error('Batch context mismatch.');
 const root=fs.realpathSync(context.gallery_path),index=JSON.parse(fs.readFileSync(path.join(root,'index.json'),'utf8'));if(index.batch_id!==batch.id)throw Error('Gallery belongs to a different generation batch.');return {root,index,peers:index.cards.filter(card=>card.card_id!==request.card.id)};
}
export function batchSceneReferences(request){const current=gallery(request);return current?current.peers.map(({card_id,name,scene})=>({card_id,name,scene})):request.deck.art_references||[];}
export function batchConsistencyInputs(request){
 const current=gallery(request);if(!current)return {batch_id:null,references:[]};const {root,index,peers}=current,batch=request.generation_batch;
 const anchors=peers.filter(card=>(index.anchor_card_ids||[]).includes(card.card_id)),others=peers.filter(card=>!anchors.includes(card)),chosen=[...anchors,...(others.length?[others[0],...others.slice(1).reverse()]:[])].slice(0,3);
 const references=chosen.map(card=>({...card,images:card.images.map(relative=>{if(path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Invalid batch image path.');const image=path.resolve(root,relative),r=path.relative(root,fs.realpathSync(image));if(r.startsWith('..')||path.isAbsolute(r))throw Error('Batch image escaped its gallery.');return image;})}));
 return {batch_id:batch.id,scope:'same-batch-only',purpose:'visual-consistency-review-only',checked_at:new Date().toISOString(),available_peer_cards:peers.length,references};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{const requestFile=process.argv[2],request=JSON.parse(fs.readFileSync(requestFile,'utf8')),result=batchConsistencyInputs(request);fs.writeFileSync(path.join(request.output_directory,'batch-consistency-inputs.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}catch(e){console.error(e.message);process.exitCode=1;}
