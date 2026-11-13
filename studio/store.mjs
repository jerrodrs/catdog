import {borderSettings,DEFAULT_BORDER} from './borders.mjs';
import {DeckArtSets} from './deck-art-sets.mjs';
import {printingSpec,printingKey} from './decklist.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {cardNameKey} from './card-names.mjs';
import {validateCustomization} from './customization.mjs';
import {chooseScenePlan} from './public/scenes.js';
import {tokenSpec,variantRequest} from './variants.mjs';
import {imageProvider} from './image-providers.mjs';
import {batchWaitingSql} from './batch-gallery.mjs';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const cardKey = cardNameKey;
export function cleanText(value, max = 4000) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`Text must be at most ${max} characters.`);
  return value.trim();
}
// Fit art-variant copies to a new total: grow the last variant, shrink from the end down to one copy each, then drop trailing variants.
export function spreadQuantity(quantities,total){
  const q=[...quantities];let diff=total-q.reduce((a,b)=>a+b,0);
  if(diff>0)q[q.length-1]+=diff;
  for(let i=q.length-1;diff<0&&i>=0;i--){const cut=Math.min(-diff,q[i]-1);q[i]-=cut;diff+=cut;}
  for(let i=q.length-1;diff<0&&i>=0;i--){diff+=q[i];q[i]=0;}
  return q;
}
export class Store {
  constructor(directory,options={}) {
    this.directory = path.resolve(directory); fs.mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'studio.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS decks(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE, name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, section TEXT NOT NULL DEFAULT 'main', notes TEXT NOT NULL DEFAULT '', approval TEXT NOT NULL DEFAULT 'unreviewed', active_version_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, job_id TEXT, number INTEGER NOT NULL, image_path TEXT NOT NULL, frame_path TEXT, manifest_path TEXT, report_path TEXT, summary TEXT NOT NULL DEFAULT '{}', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, deck_id TEXT NOT NULL REFERENCES decks(id), card_id TEXT NOT NULL REFERENCES cards(id), type TEXT NOT NULL, status TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', version_id TEXT NOT NULL, directory TEXT NOT NULL, thread_id TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created_at);
      CREATE INDEX IF NOT EXISTS cards_deck ON cards(deck_id);
      CREATE INDEX IF NOT EXISTS versions_card ON versions(card_id);
    `);
    this.db.exec('CREATE TABLE IF NOT EXISTS generation_batches(id TEXT PRIMARY KEY,deck_id TEXT NOT NULL REFERENCES decks(id),mode TEXT NOT NULL,cards_json TEXT NOT NULL,created_at TEXT NOT NULL)');
    if(!this.all('PRAGMA table_info(generation_batches)').some(column=>column.name==='anchor_card_ids'))this.db.exec("ALTER TABLE generation_batches ADD COLUMN anchor_card_ids TEXT NOT NULL DEFAULT '[]'");
    if(!this.all('PRAGMA table_info(jobs)').some(column=>column.name==='batch_id'))this.db.exec("ALTER TABLE jobs ADD COLUMN batch_id TEXT NOT NULL DEFAULT ''");
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_batch ON jobs(batch_id,deck_id,status)');
    if(!this.all('PRAGMA table_info(versions)').some(column=>column.name==='style_text'))this.db.exec("ALTER TABLE versions ADD COLUMN style_text TEXT NOT NULL DEFAULT ''");
    if(!this.all('PRAGMA table_info(versions)').some(column=>column.name==='scene_json'))this.db.exec("ALTER TABLE versions ADD COLUMN scene_json TEXT NOT NULL DEFAULT '{}'");
    if(!this.all('PRAGMA table_info(versions)').some(column=>column.name==='customization_json'))this.db.exec("ALTER TABLE versions ADD COLUMN customization_json TEXT NOT NULL DEFAULT '{}'");
    if(!this.all('PRAGMA table_info(versions)').some(column=>column.name==='faces_json'))this.db.exec("ALTER TABLE versions ADD COLUMN faces_json TEXT NOT NULL DEFAULT '[]'");
    if(!this.all('PRAGMA table_info(cards)').some(column=>column.name==='scene_plan'))this.db.exec("ALTER TABLE cards ADD COLUMN scene_plan TEXT NOT NULL DEFAULT '{}'");
    if(!this.all('PRAGMA table_info(cards)').some(column=>column.name==='customization'))this.db.exec("ALTER TABLE cards ADD COLUMN customization TEXT NOT NULL DEFAULT '{}'");
    for(const column of ['metadata','roles'])if(!this.all('PRAGMA table_info(cards)').some(c=>c.name===column))this.db.exec(`ALTER TABLE cards ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${column==='roles'?'[]':'{}'}'`);
    for(const [column,definition]of [['entry_kind',"TEXT NOT NULL DEFAULT 'card'"],['variant_group',"TEXT NOT NULL DEFAULT ''"],['variant_index','INTEGER NOT NULL DEFAULT 0'],['token_spec',"TEXT NOT NULL DEFAULT '{}'"]])if(!this.all('PRAGMA table_info(cards)').some(c=>c.name===column))this.db.exec(`ALTER TABLE cards ADD COLUMN ${column} ${definition}`);
    for(const [column,definition]of [['retry_count','INTEGER NOT NULL DEFAULT 0'],['not_before','TEXT']])if(!this.all('PRAGMA table_info(jobs)').some(c=>c.name===column))this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`);
    if(!this.all('PRAGMA table_info(jobs)').some(c=>c.name==='generation_provider')){
      this.db.exec("ALTER TABLE jobs ADD COLUMN generation_provider TEXT NOT NULL DEFAULT 'codex'");
      // Recover frozen choices, never infer a queued job's provider from its deck's current choice.
      for(const job of this.all("SELECT id,type,directory FROM jobs WHERE status IN ('queued','running')")){
        let provider=job.type==='compose'?'local':'codex';
        if(job.type!=='compose')try{const request=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json'),'utf8'));if(request.image_generation?.provider==='grok-cli')provider='grok-cli';}catch{}
        this.run('UPDATE jobs SET generation_provider=? WHERE id=?',provider,job.id);
      }
    }
    if(!this.all('PRAGMA table_info(decks)').some(c=>c.name==='frame_set_id'))this.db.exec("ALTER TABLE decks ADD COLUMN frame_set_id TEXT NOT NULL DEFAULT 'builtin-v2.4'");
    if(!this.all('PRAGMA table_info(decks)').some(c=>c.name==='image_provider'))this.db.exec("ALTER TABLE decks ADD COLUMN image_provider TEXT NOT NULL DEFAULT 'codex'");
    // Blank means the card follows its deck's generation provider.
    if(!this.all('PRAGMA table_info(cards)').some(c=>c.name==='image_provider'))this.db.exec("ALTER TABLE cards ADD COLUMN image_provider TEXT NOT NULL DEFAULT ''");
    for(const [table,column]of [['cards','art_mode'],['versions','source_type']])if(!this.all(`PRAGMA table_info(${table})`).some(c=>c.name===column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'custom'`);
    const migratePrintings=!this.all('PRAGMA table_info(cards)').some(c=>c.name==='printing_json');
    for(const [column,initial]of [['printing_json','{}'],['printing_error','']])if(!this.all('PRAGMA table_info(cards)').some(c=>c.name===column))this.db.exec(`ALTER TABLE cards ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${initial}'`);
    if(migratePrintings)this.db.exec(`UPDATE cards SET printing_json=(SELECT json_object('set',json_extract(summary,'$.set'),'collector_number',json_extract(summary,'$.collector_number')) FROM versions WHERE versions.id=cards.active_version_id) WHERE art_mode='official' AND active_version_id IN (SELECT id FROM versions WHERE json_extract(summary,'$.set') IS NOT NULL AND json_extract(summary,'$.collector_number') IS NOT NULL)`);
    for(const [table,initial]of [['decks',JSON.stringify(DEFAULT_BORDER)],['cards','{}']])if(!this.all(`PRAGMA table_info(${table})`).some(c=>c.name==='border_settings'))this.db.exec(`ALTER TABLE ${table} ADD COLUMN border_settings TEXT NOT NULL DEFAULT '${initial}'`);
    this.run("INSERT OR IGNORE INTO settings(key,value) VALUES('border_revision','1')");
    if(!this.get("SELECT value FROM settings WHERE key='official_border_passthrough_v1'")){this.db.exec("BEGIN; UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='border_revision'; INSERT INTO settings(key,value) VALUES('official_border_passthrough_v1','1'); COMMIT;");}
    this.db.exec('CREATE TABLE IF NOT EXISTS card_cache(name TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL)');
    // Which AI made a version's artwork; blank when unknown (e.g. the original style studies).
    if(!this.all('PRAGMA table_info(versions)').some(c=>c.name==='art_provider')){
      this.db.exec("ALTER TABLE versions ADD COLUMN art_provider TEXT NOT NULL DEFAULT ''");
      this.transaction(()=>{for(const version of this.all('SELECT id,job_id,image_path FROM versions ORDER BY created_at,rowid')){
        const provider=version.job_id?this.jobArtProvider(version.job_id):this.get("SELECT art_provider FROM versions WHERE image_path=? AND id!=? AND art_provider!='' LIMIT 1",version.image_path,version.id)?.art_provider||'';
        if(provider)this.run('UPDATE versions SET art_provider=? WHERE id=?',provider,version.id);
      }});
    }
    for(const version of this.all("SELECT v.id,j.directory FROM versions v JOIN jobs j ON j.id=v.job_id WHERE v.style_text=''")){
      const filename=path.join(version.directory,'style.txt');
      if(fs.existsSync(filename))this.run('UPDATE versions SET style_text=? WHERE id=?',fs.readFileSync(filename,'utf8'),version.id);
    }
    this.artSets=new DeckArtSets(this);
    if(options.recover!==false)this.recoverRunning();
  }
  recoverRunning(){this.db.prepare("UPDATE jobs SET status='failed',error='Studio stopped while this job was running. You can retry it.',finished_at=? WHERE status='running'").run(now());}
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn,{immediate=false}={}) { this.db.exec(immediate?'BEGIN IMMEDIATE':'BEGIN'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  listDecks() {
    return this.all(`SELECT d.*,COUNT(c.id) AS unique_cards,COALESCE(SUM(CASE WHEN c.section IN ('main','commander') THEN c.quantity ELSE 0 END),0) AS total_cards,
      COALESCE(SUM(CASE WHEN c.active_version_id IS NOT NULL THEN 1 ELSE 0 END),0) AS generated,
      (SELECT v.id FROM cards cc JOIN versions v ON v.id=cc.active_version_id WHERE cc.deck_id=d.id ORDER BY CASE cc.section WHEN 'commander' THEN 0 ELSE 1 END,cc.created_at LIMIT 1) AS cover_version_id
      FROM decks d LEFT JOIN cards c ON c.deck_id=d.id GROUP BY d.id ORDER BY d.updated_at DESC`);
  }
  deck(deckId) {
    const deck = this.get('SELECT * FROM decks WHERE id=?', deckId); if (!deck) return null;
    this.artSets.ensure(deckId);deck.active_art_set_id=this.get('SELECT active_art_set_id FROM decks WHERE id=?',deckId).active_art_set_id;
    deck.art_sets=this.artSets.list(deckId);deck.art_set=deck.art_sets.find(s=>s.active);deck.art_set_busy=this.artSets.busyReason(deckId);
    deck.cards = this.all(`SELECT c.*,v.summary,v.scene_json,v.number AS version_number,v.art_provider,
      (SELECT status FROM jobs j WHERE j.card_id=c.id AND (j.art_set_id='' OR j.art_set_id=?) ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1) AS job_status,
      (SELECT id FROM jobs j WHERE j.card_id=c.id AND (j.art_set_id='' OR j.art_set_id=?) ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1) AS latest_job_id
      FROM cards c LEFT JOIN versions v ON v.id=c.active_version_id WHERE c.deck_id=? ORDER BY CASE c.section WHEN 'commander' THEN 0 WHEN 'main' THEN 1 ELSE 2 END,c.created_at`,deck.active_art_set_id,deck.active_art_set_id,deckId)
      .map(c => ({ ...c, summary: JSON.parse(c.summary || '{}'),token_spec:JSON.parse(c.token_spec||'{}'),scene:JSON.parse(c.scene_json||'{}'),scene_plan:JSON.parse(c.scene_plan||'{}'),customization:JSON.parse(c.customization||'{}'),metadata:JSON.parse(c.metadata||'{}'),roles:JSON.parse(c.roles||'[]') }));
    return deck;
  }
  createDeck(data, cards = []) {
    const provider=imageProvider(data.image_provider??'codex');
    const deckId = id(), stamp = now();
    const name = cleanText(data.name || 'Untitled deck', 120); if (!name) throw new Error('Give this deck a name.');
    this.transaction(() => {
      this.run('INSERT INTO decks(id,name,description,folder,style,created_at,updated_at,frame_set_id) VALUES(?,?,?,?,?,?,?,?)', deckId, name, cleanText(data.description || ''), cleanText(data.folder || '', 80), cleanText(data.style || '', 50000), stamp, stamp,cleanText(data.frame_set_id||this.get("SELECT value FROM settings WHERE key='default_frame_set'")?.value||'builtin-v2.4',120));
      if(this.all('PRAGMA table_info(decks)').some(c=>c.name==='guidelines_mode'))this.run('UPDATE decks SET guidelines_mode=?,guidelines_sections=?,style_revision_id=? WHERE id=?',data.guidelines_mode||'custom',typeof data.guidelines_sections==='string'?data.guidelines_sections:JSON.stringify(data.guidelines_sections||{}),data.style_revision_id||null,deckId);
      this.artSets.ensure(deckId);
      this.importCards(deckId,cards,{deduplicate:data.deduplicate!==false});
      this.run('UPDATE decks SET image_provider=? WHERE id=?',provider,deckId);if(data.border_settings)this.run('UPDATE decks SET border_settings=? WHERE id=?',json(borderSettings(typeof data.border_settings==='string'?JSON.parse(data.border_settings):data.border_settings)),deckId);
    });
    return this.deck(deckId);
  }
  addCard(deckId, data,{separate=false}={}) {
    if (!this.get('SELECT id FROM decks WHERE id=?', deckId)) throw new Error('Deck not found.');
    const name = cleanText(data.name, 180); if (!name) throw new Error('Enter a card name.');
    const quantity = Number(data.quantity ?? 1), section = data.section || 'main';
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || !['main', 'commander', 'sideboard','tokens'].includes(section)) throw new Error('Invalid quantity or section.');
    const kind=section==='tokens'?'token':'card';
    const printing=printingSpec(data.printing??(data.printing_json?JSON.parse(data.printing_json):null));
    const existing = !separate&&!data.variant_group&&this.all('SELECT * FROM cards WHERE deck_id=? AND name=? COLLATE NOCASE AND section=?',deckId,name,section).find(c=>printingKey(c)===printingKey({printing}));
    if (existing) { if (existing.quantity + quantity > 999) throw new Error('Too many copies.'); this.run('UPDATE cards SET quantity=quantity+? WHERE id=?', quantity, existing.id); this.touch(deckId); return existing.id; }
    const spec=kind==='token'?(printing&&!data.token_spec?{}:tokenSpec(data.token_spec)):{};
    const cardId = id(); this.run('INSERT INTO cards(id,deck_id,name,quantity,section,created_at) VALUES(?,?,?,?,?,?)', cardId, deckId, name, quantity, section, now());
    if(printing)this.run("UPDATE cards SET printing_json=?,art_mode='official' WHERE id=?",json(printing),cardId);
    this.run('UPDATE cards SET entry_kind=?,variant_group=?,variant_index=?,token_spec=?,metadata=? WHERE id=?',kind,data.variant_group||'',data.variant_index||0,json(spec),kind==='token'?json({...spec,source:'user-defined token'}):'{}',cardId);
    this.touch(deckId); return cardId;
  }
  importCards(deckId,cards,{deduplicate=true}={}) {
    const result={ids:[],added:0,skipped:0,reused:0,updated:0};
    const initialIds=new Set(this.all('SELECT id FROM cards WHERE deck_id=?',deckId).map(c=>c.id));
    for(const card of cards){
      const key=cardKey(card.name),section=card.section||'main';
      let existing=this.all('SELECT * FROM cards WHERE deck_id=?',deckId).find(c=>(cardKey(c.name)===key||(['transform','modal_dfc'].includes(JSON.parse(c.metadata||'{}').layout)&&JSON.parse(c.metadata||'{}').card_faces?.some(f=>cardKey(f.name)===key))) && (printingKey(c)===printingKey(card)||(!printingKey(card)&&deduplicate&&initialIds.has(c.id))) && (c.section===section || (deduplicate && c.section==='commander' && section==='main')));
      // A new artwork set already has the shared inventory: an explicit printing fills a blank entry.
      if(!existing&&card.printing&&deduplicate){const blank=this.all('SELECT * FROM cards WHERE deck_id=?',deckId).find(c=>initialIds.has(c.id)&&cardKey(c.name)===key&&c.section===section&&!c.active_version_id&&c.art_mode==='custom'&&!printingKey(c));if(blank){this.run("UPDATE cards SET art_mode='official',printing_json=?,printing_error='' WHERE id=?",json(printingSpec(card.printing)),blank.id);existing=blank;result.updated++;}}
      let cardId;
      if(existing && deduplicate){cardId=existing.id;result.skipped++;}
      else {cardId=this.addCard(deckId,existing?{...card,name:existing.name,section:existing.section}:card);result[existing?'updated':'added']++;}
      result.ids.push(cardId);

    }
    return result;
  }
  // Swap the whole list: listed entries keep their card records (artwork, versions, notes); unlisted entries are removed.
  planReplacement(deckId,cards,{keepTokens=true}={}){
    if(!this.get('SELECT id FROM decks WHERE id=?',deckId))throw new Error('Deck not found.');
    if(!cards.length)throw new Error('Paste at least one card. To empty a deck, remove its cards instead.');
    const rows=this.all("SELECT c.*,(SELECT COUNT(*) FROM jobs j WHERE j.card_id=c.id AND j.status IN ('queued','running')) AS active_jobs,(SELECT COUNT(*) FROM versions v WHERE v.card_id=c.id) AS version_count FROM cards c WHERE c.deck_id=? ORDER BY c.variant_index,c.created_at",deckId);
    const keys=row=>{const meta=JSON.parse(row.metadata||'{}');return [row.name,...(['transform','modal_dfc'].includes(meta.layout)?(meta.card_faces||[]).map(f=>f.name):[])].map(cardKey);};
    const claimed=new Set(),matches=new Map(),explicitCommander=cards.some(c=>c.section==='commander');
    // Exact sections first, so a card listed in two sections claims the right rows before any section move.
    const passes=[(card,row)=>row.section===card.section,(card,row)=>!explicitCommander&&card.section==='main'&&row.section==='commander',(card,row)=>(row.entry_kind==='token')===(card.section==='tokens')];
    for(const test of passes)for(const card of [...cards].sort((a,b)=>Boolean(printingKey(b))-Boolean(printingKey(a)))){
      if(matches.has(card))continue;
      const first=rows.find(r=>!claimed.has(r.id)&&keys(r).includes(cardKey(card.name))&&(!printingKey(card)||printingKey(r)===printingKey(card))&&test(card,r));if(!first)continue;
      const group=rows.filter(r=>!claimed.has(r.id)&&(r.id===first.id||(first.variant_group&&r.variant_group===first.variant_group&&r.section===first.section)));
      for(const r of group)claimed.add(r.id);matches.set(card,{rows:group,section:test===passes[1]?'commander':card.section});
    }
    const plan={kept:0,kept_art:0,added:[],removed:[],changed:[],blocked:[],tokens_kept:0};
    const removeRow=row=>{plan.removed.push({id:row.id,name:row.name,quantity:row.quantity,section:row.section,has_art:Boolean(row.active_version_id),versions:row.version_count});if(row.active_jobs)plan.blocked.push(row.name);};
    for(const card of cards){
      const match=matches.get(card);
      if(!match){plan.added.push({name:card.name,quantity:card.quantity,section:card.section,...(card.printing?{printing:card.printing}:{})});continue;}
      const quantities=spreadQuantity(match.rows.map(r=>r.quantity),card.quantity);
      match.rows.forEach((row,i)=>{
        if(!quantities[i])return removeRow(row);
        plan.kept++;if(row.active_version_id)plan.kept_art++;
        if(row.quantity!==quantities[i]||row.section!==match.section)plan.changed.push({id:row.id,name:row.name,variant_index:row.variant_index,from:{quantity:row.quantity,section:row.section},to:{quantity:quantities[i],section:match.section}});
      });
    }
    const newTokens=plan.added.filter(c=>c.section==='tokens'&&!c.printing).map(c=>c.name);
    if(newTokens.length)throw new Error(`${newTokens.join(', ')} ${newTokens.length===1?'is a new token':'are new tokens'}. Add new tokens with Add → Tokens so their type, colours and rules are specified.`);
    for(const row of rows.filter(r=>!claimed.has(r.id)))keepTokens&&row.entry_kind==='token'?plan.tokens_kept++:removeRow(row);
    return plan;
  }
  replaceCards(deckId,cards,options={}){
    return this.transaction(()=>{
      const plan=this.planReplacement(deckId,cards,options);
      if(plan.blocked.length)throw new Error(`Cancel generation for ${plan.blocked.join(', ')} before removing ${plan.blocked.length===1?'it':'them'}.`);
      for(const row of plan.removed)this.deleteCard(row.id);
      for(const row of plan.changed)this.run('UPDATE cards SET quantity=?,section=? WHERE id=?',row.to.quantity,row.to.section,row.id);
      plan.ids=plan.added.map(card=>this.addCard(deckId,card));
      this.touch(deckId);return plan;
    });
  }
  // Sub one card for another in its slot. The outgoing card moves to the sideboard with its artwork unless removed;
  // an incoming card already in the sideboard is moved back in with its artwork.
  swapCard(cardId,data={}){
    return this.transaction(()=>{
      const old=this.get('SELECT * FROM cards WHERE id=?',cardId);if(!old)throw new Error('Card not found.');
      if(old.entry_kind==='token')throw new Error('Tokens cannot be swapped. Add or remove tokens instead.');
      const name=cleanText(data.name,180);if(!name)throw new Error('Enter the card to swap in.');
      if(cardKey(name)===cardKey(old.name))throw new Error(`${old.name} is already in this slot.`);
      const keepOld=data.keep_old!==false&&old.section!=='sideboard';
      if(!keepOld&&this.get("SELECT id FROM jobs WHERE card_id=? AND status IN ('queued','running')",cardId))throw new Error('Cancel this card’s active jobs before removing it.');
      const benched=this.all("SELECT * FROM cards WHERE deck_id=? AND section='sideboard' AND entry_kind='card' AND id!=? ORDER BY active_version_id IS NULL,created_at",old.deck_id,cardId).find(c=>cardKey(c.name)===cardKey(name));
      let newId;
      if(benched){this.run('UPDATE cards SET section=?,quantity=? WHERE id=?',old.section,old.quantity,benched.id);newId=benched.id;}
      else newId=this.addCard(old.deck_id,{name,quantity:old.quantity,section:old.section});
      if(keepOld)this.run("UPDATE cards SET section='sideboard' WHERE id=?",cardId);else this.deleteCard(cardId);
      this.touch(old.deck_id);
      return {id:newId,name:benched?.name||name,reused:Boolean(benched),has_art:Boolean(benched?.active_version_id||this.get('SELECT active_version_id FROM cards WHERE id=?',newId).active_version_id),old:{id:keepOld?cardId:null,name:old.name,kept:keepOld}};
    });
  }
  clearAutomaticArtwork(deckId){
    if(!this.deck(deckId))throw new Error('Deck not found.');let cleared=0;
    this.transaction(()=>{for(const card of this.all(`SELECT c.id,c.customization,v.customization_json,v.id AS version_id FROM cards c JOIN versions v ON v.id=c.active_version_id WHERE c.deck_id=? AND v.job_id IS NULL AND v.note LIKE 'Reused from %' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.card_id=c.id AND j.status IN ('queued','running'))`,deckId)){
      this.run("UPDATE cards SET active_version_id=NULL,approval='unreviewed',customization=? WHERE id=?",card.customization===card.customization_json?'{}':card.customization,card.id);cleared++;
    }if(cleared)this.touch(deckId);});return {cleared};
  }
  createVariants(deckId,data){
    const request=variantRequest(data),group=id(),ids=[];
    if(this.deck(deckId)?.archived)throw new Error('Restore this deck before adding variants.');
    return this.transaction(()=>{
      const baseline=request.replace_existing?this.get("SELECT * FROM cards WHERE deck_id=? AND name=? COLLATE NOCASE AND section=? AND variant_group=''",deckId,request.name,request.section):null;
      if(baseline&&request.total!==baseline.quantity)throw new Error(`Splitting existing copies must preserve the current total (${baseline.quantity}). Change the total or turn off splitting.`);
      for(let i=0;i<request.variants;i++){
        let cardId;
        if(i===0&&baseline){cardId=baseline.id;this.run('UPDATE cards SET variant_group=?,variant_index=1,quantity=? WHERE id=?',group,request.quantities[i],cardId);}
        else cardId=this.addCard(deckId,{name:request.name,section:request.section,quantity:request.quantities[i],variant_group:group,variant_index:i+1,token_spec:request.spec});
        if(baseline&&cardId!==baseline.id){this.run('UPDATE cards SET metadata=?,notes=?,customization=?,roles=?,image_provider=? WHERE id=?',baseline.metadata,baseline.notes,baseline.customization,baseline.roles,baseline.image_provider,cardId);}
        ids.push(cardId);
      }
      this.touch(deckId);return {ids,group,variants:request.variants,total_copies:request.total,preserved_existing:Boolean(baseline),name:request.name};
    });
  }
  bumpBorder(){this.run("INSERT INTO settings(key,value) VALUES('border_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)");}
  touch(deckId) { this.run('UPDATE decks SET updated_at=? WHERE id=?', now(), deckId); }
  updateDeck(deckId, data) {
    const old = this.deck(deckId); if (!old) throw new Error('Deck not found.');
    const border=data.border_settings===undefined?null:borderSettings(data.border_settings);
    const provider=imageProvider(data.image_provider??old.image_provider??'codex');
    const name = cleanText(data.name ?? old.name, 120); if (!name) throw new Error('Give this deck a name.');
    this.run('UPDATE decks SET name=?,description=?,folder=?,style=?,archived=?,updated_at=? WHERE id=?', name,
      cleanText(data.description ?? old.description), cleanText(data.folder ?? old.folder, 80), cleanText(data.style ?? old.style, 50000), data.archived == null ? old.archived : Number(Boolean(data.archived)), now(), deckId);
    if(data.frame_set_id!==undefined)this.run('UPDATE decks SET frame_set_id=? WHERE id=?',cleanText(data.frame_set_id,120),deckId);
    this.run('UPDATE decks SET image_provider=? WHERE id=?',provider,deckId);
    if(border){this.run('UPDATE decks SET border_settings=? WHERE id=?',json(border),deckId);this.bumpBorder();}
    return this.deck(deckId);
  }
  updateCard(cardId, data) {
    const card = this.get('SELECT * FROM cards WHERE id=?', cardId); if (!card) throw new Error('Card not found.');
    const border=data.border_settings===undefined?null:borderSettings(data.border_settings,{inherit:true});
    const quantity = Number(data.quantity ?? card.quantity), section = data.section ?? card.section, approval = data.approval ?? card.approval;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || !['main','commander','sideboard','tokens'].includes(section) || (card.entry_kind==='token'?section!=='tokens':section==='tokens') || !['unreviewed','approved','changes_requested'].includes(approval)) throw new Error('Invalid card update.');
    const customization=data.customization==null?JSON.parse(card.customization):validateCustomization(data.customization);
    const roles=data.roles??JSON.parse(card.roles);
    if(!Array.isArray(roles)||roles.length>20||roles.some(r=>typeof r!=='string'||r.length>40||!r.trim()||/[\x00-\x1f]/.test(r)))throw new Error('Use up to 20 role tags, with at most 40 characters each.');
    this.run('UPDATE cards SET quantity=?,section=?,notes=?,approval=? WHERE id=?', quantity, section, cleanText(data.notes ?? card.notes, 10000), approval, cardId); this.touch(card.deck_id);
    this.run('UPDATE cards SET customization=? WHERE id=?',json(customization),cardId);
    this.run('UPDATE cards SET roles=? WHERE id=?',json([...new Set(roles.map(r=>r.trim().toLowerCase()))]),cardId);
    if(border){this.run('UPDATE cards SET border_settings=? WHERE id=?',json(border),cardId);this.bumpBorder();}
    if(data.image_provider!==undefined)this.run('UPDATE cards SET image_provider=? WHERE id=?',data.image_provider?imageProvider(data.image_provider):'',cardId);
  }
  removeCard(cardId) {
    const card = this.get('SELECT * FROM cards WHERE id=?', cardId); if (!card) throw new Error('Card not found.');
    if (this.get("SELECT id FROM jobs WHERE card_id=? AND status IN ('queued','running')", cardId)) throw new Error('Cancel this card’s active jobs before removing it.');
    this.transaction(() => this.deleteCard(cardId)); this.touch(card.deck_id);
  }
  deleteCard(cardId) { this.run('DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE card_id=?)', cardId); this.run('DELETE FROM jobs WHERE card_id=?', cardId); this.run('DELETE FROM cards WHERE id=?', cardId); }
  versions(cardId) { const card=this.get('SELECT deck_id FROM cards WHERE id=?',cardId);if(!card)return [];const setId=this.artSets.ensure(card.deck_id);return this.all('SELECT v.* FROM versions v JOIN deck_art_versions a ON a.version_id=v.id WHERE v.card_id=? AND a.set_id=? ORDER BY v.number DESC',cardId,setId).map(v => ({ ...v, summary: JSON.parse(v.summary),faces:JSON.parse(v.faces_json||'[]'),scene:JSON.parse(v.scene_json||'{}') })); }
  scenePlan(cardId){
    const card=this.get('SELECT * FROM cards WHERE id=?',cardId),existing=JSON.parse(card.scene_plan);
    if(existing.shot_distance)return existing;
    const used=this.all('SELECT scene_plan FROM cards WHERE deck_id=?',card.deck_id).map(c=>JSON.parse(c.scene_plan));
    const plan=chooseScenePlan(card.deck_id+' '+card.name,used);this.run('UPDATE cards SET scene_plan=? WHERE id=?',json(plan),cardId);return plan;
  }
  activate(cardId, versionId) {
    const version=this.get('SELECT id,customization_json,source_type,summary FROM versions WHERE id=? AND card_id=?', versionId, cardId);
    if (!version) throw new Error('Version not found for this card.');
    const owner=this.get('SELECT deck_id FROM cards WHERE id=?',cardId),setId=this.artSets.ensure(owner.deck_id);
    if(!this.get('SELECT version_id FROM deck_art_versions WHERE set_id=? AND version_id=?',setId,versionId)){if(this.get('SELECT version_id FROM deck_art_versions WHERE version_id=? LIMIT 1',versionId))throw Error('This version belongs to another artwork set. Switch sets before selecting it.');this.run('INSERT INTO deck_art_versions VALUES(?,?)',setId,versionId);}
    this.run("UPDATE cards SET active_version_id=?,approval='unreviewed',customization=?,art_mode=? WHERE id=?", versionId,version.customization_json,version.source_type,cardId);
    const summary=JSON.parse(version.summary),printing=version.source_type==='official'&&summary.set&&summary.collector_number?{set:summary.set,collector_number:summary.collector_number}:{};
    this.run("UPDATE cards SET printing_json=?,printing_error='' WHERE id=?",json(printing),cardId);
    this.touch(this.get('SELECT deck_id FROM cards WHERE id=?', cardId).deck_id);
  }
  // Recompositions and reused artwork inherit the provider of the version whose art they reuse.
  jobArtProvider(jobId){
    const job=this.get('SELECT type,generation_provider,directory FROM jobs WHERE id=?',jobId);if(!job)return '';
    let request={};try{request=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json'),'utf8'));}catch{}
    const inherit=versionId=>versionId?this.get('SELECT art_provider FROM versions WHERE id=?',versionId)?.art_provider||'':'';
    if(request.reuse_source?.version_id)return inherit(request.reuse_source.version_id);
    if(job.type==='compose')return inherit(request.previous_version?.id);
    return request.image_generation?.provider||(job.generation_provider==='local'?'':job.generation_provider)||'codex';
  }
  addVersion(cardId, data, {artSetId=null,activate=true}={}) {
    const owner=this.get('SELECT deck_id FROM cards WHERE id=?',cardId),targetSet=artSetId||this.artSets.ensure(owner.deck_id);
    if(!this.get('SELECT id FROM deck_art_sets WHERE id=? AND deck_id=?',targetSet,owner.deck_id))throw Error('Artwork set does not belong to this card.');
    if(activate&&targetSet!==this.artSets.ensure(owner.deck_id))throw Error('Switch artwork sets before activating this version.');
    const versionId = data.id || id(), number = this.get('SELECT COALESCE(MAX(number),0)+1 AS n FROM versions WHERE card_id=?', cardId).n;
    const controls=data.customization_json||this.get('SELECT customization FROM cards WHERE id=?',cardId).customization;
    this.run('INSERT INTO versions(id,card_id,job_id,number,image_path,frame_path,manifest_path,report_path,summary,note,created_at,style_text,scene_json,customization_json,faces_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      versionId, cardId, data.job_id || null, number, data.image_path, data.frame_path || null, data.manifest_path || null, data.report_path || null, json(data.summary || {}), data.note || '', now(),data.style_text || '',data.scene_json||json(data.scene||{}),controls,data.faces_json||json(data.faces||[]));
    this.run('UPDATE versions SET art_provider=?,source_type=? WHERE id=?',data.art_provider??(data.job_id?this.jobArtProvider(data.job_id):''),data.source_type||'custom',versionId);
    this.run('INSERT OR IGNORE INTO deck_art_versions VALUES(?,?)',targetSet,versionId);
    if(activate)this.activate(cardId, versionId); return versionId;
  }
  duplicate(deckId) {
    const original = this.deck(deckId); if (!original) throw new Error('Deck not found.');
    const copy = this.createDeck({ ...original, name: `${original.name.slice(0,113)} (copy)` });
    for (const card of original.cards) {
      const cardId = this.addCard(copy.id,card,{separate:true});
      this.updateCard(cardId,{notes:card.notes,customization:card.customization,roles:card.roles,image_provider:card.image_provider,border_settings:JSON.parse(card.border_settings||'{}')});
      this.run('UPDATE cards SET metadata=? WHERE id=?',json(card.metadata),cardId);
      if (card.active_version_id) {
        const version = this.get('SELECT * FROM versions WHERE id=?', card.active_version_id);
        this.addVersion(cardId, { ...version, id: id(), job_id: null, summary: JSON.parse(version.summary), note: 'Copied from '+original.name });
      }
    }
    return this.deck(copy.id);
  }
  events(jobId, after = 0) { return this.all('SELECT * FROM events WHERE job_id=? AND id>? ORDER BY id LIMIT 1000', jobId, after); }
  event(jobId, kind, message) { this.run('INSERT INTO events(job_id,kind,message,created_at) VALUES(?,?,?,?)', jobId, kind, String(message).slice(0, 16000), now()); }
  jobs(deckId) { return this.all(`SELECT j.*,a.name AS art_set_name,c.name AS card_name,c.variant_index,CASE WHEN j.status='queued' AND ${batchWaitingSql('j')} THEN 1 ELSE 0 END AS waiting_for_commander FROM jobs j JOIN cards c ON c.id=j.card_id LEFT JOIN deck_art_sets a ON a.id=j.art_set_id ${deckId ? 'WHERE j.deck_id=?' : ''} ORDER BY j.created_at DESC,j.rowid DESC LIMIT 300`, ...(deckId ? [deckId] : [])); }
  seed(root) {
    const manifestPath = path.join(root, 'decks/commander-style-test-complete.json');
    const sampleStyle = fs.readFileSync(path.join(root,'card-style.txt'),'utf8');
    this.run("UPDATE versions SET style_text=? WHERE style_text='' AND manifest_path=? AND note='Original style study'",sampleStyle,manifestPath);
    const sceneFile=path.join(root,'data/sample-scenes.json');
    if(fs.existsSync(sceneFile)){
      const scenes=JSON.parse(fs.readFileSync(sceneFile,'utf8'));
      for(const version of this.all("SELECT id,summary FROM versions WHERE scene_json='{}' AND manifest_path=?",manifestPath)){
        const scene=scenes[JSON.parse(version.summary).id];if(scene)this.run('UPDATE versions SET scene_json=? WHERE id=?',json(scene),version.id);
      }
    }
    if (this.get("SELECT value FROM settings WHERE key='examples_imported'")) {
      if(!this.get("SELECT value FROM settings WHERE key='sample_style_snapshotted'"))this.transaction(()=>{
        // Preserve the existing sample's theme when moving new decks to neutral defaults.
        this.run(`UPDATE decks SET style=? WHERE style='' AND folder='Sample decks' AND name='Friends of the Forest'
          AND EXISTS(SELECT 1 FROM cards c JOIN versions v ON v.card_id=c.id WHERE c.deck_id=decks.id AND v.manifest_path=? AND v.note='Original style study')`,sampleStyle,manifestPath);
        this.run("INSERT INTO settings(key,value) VALUES('sample_style_snapshotted','true')");
      });
      return;
    }
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const deck = this.createDeck({ name: 'Friends of the Forest', folder: 'Sample decks', style:sampleStyle, description: 'The original eight-card style study. A warm woodland world, one faithful companion at a time.' });
    for (const card of manifest.cards) {
      const image = path.join(root, 'output/commander-style-test', card.id+'.png'); if (!fs.existsSync(image)) continue;
      const cardId = this.addCard(deck.id, { name: card.name, quantity: 1, section: card.name.startsWith('Rin and Seri,') ? 'commander' : 'main' });
      const scenes=fs.existsSync(sceneFile)?JSON.parse(fs.readFileSync(sceneFile,'utf8')):{};
      this.addVersion(cardId, { image_path: image, frame_path: image.replace('.png','.frame.png'), report_path: image.replace('.png','.report.json'), manifest_path: manifestPath, summary: card, style_text:sampleStyle, scene:scenes[card.id], note: 'Original style study' });
    }
    this.run("INSERT INTO settings(key,value) VALUES('examples_imported','true')");
    this.run("INSERT INTO settings(key,value) VALUES('sample_style_snapshotted','true')");
  }
  close() { this.db.close(); }
}
