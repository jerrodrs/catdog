import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chooseScenePlan,validateScene,compareScenes,sceneSimilarity} from '../public/scenes.js';

test('composition plans balance scene distance, viewpoint and placement before repeating',()=>{
  const used=[];for(let n=0;n<12;n++)used.push(chooseScenePlan('card-'+n,used));
  assert.equal(new Set(used.map(p=>p.plan_id)).size,12);assert.ok(new Set(used.map(p=>p.viewpoint)).size>=6);assert.ok(new Set(used.map(p=>p.shot_distance)).size>=5);
  assert.deepEqual(chooseScenePlan('same name'),chooseScenePlan('same name'));
});
test('the three reviewed sample compositions are flagged using factual descriptors',()=>{
  const samples=JSON.parse(fs.readFileSync(new URL('../../data/sample-scenes.json',import.meta.url),'utf8'));
  for(const scene of Object.values(samples))validateScene(scene);
  const willow=samples['006-jaheira'],sunbeam=samples['007-sol-ring'],clasp=samples['008-skullclamp'];
  assert.ok(sceneSimilarity(willow,sunbeam)>=.68);assert.ok(sceneSimilarity(willow,clasp)>=.68);
  const matches=compareScenes(sunbeam,[{name:'Keepsake Clasp',scene:clasp}]);assert.equal(matches.length,1);assert.equal(matches[0].blocked,true);
  assert.equal(compareScenes(sunbeam,[{name:'Arahbo',scene:samples['005-arahbo']}]).length,0);
});
test('descriptors reject missing fields and normalise common pose synonyms for matching',()=>{
  assert.throws(()=>validateScene({}),/shot_distance/);
  const a={shot_distance:'close',viewpoint:'eye_level',subject_position:'left',pose:['extended paw'],action:['observing'],setting:['garden'],lighting:['day'],summary:'A cat studies an object.'};
  const b={...a,pose:['reaching']};assert.equal(sceneSimilarity(a,b),1);
});
