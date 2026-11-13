import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {assembleArtPrompt,hasVerbatimStyle,writeArtPrompt,auditArtPrompts} from '../art-prompt.mjs';
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'card-studio-verbatim-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const style='  Watercolour & ink.\r\nKeep paper texture—no 3D.\n',styleFile=path.join(dir,'style.txt');fs.writeFileSync(styleFile,style);const request={type:'generate',output_directory:dir,style_file:styleFile,art_prompt_contract:{mode:'verbatim-style-v1'}},requestPath=path.join(dir,'request.json'),scene=path.join(dir,'scene.txt'),prompt=path.join(dir,'prompt.txt'),manifest=path.join(dir,'manifest.json');fs.writeFileSync(requestPath,JSON.stringify(request));fs.writeFileSync(scene,'A brass ring floats above a mossy table.');writeArtPrompt(requestPath,scene,prompt);fs.writeFileSync(manifest,'{}');return {dir,style,request,requestPath,scene,prompt,manifest};}
test('prompt assembly preserves every style character and keeps scene guidance separate',t=>{
 const f=setup(t),text=fs.readFileSync(f.prompt,'utf8');assert.ok(hasVerbatimStyle(text,f.style));assert.ok(text.includes(f.style));assert.ok(text.includes('--- CARD SCENE AND COMPOSITION ---\nA brass ring'));assert.equal(text,assembleArtPrompt(f.style,fs.readFileSync(f.scene,'utf8')));
 const audit=auditArtPrompts(f.request,{name:'Test',art_prompt:'prompt.txt'},f.manifest);assert.equal(audit.faces[0].verbatim_style,true);assert.equal(audit.tool_trace_available,false);assert.ok(fs.existsSync(path.join(f.dir,'style-prompt-audit.json')));
});
test('acceptance rejects paraphrased style, missing prompts, and missing prompts on a second face',t=>{
 const f=setup(t);fs.writeFileSync(f.prompt,'Watercolor painting of a ring.');assert.throws(()=>auditArtPrompts(f.request,{name:'Test',art_prompt:'prompt.txt'},f.manifest),/changed or omitted/);
 assert.throws(()=>auditArtPrompts(f.request,{name:'Test'},f.manifest),/every newly illustrated face/);
 fs.writeFileSync(f.prompt,assembleArtPrompt(f.style,'A new scene.'));assert.throws(()=>auditArtPrompts(f.request,{faces:[{name:'Front',art_prompt:'prompt.txt'},{name:'Back'}]},f.manifest),/every newly illustrated face/);
});
test('native Grok image input must contain the same verbatim block as the saved prompt',t=>{
 const f=setup(t),file=path.join(f.dir,'events.jsonl'),events=prompt=>[{type:'tool_call',toolName:'image_gen',toolCallId:'one',rawInput:{prompt}},{type:'tool_call_update',toolCallId:'one',status:'completed',rawOutput:{type:'ImageGen',path:'/test.jpg'}}].map(e=>JSON.stringify(e)).join('\n');
 fs.writeFileSync(file,events('Paraphrased and shortened style.'));assert.throws(()=>auditArtPrompts(f.request,{name:'Test',art_prompt:'prompt.txt'},f.manifest),/image-tool input/);
 fs.writeFileSync(file,events(fs.readFileSync(f.prompt,'utf8')));assert.equal(auditArtPrompts(f.request,{name:'Test',art_prompt:'prompt.txt'},f.manifest).verified_tool_calls,1);
});
test('unchanged artwork in a targeted revision does not require a new image prompt',t=>{
 const f=setup(t),previousDir=path.join(f.dir,'previous');fs.mkdirSync(previousDir);fs.writeFileSync(path.join(previousDir,'art.png'),'same art');fs.writeFileSync(path.join(f.dir,'copied.png'),'same art');f.request.type='revise';f.request.previous_version={manifest_path:path.join(previousDir,'manifest.json'),summary:{art:'art.png'}};
 const audit=auditArtPrompts(f.request,{name:'Test',art:'copied.png'},f.manifest);assert.equal(audit.faces[0].reused_art,true);
});
