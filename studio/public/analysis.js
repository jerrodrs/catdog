export function cardData(card){const d=Object.keys(card.metadata||{}).length?card.metadata:card.summary||{};const front=d.card_faces?.[0]||d.faces?.[0];return front?{...d,type_line:front.type_line||d.type_line,mana_cost:front.mana_cost||d.mana_cost,oracle_text:front.oracle_text||d.oracle_text}:d;}
export function manaValue(data){
  if(Number.isFinite(data.cmc))return data.cmc;
  const cost=data.mana_cost||'';if(!cost)return /\bLand\b/.test(data.type_line||'')?0:null;
  return [...cost.matchAll(/\{([^}]+)\}/g)].reduce((n,[,s])=>n+(/^\d+$/.test(s)?Number(s):/^[XYZ]$/.test(s)?0:/^\d+\//.test(s)?Number(s.split('/')[0]):1),0);
}
export function cardRoles(card){
  if(card.roles?.length)return card.roles;
  const d=cardData(card),raw=Object.keys(card.metadata||{}).length?card.metadata:card.summary||{},extra=['adventure','prepare'].includes(raw.layout)?raw.spell?.oracle_text||(raw.card_faces||[]).slice(1).map(f=>f.oracle_text||'').join(' '):'',text=(d.oracle_text||'')+' '+extra,roles=[];
  if(/draw (?:a|an|one|two|three|\d+|X) cards?/i.test(text))roles.push('draw');
  if(!/Land/.test(d.type_line||'')&&(/add (?:\{[WUBRGC]\}|one mana|two mana|an amount)/i.test(text)||/search your library for .{0,55}land.{0,90}battlefield/is.test(text)))roles.push('ramp');
  if(/(?:destroy|exile) (?:up to \w+ )?target|counter target|each opponent sacrifices/i.test(text))roles.push('removal');
  if(/indestructible|hexproof|protection from/i.test(text))roles.push('protection');
  if(/(?:return|cast).{0,65}(?:from your graveyard|in your graveyard)/is.test(text))roles.push('recursion');
  return roles;
}
export function analyzeDeck(cards){
  const main=cards.filter(c=>c.section!=='sideboard'&&c.section!=='tokens'&&c.entry_kind!=='token'),types=Object.fromEntries(['Creature','Land','Artifact','Enchantment','Instant','Sorcery','Planeswalker','Battle'].map(t=>[t,0]));
  const curve=Array(8).fill(0),colors=Object.fromEntries(['W','U','B','R','G','C'].map(c=>[c,0])),sources={...colors},roles={ramp:0,draw:0,removal:0,protection:0,recursion:0};
  let known=0,unknown=0,total=0,spells=0,manaSum=0,manaKnown=0;
  const checks=[],commanders=main.filter(c=>c.section==='commander'),identity=new Set(commanders.flatMap(c=>cardData(c).color_identity||[]));
  const identityKnown=commanders.length>0&&commanders.every(c=>Array.isArray(cardData(c).color_identity));
  const names=new Map();
  for(const card of main){
    const d=cardData(card),q=card.quantity||1,t=d.type_line||'';total+=q;
    const name=(d.name||card.name).toLowerCase();names.set(name,{name:card.name,quantity:(names.get(name)?.quantity||0)+q,data:d});
    if(!t){unknown+=q;continue;}known+=q;
    for(const type of Object.keys(types))if(new RegExp('\\b'+type+'\\b').test(t))types[type]+=q;
    if(!/\bLand\b/.test(t)){spells+=q;const mv=manaValue(d);if(mv!==null){curve[Math.min(7,Math.floor(mv))]+=q;manaSum+=mv*q;manaKnown+=q;}}
    for(const [,symbol]of (d.mana_cost||'').matchAll(/\{([^}]+)\}/g))for(const color of new Set(symbol.match(/[WUBRGC]/g)||[]))colors[color]+=q;
    const produced=d.produced_mana||(/Basic Land/.test(t)?({'Plains':['W'],'Island':['U'],'Swamp':['B'],'Mountain':['R'],'Forest':['G']}[d.name||card.name]||[]):[]);
    if(/\bLand\b/.test(t))for(const color of new Set(produced))if(color in sources)sources[color]+=q;
    for(const role of cardRoles(card))if(role in roles)roles[role]+=q;
    if(identityKnown&&Array.isArray(d.color_identity)&&d.color_identity.some(c=>!identity.has(c)))checks.push({kind:'warning',card_id:card.id,message:card.name+' is outside the selected commander colour identity.'});
    if(d.legalities?.commander&&d.legalities.commander!=='legal')checks.push({kind:'warning',card_id:card.id,message:card.name+': Scryfall lists Commander status as '+d.legalities.commander+'.'});
  }
  if(total!==100)checks.unshift({kind:'info',message:`${total}/100 cards including commanders (${100-total>0?100-total+' to add':total-100+' over'}).`});
  if(!commanders.length)checks.push({kind:'info',message:'Choose a commander to compare colour identity.'});
  if(unknown)checks.push({kind:'info',message:`${unknown} cards need metadata; statistics and checks are incomplete.`});
  for(const entry of names.values())if(entry.quantity>1&&entry.data.type_line&&!/Basic/.test(entry.data.type_line)&&!/a deck can have (?:any number|up to)/i.test(entry.data.oracle_text||''))checks.push({kind:'warning',message:`${entry.name}: ${entry.quantity} copies; check the Commander singleton restriction.`});
  return {total,known,unknown,types,curve,colors,sources,roles,spells,average:manaKnown?manaSum/manaKnown:null,sideboard:cards.filter(c=>c.section==='sideboard').reduce((n,c)=>n+c.quantity,0),tokens:cards.filter(c=>c.section==='tokens').reduce((n,c)=>n+c.quantity,0),checks};
}
