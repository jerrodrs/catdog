import test from 'node:test';import assert from 'node:assert/strict';
import {candidatePlan,briefFields} from '../frame-design.mjs';
test('candidate plan',()=>{
 assert.deepEqual(candidatePlan('classic',3).map(p=>p.target),['classic','classic','stylised']);
 assert.deepEqual(candidatePlan('showcase',3).map(p=>p.target),['stylised','showcase','showcase']);
 assert.deepEqual(candidatePlan('agent',3).map(p=>p.target),[null,null,null]);
 assert.deepEqual(candidatePlan('stylised',1),[{direction:'prompt',label:'Your brief',target:'stylised'}]);
 assert.deepEqual(briefFields({motif:' x ',bogus:'y'}),{motif:'x'});
});
test('each option takes a different construction route and the designer is told about its tools and siblings',async()=>{
 const {candidateRequest,designerPrompt}=await import('../frame-design.mjs');
 const routes=candidatePlan('stylised',3).map(p=>candidateRequest(p).instructions.match(/Construction route: (.*)$/)?.[1]);
 assert.equal(new Set(routes).size,3);assert.ok(routes.every(Boolean));
 const prompt=designerPrompt('/tmp/x',['creature']);
 for(const phrase of ['The illustration is the hero','shape_profile','panel_bottom','nine-slice','rail_texture','frame_tools.py','request.siblings','never float over the illustration'])assert.ok(prompt.includes(phrase),phrase);
 assert.ok(!/No symbols, icons, emblems or pictorial motifs anywhere/.test(prompt));
});
