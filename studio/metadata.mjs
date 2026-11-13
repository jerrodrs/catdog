import {now} from './store.mjs';
import {frontCardName,fullCardNameKey,matchesCardName} from './card-names.mjs';
const key=fullCardNameKey;
export class MetadataLookup{
  constructor(store,{fetcher=fetch,notify=()=>{}}={}){this.store=store;this.fetcher=fetcher;this.notify=notify;this.active=new Set();this.chain=Promise.resolve();}
  resolve(deckId,force=false){
    if(this.active.has(deckId))throw new Error('Card data lookup is already running for this deck.');
    this.active.add(deckId);
    const promise=this.chain.then(()=>this.load(deckId,force));this.chain=promise.catch(()=>{});
    return promise.finally(()=>this.active.delete(deckId));
  }
  async load(deckId,force){
    const deck=this.store.deck(deckId);if(!deck)throw new Error('Deck not found.');
    const result={resolved:0,missing:[]};const pending=[];
    for(const card of deck.cards){
      if(card.entry_kind==='token')continue;
      if(!force&&card.metadata?.id)continue;
      const cached=this.store.get('SELECT data FROM card_cache WHERE name=?',key(card.name));
      if(cached&&!force){this.save(card,JSON.parse(cached.data));result.resolved++;}else pending.push(card);
    }
    for(let offset=0;offset<pending.length;offset+=75){
      const batch=pending.slice(offset,offset+75);
      const response=await this.fetcher('https://api.scryfall.com/cards/collection',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','User-Agent':'CardStudio/1.0 (local personal deck builder)'},body:JSON.stringify({identifiers:batch.map(c=>({name:frontCardName(c.name)}))}),signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error(`Card data lookup returned HTTP ${response.status}. Try again later.`);
      const payload=await response.json();if(!Array.isArray(payload.data))throw new Error('Card data service returned an invalid response.');
      for(const card of batch){let data=payload.data.find(d=>matchesCardName(d,card.name));
        if(!data&&card.name.includes('//')){const url=new URL('https://api.scryfall.com/cards/named');url.searchParams.set('exact',frontCardName(card.name));const found=await this.fetcher(url.toString(),{headers:{Accept:'application/json','User-Agent':'CardStudio/1.0 (local card metadata lookup)'},signal:AbortSignal.timeout(20000)});if(found.ok){const candidate=await found.json();if(candidate.name&&matchesCardName(candidate,card.name))data=candidate;}}
        if(data){this.save(card,data);result.resolved++;}else result.missing.push(card.name);
      }
      this.notify();if(offset+75<pending.length)await new Promise(r=>setTimeout(r,150));
    }
    this.store.touch(deckId);this.notify();return result;
  }
  save(card,data){
    this.store.run('UPDATE cards SET metadata=? WHERE id=?',JSON.stringify(data),card.id);
    for(const name of new Set([card.name,data.name,frontCardName(data.name),...(['transform','modal_dfc'].includes(data.layout)?(data.card_faces||[]).map(f=>f.name):[])]))this.store.run('INSERT INTO card_cache(name,data,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',key(name),JSON.stringify(data),now());
  }
}
