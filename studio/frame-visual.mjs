import {cleanText} from './store.mjs';
const layouts=['creature','artifact','enchantment','instant','sorcery','land','planeswalker','token','transform_front','transform_back','adventure','prepare','saga'];
const families=['W','U','B','R','G','C','M','WU','UB','BR','RG','GW','WB','UR','BG','RW','GU'];
export function previewContext(value={}){
 const layout=value.layout||'creature',family=value.family||'G';if(!layouts.includes(layout)||!families.includes(family))throw new Error('Invalid visual preview context.');
 return {layout,family,legendary:!!value.legendary,alias:!!value.alias};
}
export function visualEdits(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid visual edits.');
 const annotations=value.annotations??[];if(!Array.isArray(annotations)||annotations.length>30)throw new Error('Use at most 30 annotated regions.');
 return {schema_version:1,context:previewContext(value.context||{}),source_version_id:cleanText(value.source_version_id||'',120),annotations:annotations.map((a,i)=>{
  if(!Array.isArray(a.rect)||a.rect.length!==4||a.rect.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)||a.rect[2]<.003||a.rect[3]<.003||a.rect[0]+a.rect[2]>1.00001||a.rect[1]+a.rect[3]>1.00001)throw new Error('Annotation rectangle must lie within the card.');
  return {id:cleanText(a.id||String(i+1),80),rect:a.rect,note:cleanText(a.note||'',2000),...previewContext(a)};
 })};
}
