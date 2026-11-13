import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDecklist,exportDecklist} from '../decklist.mjs';

test('plain, Arena, set-tag and sideboard formats preserve names and sections',()=>{
  const {cards,errors}=parseDecklist('Commander\n1 Rin and Seri, Inseparable\n\nDeck\n1 Sol Ring (CMM) 410\n1x Forest\n2 Forest #ramp\nSkullclamp [DST] 140 *F*\nSB: 2 Plains\nSideboard\nSelfless Savior\n# comment');
  assert.deepEqual(errors,[]);assert.equal(cards.length,6);
  assert.deepEqual(cards[0],{name:'Rin and Seri, Inseparable',quantity:1,section:'commander'});
  assert.equal(cards[2].quantity,3);assert.equal(cards[3].name,'Skullclamp');assert.equal(cards[4].section,'sideboard');
  assert.deepEqual(parseDecklist(exportDecklist(cards)).cards,cards);
});
test('invalid quantities and aggregate limits produce line errors',()=>{
  assert.equal(parseDecklist('0 Sol Ring').errors[0].line,1);
  assert.equal(parseDecklist('1000 Forest').errors.length,1);
  assert.equal(parseDecklist('999 Forest\n1 Forest').errors.length,1);
  assert.throws(()=>parseDecklist(null));
});
test('spaced quantity markers and printing details are optional',()=>{
  for(const [line,name] of [
    ['1 x Rin and Seri, Inseperable','Rin and Seri, Inseperable'],
    ['1 Rin and Seri, Inseperable','Rin and Seri, Inseperable'],
    ['1 x Rin and Seri, Inseparable (sld) 1508','Rin and Seri, Inseparable'],
    ['1x Rin and Seri, Inseparable [SLD] 1508 *F*','Rin and Seri, Inseparable'],
    ['2 × Forest','Forest'],['1 Xantcha, Sleeper Agent','Xantcha, Sleeper Agent']
  ]){const result=parseDecklist(line);assert.deepEqual(result.errors,[]);assert.equal(result.cards[0].name,name);}
});

test('double-faced names preserve printing selection separately from a plain custom entry',()=>{
 const result=parseDecklist('1 x Bala Ged Recovery//Bala Ged Sanctuary (ZNR) 180\n1 Bala Ged Recovery\n1 Bonecrusher Giant // Stomp\n1 Emeritus of Ideation // Ancestral Recall');assert.deepEqual(result.errors,[]);assert.equal(result.cards.length,4);assert.equal(result.cards[0].name,'Bala Ged Recovery // Bala Ged Sanctuary');assert.equal(result.cards[0].quantity,1);assert.deepEqual(result.cards[0].printing,{set:'znr',collector_number:'180'});assert.equal(parseDecklist('1 Bala Ged Recovery // Bala Ged Sanctuary\n1 Bala Ged Recovery').cards[0].quantity,2);
});


test('exact printing formats retain set and collector number, aggregate only matching printings and round-trip',()=>{
 for(const line of ['1 x Sol Ring CMM 410','1 Sol Ring (CMM) 410','1x Sol Ring [cmm] 410 *F*','Sol Ring (cmm) #410','1 Sol Ring cmm 410 # ramp']){const p=parseDecklist(line);assert.deepEqual(p.errors,[]);assert.deepEqual(p.cards[0],{name:'Sol Ring',quantity:1,section:'main',printing:{set:'cmm',collector_number:'410'}});}
 const parsed=parseDecklist('Commander\n1 Bala Ged Recovery // Bala Ged Sanctuary ZNR 180\nDeck\n2 Sol Ring CMM 410\n1 Sol Ring (cmm) 410\n1 Sol Ring CMM 703\n1 Sol Ring\n1 Forest (SLD) 123a\n1 Forest SLD A-123');assert.deepEqual(parsed.errors,[]);assert.equal(parsed.cards.length,6);assert.equal(parsed.cards[1].quantity,3);assert.equal(parsed.cards[2].printing.collector_number,'703');assert.equal(parsed.cards[3].printing,undefined);assert.equal(parsed.cards[5].printing.collector_number,'A-123');assert.deepEqual(parseDecklist(exportDecklist(parsed.cards)).cards,parsed.cards);
 assert.equal(parseDecklist('1 Sol Ring (CMM)').cards[0].printing,undefined);
});
