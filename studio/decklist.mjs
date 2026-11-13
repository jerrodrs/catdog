import {cardNameKey,normalizeCardName} from './card-names.mjs';
export function printingSpec(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length)return null;
  const set=String(value.set||'').toLowerCase(),collector_number=String(value.collector_number||'');
  if(!/^[a-z0-9]{2,8}$/.test(set)||! /^[\p{L}\p{N}★*†+_-]{1,32}$/u.test(collector_number))throw new Error('Use a set code and a valid collector number.');
  return {set,collector_number};
}
export function printingKey(card){const spec=card.printing??(card.printing_json?JSON.parse(card.printing_json):null);return spec?.set?spec.set.toLowerCase()+':'+String(spec.collector_number).toLowerCase():'';}
export function parseDecklist(text) {
  if (typeof text !== 'string' || text.length > 150000) throw new Error('Paste a decklist of at most 150,000 characters.');
  const cards = [], errors = [];
  let section = 'main';
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    let line = raw.trim();
    if (!line || /^(?:#|\/\/)/.test(line)) continue;
    const heading = line.replace(/[:\[\]]/g, '').toLowerCase();
    if (['commander', 'commanders', 'deck', 'mainboard', 'main', 'sideboard', 'maybeboard', 'considering','tokens'].includes(heading)) {
      section = heading==='tokens'?'tokens':heading.startsWith('commander') ? 'commander' : ['sideboard', 'maybeboard', 'considering'].includes(heading) ? 'sideboard' : 'main';
      continue;
    }
    let rowSection = section;
    if (/^SB:\s*/i.test(line)) { rowSection = 'sideboard'; line = line.replace(/^SB:\s*/i, ''); }
    const counted = line.match(/^(\d+)\s*[xX×]?\s+(.+)$/);
    const quantity = counted ? Number(counted[1]) : 1;
    let name=(counted?counted[2]:line).replace(/\s+#(?!\d)[^]*$/, '').replace(/\s+\*[FE]\*\s*$/i,'').trim();
    let printing;
    const annotated=name.match(/\s+(?:\(([A-Za-z0-9]{2,8})\)|\[([A-Za-z0-9]{2,8})\])(?:\s+#?([\p{L}\p{N}★*†+_-]+))?\s*$/u);
    const bare=!annotated&&name.match(/\s+([A-Za-z0-9]{2,8})\s+#?((?=[\p{L}\p{N}★*†+_-]*\d)[\p{L}\p{N}★*†+_-]+)\s*$/u);
    if(annotated){if(annotated[3])printing=printingSpec({set:annotated[1]||annotated[2],collector_number:annotated[3]});name=name.slice(0,annotated.index).trim();}
    else if(bare){printing=printingSpec({set:bare[1],collector_number:bare[2]});name=name.slice(0,bare.index).trim();}
    if (!name || name.length > 180 || /[\x00-\x1f]/.test(name) || quantity < 1 || quantity > 999) {
      errors.push({ line: index + 1, message: 'Use a card name, optionally preceded by a quantity from 1 to 999.' }); continue;
    }
    name=normalizeCardName(name);
    const existing = cards.find(c => cardNameKey(c.name) === cardNameKey(name) && c.section === rowSection && printingKey(c)===printingKey({printing}));
    if (existing) existing.quantity += quantity;
    else cards.push({ name, quantity, section: rowSection,...(printing?{printing}:{}) });
  }
  if (cards.length > 500 || cards.some(c => c.quantity > 999)) errors.push({ line: 0, message: 'Use at most 500 unique entries and 999 copies per card.' });
  return { cards, errors };
}

export function exportDecklist(cards) {
  return ['commander', 'main', 'sideboard','tokens'].flatMap(section => {
    const rows = cards.filter(c => c.section === section);
    return rows.length ? [section === 'main' ? 'Deck' : section === 'commander' ? 'Commander' : section==='tokens'?'Tokens':'Sideboard', ...rows.map(c => `${c.quantity} ${c.name}${printingKey(c)?` (${(c.printing||JSON.parse(c.printing_json)).set.toUpperCase()}) ${(c.printing||JSON.parse(c.printing_json)).collector_number}`:''}`), ''] : [];
  }).join('\n');
}
