import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export function copyFrameSet(source,destination,options={}){
 const config=JSON.parse(fs.readFileSync(source,'utf8')),root=fs.realpathSync(path.dirname(source));delete config._asset_root;
 if(options.rulesSizing)for(const style of [config.style??={},...Object.values(config.layouts||{})])style.rules_sizing=options.rulesSizing;
 // Decorations, panel textures and painted skins are frozen PNG assets; each card job keeps its own hashed copies.
 for(const [i,item]of [...(config.decorations||[]),...Object.values(config.textures||{}),...Object.values(config.skins||{})].entries()){
  const filename=fs.realpathSync(path.resolve(root,item.image)),relative=path.relative(root,filename);if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative)||path.extname(filename).toLowerCase()!=='.png')throw new Error('Frame decoration must remain inside its source frame version.');
  const bytes=fs.readFileSync(filename),hash=createHash('sha256').update(bytes).digest('hex');if(item.sha256&&item.sha256!==hash)throw new Error('A frozen frame decoration changed after it was selected.');const target=path.join(path.dirname(destination),'frame-assets',i+'-'+hash.slice(0,16)+'.png');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);item.image=path.relative(path.dirname(destination),target);item.sha256=hash;
 }
 fs.writeFileSync(destination,JSON.stringify(config,null,2));return destination;
}
