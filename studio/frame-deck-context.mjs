import fs from 'node:fs';
import path from 'node:path';
import {inside} from './runner.mjs';

// Read inactive sets directly: choosing frame inspiration must never switch the deck.
export function frameDeckSource(store,artSetId){
 if(!artSetId)return null;
 const set=store.get('SELECT * FROM deck_art_sets WHERE id=?',artSetId);
 if(!set)throw Error('Choose an existing deck artwork set.');
 const deck=store.get('SELECT * FROM decks WHERE id=?',set.deck_id);
 const active=deck.active_art_set_id===set.id;
 return {set,deck:{...deck,...(active?{}:JSON.parse(set.config_json)),active_art_set_id:set.id},active};
}
export function frameDeckContext(store,root,queue,source,directory){
 if(!source)return null;
 const {set,deck,active}=source;
 const direction=queue.styleSnapshot?.(deck,directory)||{text:deck.style||fs.readFileSync(path.join(root,'studio/default-style.txt'),'utf8'),snapshot:null};
 const stylePath=path.join(directory,'deck-style.txt');fs.writeFileSync(stylePath,direction.text);
 const cards=store.all(`SELECT c.id,c.name,c.section,c.entry_kind,${active?'c.active_version_id':'a.version_id'} AS version_id
 FROM cards c LEFT JOIN deck_art_cards a ON a.card_id=c.id AND a.set_id=? WHERE c.deck_id=?
 ORDER BY CASE c.section WHEN 'commander' THEN 0 WHEN 'main' THEN 1 ELSE 2 END,c.created_at,c.id`,set.id,deck.id).map(card=>{
  const version=card.version_id?store.get('SELECT * FROM versions WHERE id=? AND card_id=?',card.version_id,card.id):null;
  const summary=JSON.parse(version?.summary||'{}');
  const art=[];
  if(version?.source_type==='custom'&&version.manifest_path){
   for(const [i,face]of (summary.faces?.length?summary.faces:[summary]).entries()){
    if(!face.art)continue;
    const file=path.resolve(path.dirname(version.manifest_path),face.art);
    if(!fs.existsSync(file))continue;
    const real=fs.realpathSync(file);
    if(inside(root,real)||inside(store.directory,real))art.push({face:i,name:face.name||card.name,path:real});
   }
  }
  return {...card,commander:card.section==='commander',type_line:summary.type_line||summary.faces?.[0]?.type_line||'',colors:summary.colors||summary.faces?.[0]?.colors||[],art};
 });
 return {deck_id:deck.id,deck_name:deck.name,art_set_id:set.id,art_set_name:set.name,style_path:stylePath,style_text:direction.text,style_context:direction.snapshot,cards,illustrated_cards:cards.filter(c=>c.art.length).length};
}
