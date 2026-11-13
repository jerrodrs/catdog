import fs from 'node:fs';
import {validateScene,compareScenes} from './public/scenes.js';
import {batchSceneReferences} from './batch-consistency.mjs';
const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const scene=validateScene(JSON.parse(fs.readFileSync(process.argv[3],'utf8')));
const matches=compareScenes(scene,batchSceneReferences(request));
console.log(JSON.stringify({matches,blocked:matches.some(m=>m.blocked)},null,2));
if(matches.some(m=>m.blocked))process.exitCode=1;
