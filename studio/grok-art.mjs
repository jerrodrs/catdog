// Subscription CLI only. No direct inference endpoints, API keys or provider fallback.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {grokBinary} from './image-providers.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function contained(root,file){const relative=path.relative(fs.realpathSync(root),fs.realpathSync(file));return !relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
export function generatedImage(events){
 const calls=new Set();let found;
 for(const line of events.split('\n')){let e;try{e=JSON.parse(line);}catch{continue;}
  if(e.type==='tool_call'&&['image_gen','image_edit'].includes(e.toolName||e.kind))calls.add(e.toolCallId);
  if(e.type==='tool_call_update'&&e.status==='completed'&&calls.has(e.toolCallId)&&['ImageGen','ImageEdit'].includes(e.rawOutput?.type)&&typeof e.rawOutput.path==='string')found=e.rawOutput.path;
 }
 if(!found)throw new Error('Grok CLI did not return a completed image_gen/image_edit artifact. Check its saved events; sign-in, subscription access or quota may need attention.');return found;
}
function run(binary,args,{cwd,env,timeoutMs=600000,log}={}){return new Promise((resolve,reject)=>{
 const child=spawn(binary,args,{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},timeoutMs);timer.unref();
 child.stdout.on('data',b=>{stdout+=b;if(log)fs.appendFileSync(log,b);if(stdout.length>24000000)child.kill('SIGTERM');});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-8000);});
 child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0||timedOut)reject(new Error(timedOut?'Grok CLI image generation timed out.':('Grok CLI failed: '+stderr+' '+stdout.split('\n').filter(l=>/error|limit|quota/i.test(l)).map(l=>l.slice(0,1000)).slice(-3).join(' ')).slice(-5000)));else resolve(stdout);});
 });}
export async function generateGrokArt({requestPath,planPath,outputPath,binary=grokBinary(),env=process.env,timeoutMs=600000}){
 const request=JSON.parse(fs.readFileSync(requestPath,'utf8')),directory=fs.realpathSync(request.output_directory);
 if(request.image_generation?.provider!=='grok-cli')throw new Error('This job did not select Grok CLI.');
 if(!contained(directory,requestPath)||!contained(directory,planPath))throw new Error('Save the request and art plan inside this job.');
 outputPath=path.resolve(directory,outputPath);
 if(!contained(directory,path.dirname(outputPath))||path.extname(outputPath)!=='.png')throw new Error('Save prepared art as a PNG inside this job.');
 const plan=JSON.parse(fs.readFileSync(planPath,'utf8'));
 if(typeof plan.prompt!=='string'||!plan.prompt.trim()||plan.prompt.length>30000)throw new Error('Save an art plan with a prompt of 1–30000 characters.');
 const refs=plan.reference_images||[];if(!Array.isArray(refs)||refs.length>5)throw new Error('Use up to five local reference images.');
 const roots=[directory,request.project_root,request.library_root].filter(p=>p&&fs.existsSync(p));
 const allowed=new Set((request.style_context?.reference_images||[]).map(r=>r.path));
 for(const v of [request.previous_version].filter(Boolean))for(const face of v.summary?.faces||[v.summary])if(face?.art)allowed.add(path.resolve(path.dirname(v.manifest_path),face.art));
 const referenceFiles=refs.map(ref=>{const filename=fs.realpathSync(path.resolve(directory,ref));if(!roots.some(root=>contained(root,filename))||!['.png','.jpg','.jpeg','.webp'].includes(path.extname(filename).toLowerCase())||fs.statSync(filename).size>16000000)throw new Error('Use local project reference images up to 16 MB.');if(!contained(directory,filename)&&![...allowed].some(p=>fs.existsSync(p)&&fs.realpathSync(p)===filename))throw new Error('Reference must be saved with this job or be its approved style/previous artwork.');return filename;});
 const fingerprint=hash(JSON.stringify({prompt:plan.prompt,refs:referenceFiles.map(p=>hash(fs.readFileSync(p))),provider:'grok-cli'}));
 const receiptPath=outputPath+'.grok.json';
 if(fs.existsSync(receiptPath)&&fs.existsSync(outputPath)){const saved=JSON.parse(fs.readFileSync(receiptPath));if(saved.fingerprint===fingerprint&&saved.image_sha256===hash(fs.readFileSync(outputPath)))return {...saved,cached:true};}
 if(fs.existsSync(outputPath)||fs.existsSync(receiptPath))throw new Error('This output already exists. Choose a new filename to preserve the earlier image.');
 const work=fs.mkdtempSync(path.join(directory,'grok-image-')),promptFile=path.join(work,'prompt.txt'),log=path.join(work,'events.jsonl');
 const prompt=`Generate exactly ONE image using ${referenceFiles.length?'image_edit':'image_gen'}. This is standalone artwork, not a finished Magic card. Use aspect_ratio 2:3 and the highest native image resolution available to the tool. Do not reduce or compress the source image. ${referenceFiles.length?'Use these exact local image paths as the image array for image_edit: '+JSON.stringify(referenceFiles)+'. Treat reference roles as described in the art brief.':''}\nART BRIEF:\n${plan.prompt}\nNo frame, card lettering, mana symbols, labels, logos or watermark. Preserve important subjects in the upper and central image for later card overlays. Do not use a shell, an API key or an external provider. After success, report the local image path returned by the tool. Do not make extra images.`;
 fs.writeFileSync(promptFile,prompt);
 const childEnv={...env,GROK_DISABLE_API_KEY_AUTH:'true'};delete childEnv.XAI_API_KEY;
 const events=await run(binary,['--cwd',work,'--tools',referenceFiles.length?'image_edit':'image_gen','--no-subagents','--no-plan','--always-approve','--max-turns','4','--output-format','streaming-json','--prompt-file',promptFile],{cwd:work,env:childEnv,timeoutMs,log});
 const source=fs.realpathSync(generatedImage(events)),grokHome=env.GROK_HOME||path.join(os.homedir(),'.grok');
 if(!contained(path.join(grokHome,'sessions'),source)||!['.jpg','.jpeg','.png','.webp'].includes(path.extname(source).toLowerCase())||fs.statSync(source).size>24000000)throw new Error('Grok returned an invalid session image path.');
 const savedSource=path.join(work,'original'+path.extname(source));fs.copyFileSync(source,savedSource);
 const prepared=JSON.parse((await run(env.CARDFORGE_PYTHON||'python3',[fileURLToPath(new URL('./prepare_grok_art.py',import.meta.url)),savedSource,outputPath],{cwd:directory,env:childEnv})).trim());
 const receipt={provider:'grok-cli',authentication:'subscription CLI login; API-key auth disabled',fingerprint,output_path:outputPath,source_path:savedSource,cli_source_path:source,prompt_path:promptFile,events_path:log,reference_paths:referenceFiles,...prepared};fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2));return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==5)throw new Error('Usage: node studio/grok-art.mjs REQUEST_JSON ART_PLAN_JSON OUTPUT_PNG');console.log(JSON.stringify(await generateGrokArt({requestPath:process.argv[2],planPath:process.argv[3],outputPath:process.argv[4]})));}catch(e){console.error(e.message);process.exitCode=1;}
}
