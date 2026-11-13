import {randomUUID} from 'node:crypto';
const now=()=>new Date().toISOString();
const FIELDS=['active_version_id','customization','approval','art_mode','printing_json','printing_error','image_provider','scene_plan','notes','border_settings'];
const DEFAULTS={active_version_id:null,customization:'{}',approval:'unreviewed',art_mode:'custom',printing_json:'{}',printing_error:'',image_provider:'',scene_plan:'{}',notes:'',border_settings:'{}'};
const CONFIG=['style','guidelines_mode','guidelines_sections','style_revision_id','frame_set_id','image_provider','border_settings'];
export class DeckArtSets{
 constructor(store){this.store=store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS deck_art_sets(id TEXT PRIMARY KEY,deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,name TEXT NOT NULL,config_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS deck_art_cards(set_id TEXT NOT NULL REFERENCES deck_art_sets(id) ON DELETE CASCADE,card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,state_json TEXT NOT NULL,PRIMARY KEY(set_id,card_id));
   CREATE TABLE IF NOT EXISTS deck_art_versions(set_id TEXT NOT NULL REFERENCES deck_art_sets(id) ON DELETE CASCADE,version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,PRIMARY KEY(set_id,version_id));`);
  for(const [table,column]of [['decks','active_art_set_id'],['jobs','art_set_id']])if(!store.all(`PRAGMA table_info(${table})`).some(c=>c.name===column))store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  store.transaction(()=>{for(const deck of store.all('SELECT id FROM decks'))this.ensure(deck.id);});
 }
 ensure(deckId){const s=this.store,deck=s.get('SELECT * FROM decks WHERE id=?',deckId);if(!deck)throw Error('Deck not found.');if(deck.active_art_set_id&&s.get('SELECT id FROM deck_art_sets WHERE id=? AND deck_id=?',deck.active_art_set_id,deckId))return deck.active_art_set_id;
  const setId=randomUUID();s.run('INSERT INTO deck_art_sets(id,deck_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',setId,deckId,'Original artwork',now(),now());s.run('UPDATE decks SET active_art_set_id=? WHERE id=?',setId,deckId);
  s.run('INSERT OR IGNORE INTO deck_art_versions SELECT ?,v.id FROM versions v JOIN cards c ON c.id=v.card_id WHERE c.deck_id=?',setId,deckId);s.run("UPDATE jobs SET art_set_id=? WHERE deck_id=? AND art_set_id=''",setId,deckId);this.save(deckId);return setId;
 }
 config(deck){return Object.fromEntries(CONFIG.filter(k=>k in deck).map(k=>[k,deck[k]]));}
 save(deckId){const s=this.store,deck=s.get('SELECT * FROM decks WHERE id=?',deckId);if(!deck?.active_art_set_id)return;
  s.run('UPDATE deck_art_sets SET config_json=?,updated_at=? WHERE id=?',JSON.stringify(this.config(deck)),now(),deck.active_art_set_id);
  for(const card of s.all('SELECT * FROM cards WHERE deck_id=?',deckId))s.run('INSERT OR REPLACE INTO deck_art_cards(set_id,card_id,version_id,state_json) VALUES(?,?,?,?)',deck.active_art_set_id,card.id,card.active_version_id,JSON.stringify(Object.fromEntries(FIELDS.map(k=>[k,card[k]]))));
 }
 list(deckId){const s=this.store,current=this.ensure(deckId),total=s.get('SELECT COUNT(*) n FROM cards WHERE deck_id=?',deckId).n;
  return s.all('SELECT * FROM deck_art_sets WHERE deck_id=? ORDER BY created_at,rowid',deckId).map(set=>{const active=set.id===current,ready=active?s.get('SELECT COUNT(*) n FROM cards WHERE deck_id=? AND active_version_id IS NOT NULL',deckId).n:s.get('SELECT COUNT(*) n FROM deck_art_cards a JOIN cards c ON c.id=a.card_id WHERE a.set_id=? AND c.deck_id=? AND a.version_id IS NOT NULL',set.id,deckId).n;return {id:set.id,deck_id:deckId,name:set.name,active,ready,total,complete:ready===total&&total>0,created_at:set.created_at,updated_at:set.updated_at};});
 }
 busyReason(deckId){const s=this.store,external=this.externalBusy?.(deckId);if(external)return external;
  if(s.get("SELECT id FROM jobs WHERE deck_id=? AND status IN ('queued','running') LIMIT 1",deckId))return 'Finish or cancel this deck’s generation jobs before switching artwork sets.';
  if(s.get("SELECT id FROM cards WHERE deck_id=? AND art_mode='official' AND active_version_id IS NULL AND printing_json!='{}' AND printing_error='' LIMIT 1",deckId))return 'Wait for the official printing imports to finish before switching artwork sets.';
  if(s.get("SELECT name FROM sqlite_master WHERE type='table' AND name='style_extractions'")&&s.get("SELECT id FROM style_extractions WHERE owner_type='deck' AND owner_id=? AND status IN ('queued','running') LIMIT 1",deckId))return 'Finish or cancel this deck’s reference analysis before switching artwork sets.';
  if(s.get("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_sessions'")&&s.get("SELECT id FROM chat_sessions WHERE (deck_id=? OR deck_id IS NULL) AND status='running' LIMIT 1",deckId))return 'Finish or stop the active deck chat before switching artwork sets.';
  return '';
 }
 writable(deckId){const deck=this.store.get('SELECT * FROM decks WHERE id=?',deckId);if(!deck)throw Error('Deck not found.');if(deck.archived)throw Error('Restore this deck before changing artwork sets.');const reason=this.busyReason(deckId);if(reason)throw Error(reason);return deck;}
 name(value){if(typeof value!=='string'||!value.trim()||value.length>120||/[\x00-\x1f]/.test(value))throw Error('Give the artwork set a name of 1–120 characters.');return value.trim();}
 target(deckId,setId){const set=this.store.get('SELECT * FROM deck_art_sets WHERE id=? AND deck_id=?',setId,deckId);if(!set)throw Error('Artwork set not found in this deck.');return set;}
 activate(deckId,setId){this.target(deckId,setId);const deck=this.writable(deckId);if(deck.active_art_set_id===setId)return;
  this.store.transaction(()=>{this.save(deckId);this.load(deckId,setId);});
 }
 load(deckId,setId){const s=this.store,set=this.target(deckId,setId),columns=new Set(s.all('PRAGMA table_info(decks)').map(c=>c.name)),config={border_settings:JSON.stringify({style:'black',width_mm:1.2}),...JSON.parse(set.config_json)};
  for(const [field,value]of Object.entries(config))if(CONFIG.includes(field)&&columns.has(field))s.run(`UPDATE decks SET ${field}=? WHERE id=?`,value,deckId);
  for(const card of s.all('SELECT id FROM cards WHERE deck_id=?',deckId)){const saved=s.get('SELECT state_json FROM deck_art_cards WHERE set_id=? AND card_id=?',setId,card.id),state={...DEFAULTS,...(saved?JSON.parse(saved.state_json):{})};s.run(`UPDATE cards SET ${FIELDS.map(k=>k+'=?').join(',')} WHERE id=?`,...FIELDS.map(k=>state[k]),card.id);}
  s.run('UPDATE decks SET active_art_set_id=?,updated_at=? WHERE id=?',setId,now(),deckId);s.bumpBorder();
 }
 create(deckId,{name,mode='copy',guidelines='copy',style=''}={}){const s=this.store,deck=this.writable(deckId);if(!['copy','fresh'].includes(mode))throw Error('Choose copy or fresh artwork.');if(!['copy','fresh'].includes(guidelines)||typeof style!=='string'||style.length>50000||style.includes('\0'))throw Error('Invalid artwork-set guidelines.');name=this.name(name);const setId=randomUUID();
  s.transaction(()=>{this.save(deckId);s.run('INSERT INTO deck_art_sets VALUES(?,?,?,?,?,?)',setId,deckId,name,JSON.stringify(guidelines==='fresh'?{...this.config(deck),style,guidelines_mode:'custom',guidelines_sections:'{}',style_revision_id:null}:this.config(deck)),now(),now());
   if(mode==='copy'){s.run('INSERT INTO deck_art_cards SELECT ?,card_id,version_id,state_json FROM deck_art_cards WHERE set_id=?',setId,deck.active_art_set_id);s.run('INSERT INTO deck_art_versions SELECT ?,version_id FROM deck_art_versions WHERE set_id=?',setId,deck.active_art_set_id);}
   if(guidelines==='copy'&&s.get("SELECT name FROM sqlite_master WHERE type='table' AND name='art_references'")){for(const ref of s.all("SELECT * FROM art_references WHERE owner_type='deck' AND owner_id=? AND art_set_id=? AND removed=0",deckId,deck.active_art_set_id))s.run('INSERT INTO art_references(id,owner_type,owner_id,name,mime,width,height,bytes,sha256,original_path,image_path,thumb_path,features,created_at,art_set_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),'deck',deckId,ref.name,ref.mime,ref.width,ref.height,ref.bytes,ref.sha256,ref.original_path,ref.image_path,ref.thumb_path,ref.features,now(),setId);}
   this.load(deckId,setId);
  });return this.list(deckId).find(set=>set.id===setId);
 }
 rename(deckId,setId,name){this.target(deckId,setId);name=this.name(name);this.store.run('UPDATE deck_art_sets SET name=?,updated_at=? WHERE id=?',name,now(),setId);this.store.touch(deckId);return this.list(deckId).find(set=>set.id===setId);}
}
