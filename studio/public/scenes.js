const plans=[
  ['wide','low_angle','right','leaping, climbing, moving away','dramatic outdoor landscape'],
  ['close','overhead','center','curled, resting, examining','intimate interior or tabletop'],
  ['medium','from_behind','left','walking away, listening, watching','threshold or winding path'],
  ['extreme_wide','high_angle','distributed','gathering, traversing, scattered','large environment with small subjects'],
  ['macro','oblique','center','hanging, nestled, suspended','object-led still life with tactile detail'],
  ['medium','ground_level','right','crouching, peering, hiding','foreground plants or architectural opening'],
  ['wide','eye_level','distributed','running, playing, circling','busy shared scene with multiple subjects'],
  ['close','low_angle','left','looking upward, carrying, balancing','bold silhouette and negative space'],
  ['wide','overhead','center','crossing, swimming, sheltering','strong environmental geometry'],
  ['medium','oblique','right','sleeping, sitting upright, guarding','quiet scene with layered depth'],
  ['close','from_behind','center','turning, discovering, observing','over-shoulder reveal'],
  ['wide','high_angle','left','descending, pursuing, exploring','diagonal journey through the setting']
];
export function chooseScenePlan(seed,used=[]){
  const counts=plans.map((_,i)=>used.filter(p=>p.plan_id===i).length),min=Math.min(...counts);
  const hash=[...seed].reduce((n,c)=>(n*31+c.codePointAt(0))>>>0,0),start=hash%plans.length;
  let index=start;while(counts[index]!==min)index=(index+1)%plans.length;
  const [shot_distance,viewpoint,subject_position,pose_options,setting_idea]=plans[index];
  return {plan_id:index,shot_distance,viewpoint,subject_position,pose_options,setting_idea,instruction:'Use this as a starting point, adapting creatively to the card. Vary scenes across the deck; preserve important subjects above rules panels. Do not force a creature into object-focused artwork.'};
}
const allowed={shot_distance:['macro','close','medium','wide','extreme_wide'],viewpoint:['eye_level','low_angle','high_angle','overhead','ground_level','from_behind','oblique'],subject_position:['left','center','right','distributed']};
export function validateScene(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Save a structured scene.json for this illustration.');
  const result={};
  for(const [key,options]of Object.entries(allowed)){if(!options.includes(value[key]))throw new Error(`scene.json: choose a valid ${key} (${options.join(', ')}).`);result[key]=value[key];}
  for(const key of ['pose','action','setting','lighting']){
    const tags=value[key];if(!Array.isArray(tags)||tags.length<1||tags.length>8||tags.some(t=>typeof t!=='string'||!t.trim()||t.length>70))throw new Error(`scene.json: ${key} needs 1–8 short keyword tags.`);
    result[key]=[...new Set(tags.map(t=>t.toLowerCase().trim()))];
  }
  if(typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>1000)throw new Error('scene.json needs a short factual summary.');result.summary=value.summary.trim();return result;
}
function normalized(tag){
  const t=tag.toLowerCase().replace(/[-_]/g,' ').replace(/\s+/g,' ').trim();
  if(/^(?:reach(?:ing)?|(?:outstretched|extended) paw|paw (?:extended|outstretched))$/.test(t))return 'reaching';
  return ({seated:'sitting',sits:'sitting',sitting:'sitting',standing:'standing',stands:'standing',running:'running',runs:'running',jumping:'leaping',jump:'leaping',asleep:'sleeping'})[t]||t;
}
const overlap=(a=[],b=[])=>{const x=new Set(a.map(normalized)),y=new Set(b.map(normalized));return x.size||y.size?[...x].filter(t=>y.has(t)).length/new Set([...x,...y]).size:0;};
export function sceneSimilarity(a,b){
  if(!a?.shot_distance||!b?.shot_distance)return 0;
  return Number(((a.subject_position===b.subject_position ? .16 : 0)+(a.viewpoint===b.viewpoint ? .15 : 0)+(a.shot_distance===b.shot_distance ? .15 : 0)+overlap(a.pose,b.pose)*.25+overlap(a.action,b.action)*.15+overlap(a.setting,b.setting)*.1+overlap(a.lighting,b.lighting)*.04).toFixed(3));
}
export function compareScenes(scene,references=[]){
  return references.map(ref=>({card_id:ref.card_id,name:ref.name,score:sceneSimilarity(scene,ref.scene),pose_overlap:overlap(scene.pose,ref.scene?.pose)})).filter(r=>r.score>=.68&&r.pose_overlap>0).sort((a,b)=>b.score-a.score).map(r=>({...r,blocked:r.score>=.78}));
}
