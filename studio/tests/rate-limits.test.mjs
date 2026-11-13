import test from 'node:test';
import assert from 'node:assert/strict';
import {rateLimitWait} from '../rate-limits.mjs';
import {variantRequest,tokenSpec} from '../variants.mjs';
test('rate recovery recognises explicit delays, reset dates and bounded backoff',()=>{
  assert.equal(rateLimitWait('Invalid card name'),null);
  assert.ok(rateLimitWait('Selected model is at capacity. Please try a different model.'));assert.ok(rateLimitWait('HTTP 503 Service Unavailable'));
  assert.equal(rateLimitWait('HTTP 429; retry-after: 12 seconds',1,0,10).delay,13000);
  assert.equal(rateLimitWait('Rate limit exceeded',3,0,100).delay,400);
  assert.equal(rateLimitWait('rate_limit_exceeded',100).delay,1800000);
  assert.equal(rateLimitWait('Usage limit. Try again at 2026-11-01T12:00:00Z',1,Date.parse('2026-11-01T11:00:00Z')).delay,3602000);
});
test('variant allocation preserves total copies and token characteristics',()=>{
  const land=variantRequest({kind:'land',name:'forest',variants:3,total_copies:8});assert.deepEqual(land.quantities,[3,3,2]);assert.equal(land.name,'Forest');
  const cat=tokenSpec({name:'Cat',type_line:'Token Creature — Cat',power:'1',toughness:'1',colors:['G']});assert.equal(cat.layout,'token');assert.equal(cat.mana_cost,'');assert.deepEqual(cat.colors,['G']);
  assert.throws(()=>variantRequest({kind:'land',name:'Forest',variants:5,total_copies:4}));
  assert.throws(()=>variantRequest({kind:'land',name:'Command Tower'}));
  assert.throws(()=>tokenSpec({name:'Cat',type_line:'Creature — Cat'}));
});
