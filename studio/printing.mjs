export function printCount(entries,settings={}){
  return entries.reduce((count,entry)=>count+entry.quantity*(settings.face_mode==='separate'&&entry.back_path?2:1),0);
}

export function planPrint(input={},count=0){
  const number=(name,defaultValue,min,max)=>{const n=Number(input[name]??defaultValue);if(!Number.isFinite(n)||n<min||n>max)throw new Error(`${name} must be between ${min} and ${max}.`);return n;};
  const papers={A4:[210,297],Letter:[215.9,279.4],A3:[297,420],Custom:[number('paper_width',210,100,1000),number('paper_height',297,100,1000)]};
  const quality=input.quality||'full';if(!['full','compact','600','1200'].includes(quality))throw new Error('Choose native resolution, 300, 600 or 1200 PPI.');
  const packaging=input.packaging??'combined';if(!['combined','per_page'].includes(packaging))throw new Error('Choose a combined PDF or one PDF per page.');
  const paper=input.paper||'A4';if(!papers[paper])throw new Error('Select A4, Letter, A3 or Custom paper.');
  const landscape=input.landscape===true;let [width,height]=papers[paper];if(landscape)[width,height]=[height,width];
  const card_width=number('card_width',63.5,20,150),card_height=number('card_height',88.9,20,200),margin=number('margin',5,0,100),gap=number('gap',2,0,30),bleed=number('bleed',0,0,5);
  const cellW=card_width+2*bleed,cellH=card_height+2*bleed;
  const columns=Math.floor((width-2*margin+gap)/(cellW+gap)+1e-8),rows=Math.floor((height-2*margin+gap)/(cellH+gap)+1e-8);
  if(columns<1||rows<1)throw new Error('No cards fit. Reduce margins, bleed or card size, or choose larger paper.');
  const limit=input.face_mode==='separate'?2000:1000;
  if(!Number.isInteger(count)||count<0||count>limit)throw new Error(`Print up to ${limit.toLocaleString('en-US')} card faces per PDF.`);
  if(input.crop_marks!==false&&gap<.5)throw new Error('Use at least 0.5 mm card spacing for crop marks.');
  if(input.calibration===true&&(width<140||height<160))throw new Error('Calibration requires paper at least 140 × 160 mm.');
  const per_page=rows*columns,pages=Math.ceil(count/per_page),gridW=columns*cellW+(columns-1)*gap,gridH=rows*cellH+(rows-1)*gap;
  const face_mode=input.face_mode||'fronts';if(!['fronts','backs','duplex','separate'].includes(face_mode))throw new Error('Select fronts, backs, separate cards or duplex pages.');
  const card_pages=face_mode==='duplex'?pages*2:pages,total_pages=card_pages+(input.calibration===true?1:0),selected_pages=printPageRange(input.page_range,total_pages);
  return {packaging,selected_pages,total_pages,output_pages:selected_pages?.length??total_pages,paper,width,height,landscape,card_width,card_height,margin,gap,bleed,columns,rows,per_page,pages:face_mode==='duplex'?pages*2:pages,count,face_mode,duplex_edge:input.duplex_edge==='short'?'short':'long',offset_x:(width-gridW)/2,offset_y:(height-gridH)/2,crop_marks:input.crop_marks!==false,calibration:input.calibration===true,quality};
}

// Print scope is resolved once for both preview and PDF, including a historical card version.
export function printEntries(store,deck,settings={}){
  if(settings.art_set_id&&settings.art_set_id!==deck.active_art_set_id)throw new Error('The artwork set changed. Reopen the print dialog before printing.');
  const selection=settings.card_ids;
  if(selection!==undefined&&(!Array.isArray(selection)||!selection.length||selection.length>500||selection.some(id=>typeof id!=='string'||!deck.cards.some(c=>c.id===id))||new Set(selection).size!==selection.length))throw new Error('Choose cards belonging to this deck.');
  const single=selection?.length===1;
  if(settings.version_id!==undefined&&(!single||typeof settings.version_id!=='string'))throw new Error('Choose one card before selecting a version to print.');
  const copies=settings.copies==null?null:Number(settings.copies);
  if(copies!==null&&(!single||!Number.isInteger(copies)||copies<1||copies>999))throw new Error('Choose 1–999 copies of a single card.');
  const cards=deck.cards.filter(c=>selection?selection.includes(c.id):(settings.include_sideboard||c.section!=='sideboard')&&(settings.include_tokens!==false||c.section!=='tokens'));
  const missing=[],entries=[];
  for(const card of cards){
    const versionId=settings.version_id||card.active_version_id;
    if(!versionId){missing.push(card.name);continue;}
    const version=store.get('SELECT v.* FROM versions v JOIN deck_art_versions a ON a.version_id=v.id WHERE v.id=? AND v.card_id=? AND a.set_id=?',versionId,card.id,deck.active_art_set_id);
    if(!version)throw new Error('This version does not belong to the selected card and artwork set.');
    const back=JSON.parse(version.faces_json||'[]').find(f=>f.label==='back')?.image_path||null;
    if(settings.face_mode==='backs'&&!back)continue;
    entries.push({...version,image_path:settings.face_mode==='backs'?back:version.image_path,back_path:settings.face_mode==='backs'?null:back,quantity:copies??(settings.quantities===false?1:card.quantity),name:card.name});
  }
  return {entries,missing,title:single?cards[0].name:deck.name,print_scope:{kind:'deck',deck_id:deck.id,art_set_id:deck.active_art_set_id,card_ids:selection?[...selection].sort():null,version_id:settings.version_id||null}};
}

export function printPageRange(value,total){
  if(value==null||value==='')return null;
  if(typeof value!=='string'||value.length>4000)throw new Error('Use PDF page numbers such as 1, 3-5.');
  if(!value.trim())return null;
  const pages=new Set();
  for(const part of value.split(',')){const match=part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);if(!match)throw new Error('Use PDF page numbers such as 1, 3-5.');const from=Number(match[1]),to=Number(match[2]||match[1]);if(from<1||to<from||to>total)throw new Error(`Choose PDF pages between 1 and ${total}.`);for(let page=from;page<=to;page++)pages.add(page);}
  return [...pages].sort((a,b)=>a-b);
}
