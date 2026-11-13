import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeDeck,manaValue,cardData,cardRoles} from '../public/analysis.js';
import {planPrint} from '../printing.mjs';
const card=(name,quantity,data,section='main',roles=[])=>({id:name,name,quantity,metadata:data,section,roles});

test('analysis counts quantities, overlapping types, main/sideboard, pips, sources and roles',()=>{
  const result=analyzeDeck([
    card('Commander',1,{type_line:'Legendary Creature — Elf',mana_cost:'{1}{G}',cmc:2,color_identity:['G']},'commander'),
    card('Forest',35,{name:'Forest',type_line:'Basic Land — Forest',produced_mana:['G'],color_identity:['G']}),
    card('Mana creature',2,{type_line:'Artifact Creature — Golem',mana_cost:'{2}',cmc:2,oracle_text:'{T}: Add {G}.',color_identity:[]}),
    card('Blue spell',1,{type_line:'Instant',cmc:1,mana_cost:'{U}',oracle_text:'Draw two cards.',color_identity:['U']}),
    card('Side spell',9,{type_line:'Sorcery',cmc:7,mana_cost:'{7}'},'sideboard'),
    card('Unknown',1,{})
  ]);
  assert.equal(result.total,40);assert.equal(result.sideboard,9);assert.equal(result.types.Creature,3);assert.equal(result.types.Artifact,2);assert.equal(result.types.Land,35);assert.equal(result.curve[2],3);assert.equal(result.average,1.75);assert.equal(result.sources.G,35);assert.equal(result.colors.U,1);assert.equal(result.roles.ramp,2);assert.equal(result.roles.draw,1);assert.equal(result.unknown,1);
  assert.ok(result.checks.some(c=>c.message.includes('outside')));assert.ok(result.checks.some(c=>c.message.includes('2 copies')));
});
test('mana fallback, front faces and explicit role tags remain accurate',()=>{
  assert.equal(manaValue({mana_cost:'{X}{2/W}{G/P}{C}'}),4);
  assert.equal(manaValue({}),null);
  assert.equal(cardData({metadata:{cmc:3,type_line:'Sorcery // Land',card_faces:[{type_line:'Sorcery',mana_cost:'{1}{G}{G}'}]}}).type_line,'Sorcery');
  assert.deepEqual(cardRoles(card('Tagged',1,{oracle_text:'Draw two cards.'},'main',['win condition'])),['win condition']);
});
test('print plans use exact physical dimensions and reject impossible or excessive jobs',()=>{
  const standard=planPrint({},100);assert.equal(standard.per_page,9);assert.equal(standard.pages,12);assert.equal(standard.card_width,63.5);assert.equal(standard.card_height,88.9);
  assert.equal(planPrint({paper:'Letter',margin:4},9).per_page,9);
  assert.equal(planPrint({bleed:3},9).per_page,4);
  assert.throws(()=>planPrint({margin:100},10),/No cards fit/);
  assert.throws(()=>planPrint({gap:0},1),/crop marks/);
  assert.throws(()=>planPrint({},1001),/1,000/);
  assert.throws(()=>planPrint({card_width:'oops'},1));
});
