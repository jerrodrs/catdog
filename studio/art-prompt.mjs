// Keep user-owned style text byte-for-byte separate from agent-owned scene prose.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
export const STYLE_BEGIN='--- BEGIN DECK STYLE GUIDELINES (VERBATIM) ---\n';
export const STYLE_END='\n--- END DECK STYLE GUIDELINES ---';
export function assembleArtPrompt(style,scene){if(typeof style!=='string'||typeof scene!=='string')throw Error('Style and scene must be text.');return STYLE_BEGIN+style+STYLE_END+'\n\n--- CARD SCENE AND COMPOSITION ---\n'+scene;}
export function hasVerbatimStyle(prompt,style){return typeof prompt==='string'&&prompt.includes(STYLE_BEGIN+style+STYLE_END);}
function within(root,file){const r=path.relative(fs.realpathSync(root),fs.realpathSync(file));return r===''||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);}
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function writeArtPrompt(requestPath,scenePath,outputPath){
 const request=JSON.parse(fs.readFileSync(requestPath)),root=fs.realpathSync(request.output_directory);scenePath=path.resolve(root,scenePath);outputPath=path.resolve(root,outputPath);
 if(!within(root,requestPath)||!within(root,scenePath)||!within(root,path.dirname(outputPath)))throw Error('Save request, scene and prompt inside this job.');
 const text=assembleArtPrompt(fs.readFileSync(request.style_file,'utf8'),fs.readFileSync(scenePath,'utf8'));
 if(fs.existsSync(outputPath)&&fs.readFileSync(outputPath,'utf8')!==text)throw Error('Choose a new prompt filename; an earlier prompt already exists.');
 fs.writeFileSync(outputPath,text);return {prompt_path:outputPath,style_sha256:digest(request.style_file)};
}
export function auditArtPrompts(request,card,manifestPath){
 if(request.type==='compose'||request.art_prompt_contract?.mode!=='verbatim-style-v1')return null;
 const root=fs.realpathSync(request.output_directory),style=fs.readFileSync(request.style_file,'utf8'),faces=card.faces||[card],previous=request.previous_version,old=previous?.summary?.faces||[previous?.summary];
 const checks=faces.map((face,i)=>{
  const art=face.art?path.resolve(path.dirname(manifestPath),face.art):null,prior=old[i]?.art&&previous?path.resolve(path.dirname(previous.manifest_path),old[i].art):null;
  if(request.type==='revise'&&art&&prior&&fs.existsSync(art)&&fs.existsSync(prior)&&digest(art)===digest(prior))return {face:face.name,reused_art:true};
  if(typeof face.art_prompt!=='string')throw Error('Save art_prompt for every newly illustrated face using studio/art-prompt.mjs; style guidelines must remain verbatim.');
  const promptFile=path.resolve(path.dirname(manifestPath),face.art_prompt);
  if(!within(root,promptFile)||!hasVerbatimStyle(fs.readFileSync(promptFile,'utf8'),style))throw Error('Image prompt changed or omitted the verbatim style-guidelines block. Rebuild it with studio/art-prompt.mjs; keep scene prose separate.');
  return {face:face.name,prompt_path:promptFile,prompt_sha256:digest(promptFile),verbatim_style:true};
 });
 const eventFile=path.join(root,'events.jsonl');let verifiedToolCalls=0;
 if(fs.existsSync(eventFile)){
  const calls=new Map();
  for(const line of fs.readFileSync(eventFile,'utf8').split('\n')){let e;try{e=JSON.parse(line);}catch{continue;}
   if(e.type==='tool_call'&&['image_gen','image_edit'].includes(e.toolName))calls.set(e.toolCallId,e.rawInput?.prompt);
   if(e.type==='tool_call_update'&&e.status==='completed'&&['ImageGen','ImageEdit'].includes(e.rawOutput?.type)&&calls.has(e.toolCallId)){
    if(!hasVerbatimStyle(calls.get(e.toolCallId),style))throw Error('Grok image-tool input omitted or reworded the verbatim guidelines. The card was not accepted.');verifiedToolCalls++;
   }
  }
 }
 const report={mode:'verbatim-style-v1',style_file:request.style_file,style_sha256:digest(request.style_file),faces:checks,verified_tool_calls:verifiedToolCalls,tool_trace_available:verifiedToolCalls>0};
 fs.writeFileSync(path.join(root,'style-prompt-audit.json'),JSON.stringify(report,null,2));return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{if(process.argv.length!==5)throw Error('Usage: node studio/art-prompt.mjs REQUEST_JSON SCENE_TEXT OUTPUT_PROMPT_TEXT');console.log(JSON.stringify(writeArtPrompt(process.argv[2],process.argv[3],process.argv[4])));}catch(e){console.error(e.message);process.exitCode=1;}}
