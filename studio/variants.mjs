export const BASIC_LANDS=['Plains','Island','Swamp','Mountain','Forest','Wastes','Snow-Covered Plains','Snow-Covered Island','Snow-Covered Swamp','Snow-Covered Mountain','Snow-Covered Forest'];
export function tokenSpec(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Use Add tokens / art variants to specify the token’s type, colours, rules and statistics.');
  const text=(key,max=180)=>{const v=value[key]??'';if(typeof v!=='string'||v.length>max||v.includes('\0')||(key!=='oracle_text'&&/[\r\n]/.test(v)))throw new Error('Invalid token '+key+'.');return v.trim();};
  const name=text('name'),type_line=text('type_line'),oracle_text=text('oracle_text',5000);
  if(!name||!type_line.startsWith('Token ')||/Saga|Class|Battle|Planeswalker/.test(type_line))throw new Error('Provide a token name and a supported single-face Token type line.');
  const colors=value.colors??[];if(!Array.isArray(colors)||colors.some(c=>!['W','U','B','R','G'].includes(c)))throw new Error('Choose token colours from W, U, B, R, G.');
  const result={name,type_line,oracle_text,colors:[...new Set(colors)],color_identity:[...new Set(colors)],mana_cost:'',layout:'token',rarity:'common'};
  if(type_line.includes('Creature')){const power=text('power',12),toughness=text('toughness',12);if(!power||!toughness)throw new Error('Creature tokens require power and toughness.');result.power=power;result.toughness=toughness;}
  return result;
}
export function variantRequest(data){
  const kind=data.kind||'land';if(!['land','token','card'].includes(kind))throw new Error('Choose basic land, token or card variants.');
  const variants=Number(data.variants??1),total=Number(data.total_copies??variants);
  if(!Number.isInteger(variants)||variants<1||variants>100||!Number.isInteger(total)||total<variants||total>999)throw new Error('Choose 1–100 unique illustrations and between that many and 999 total copies.');
  let name=typeof data.name==='string'?data.name.trim():'';if(!name||name.length>180||/[\r\n\0]/.test(name))throw new Error('Enter the original card or token name.');
  if(kind==='land'){const canonical=BASIC_LANDS.find(n=>n.toLowerCase()===name.toLowerCase());if(!canonical)throw new Error('Select a basic land, or choose other card for nonbasic lands.');name=canonical;}
  const spec=kind==='token'?tokenSpec({...data.token_spec,name}):null;
  return {kind,name,variants,total,spec,section:kind==='token'?'tokens':data.section==='sideboard'?'sideboard':'main',replace_existing:kind!=='token'&&data.replace_existing===true,quantities:Array.from({length:variants},(_,i)=>Math.floor(total/variants)+(i<total%variants?1:0))};
}
