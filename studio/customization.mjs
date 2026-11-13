const choices={title_mode:['style','original','custom'],flavor_mode:['style','none','custom'],rarity:['original','common','uncommon','rare','mythic']};
export function validateCustomization(value,depth=0){
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid card appearance settings.');
  const allowed=new Set([...Object.keys(choices),'display_name','flavor_text','art_focus',...(depth===0?['back']:[])]);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw new Error('Unknown card appearance setting.');
  const result={};
  for(const [key,options]of Object.entries(choices)){
    const option=value[key]??options[0];if(!options.includes(option))throw new Error('Invalid '+key+'.');result[key]=option;
  }
  for(const [key,max]of [['display_name',180],['flavor_text',3000]]){
    const text=value[key]??'';if(typeof text!=='string'||text.length>max||text.includes('\0')||(key==='display_name'&&/[\r\n]/.test(text)))throw new Error('Invalid '+key+'.');result[key]=text.trim();
  }
  if(result.title_mode==='custom'&&!result.display_name)throw new Error('Enter a custom title.');
  if(result.flavor_mode==='custom'&&!result.flavor_text)throw new Error('Enter custom flavour text, or choose no flavour text.');
  if(value.art_focus!=null){if(!Array.isArray(value.art_focus)||value.art_focus.length!==2||value.art_focus.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1))throw new Error('Art focus must be between 0 and 100 percent.');result.art_focus=value.art_focus;}
  if(value.back!==undefined)result.back=validateCustomization(value.back,depth+1);
  return result;
}
