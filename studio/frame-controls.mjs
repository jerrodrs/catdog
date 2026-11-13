export function frameControls(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid frame controls.');
  const result={};
  for(const [key,allowed]of Object.entries({border_mode:['agent','borderless','bordered'],rules_sizing:['agent','fit','full'],legendary_style:['agent','crest','minimal'],rail_material:['agent','coloured','copper','gold','silver'],flavour_level:['agent','classic','stylised','showcase']})){
    const choice=value[key]??'agent';if(!allowed.includes(choice))throw new Error('Invalid '+key+'.');result[key]=choice;
  }
  for(const key of ['title_padding','type_padding','alias_padding']){
    if(value[key]===null||value[key]===undefined||value[key]===''){result[key]=null;continue;}
    const number=Number(value[key]);if(!Number.isFinite(number)||number<8||number>60)throw new Error('Frame padding must be between 8 and 60 pixels.');result[key]=number;
  }
  for(const [key,min,max]of [['title_offset_y',-10,100],['rules_offset_y',-150,600],['stats_x',40,1280],['stats_y',1906,1990],['stats_width',180,480],['stats_height',80,160]]){
    const valueAtKey=value[key];if(valueAtKey==null||valueAtKey===''){result[key]=null;continue;}
    const number=Number(valueAtKey);if(!Number.isFinite(number)||number<min||number>max)throw new Error('Invalid visual frame position.');result[key]=number;
  }
  if((result.stats_x??1176)+(result.stats_width??266)>1460||(result.stats_y??1916)+(result.stats_height??102)>2070)throw new Error('Keep the power/toughness box within the card edges.');
  return result;
}
