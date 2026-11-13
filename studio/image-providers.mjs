import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
export const IMAGE_PROVIDERS=[{id:'codex',name:'Codex · GPT'},{id:'grok-cli',name:'Grok · subscription CLI'}];
export function imageProvider(value='codex'){
 if(!IMAGE_PROVIDERS.some(p=>p.id===value))throw new Error('Choose Codex or Grok CLI for card generation.');return value;
}
export function grokBinary(){return process.env.GROK_BIN||(fs.existsSync(path.join(os.homedir(),'.grok/bin/grok'))?path.join(os.homedir(),'.grok/bin/grok'):'grok');}
let cached;
export function imageProviderStatus(){
 const binary=grokBinary(),home=process.env.GROK_HOME||path.join(os.homedir(),'.grok');
 if(!cached||cached.binary!==binary||Date.now()-cached.time>30000){const r=spawnSync(binary,['--version'],{encoding:'utf8',timeout:3000});cached={time:Date.now(),binary,installed:!r.error&&r.status===0,version:r.status===0?r.stdout.trim():''};}
 const loginSaved=fs.existsSync(path.join(home,'auth.json'));
 return IMAGE_PROVIDERS.map(p=>({...p,available:p.id==='codex'||cached.installed&&loginSaved,...(p.id==='grok-cli'?{installed:cached.installed,login_saved:loginSaved,version:cached.version,message:!cached.installed?'Install the official Grok CLI in WSL.':!loginSaved?'Run grok login --device-auth in WSL.':'Uses the CLI subscription login; account limits apply.'}:{})}));
}
