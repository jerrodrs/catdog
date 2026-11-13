// Run manually to refresh the app's cached real-card reference thumbnails.
import fs from 'node:fs';
import path from 'node:path';
const directory=path.resolve('assets/frame-references');fs.mkdirSync(directory,{recursive:true});
const definitions=[
 ['bordered','Modern bordered','!"Counterspell" set:mh2 border:black -is:fullart','bordered','An inset illustration window, opaque frame and outer black border.'],
 ['borderless','Borderless','!"Counterspell" border:borderless','borderless','Artwork extends to the card edges behind information panels.'],
 ['legendary-bordered','Legendary bordered','!"Thalia, Guardian of Thraben" frame:legendary border:black','legendary','Legendary crown treatment in a bordered frame.'],
 ['legendary-borderless','Legendary borderless','!"Ragavan, Nimble Pilferer" border:borderless','legendary','Legendary treatment with art extending to the edges.'],
 ['planeswalker','Bordered planeswalker','!"Chandra, Torch of Defiance" set:kld','planeswalker','Separate loyalty-ability rows and starting-loyalty shield.'],
 ['planeswalker-borderless','Borderless planeswalker','!"Teferi, Master of Time" border:borderless','planeswalker','A planeswalker frame combined with edge-to-edge artwork.'],
 ['full-art-land','Full-art basic land','!"Forest" set:blb is:fullart','land','A land treatment with very little information-panel coverage.'],
 ['retro','Retro frame','!"Counterspell" frame:1997','unique','Old-style coloured frame, illustration window and textured text panel.'],
 ['showcase','Showcase woodland','set:blb frame:showcase t:legendary','unique','A set-specific decorative showcase treatment.'],
 ['extended-art','Extended art','!"Polluted Delta" set:mh3 is:extendedart','unique','Illustration extends horizontally while top and bottom retain framing.'],
 ['prepare','Prepared spell','!"Emeritus of Ideation" layout:prepare','unique','Permanent abilities on the left with a prepare spell inset on the right.'],
 ['saga','Saga','!"The Eldest Reborn" set:dom','unique','Chapter structure and a distinct vertical illustration layout.'],
 ['adventure','Adventure','!"Bonecrusher Giant" set:eld','unique','A secondary Adventure spell panel within a creature card.'],
 ['battle','Battle','!"Invasion of Zendikar" set:mom','unique','Landscape-oriented battle front with defence value.'],
 ['modal-dfc','Modal double-faced','!"Bala Ged Recovery" set:znr','unique','A paired spell/land card with separate face identities.']
];
const records=[];
for(const [id,label,query,category,description]of definitions){
 const url=new URL('https://api.scryfall.com/cards/search');url.searchParams.set('q',query);url.searchParams.set('unique','prints');url.searchParams.set('order','released');url.searchParams.set('dir','asc');
 const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'CardStudio/1.0 (local frame-reference research)'}});
 if(!response.ok){console.log(id+' lookup '+response.status);continue;}
 const card=(await response.json()).data[0],face=card.image_uris?card:card.card_faces?.[0],images=face?.image_uris;
 if(!images?.small||!images?.normal){console.log(id+' missing images');continue;}
 for(const [size,remote]of [['thumb',images.small],['normal',images.normal]]){
  const image=await fetch(remote,{headers:{Accept:'image/jpeg','User-Agent':'CardStudio/1.0 (local reference thumbnails)'}});if(!image.ok)throw new Error(id+' image '+image.status);
  fs.writeFileSync(path.join(directory,id+'-'+size+'.jpg'),Buffer.from(await image.arrayBuffer()));
 }
 records.push({id,label,category,description,name:card.name,source_url:card.scryfall_uri,image_source:images.normal,artist:face.artist||card.artist,printing:card.set_name,collector_number:card.collector_number,border_color:card.border_color,frame_effects:card.frame_effects||[],layout:card.layout,thumb:'/frame-references/'+id+'-thumb.jpg',image:'/frame-references/'+id+'-normal.jpg',downloaded_at:new Date().toISOString()});
 console.log(id+' — '+card.name+' ('+card.border_color+')');await new Promise(r=>setTimeout(r,150));
}
fs.writeFileSync(path.join(directory,'index.json'),JSON.stringify({notice:'Real printed Magic cards, illustrated by the credited artists. Images are cached from Scryfall for visual frame-reference use. Magic: The Gathering is published by Wizards of the Coast.',guides:[{title:'Collecting Modern Horizons 3',url:'https://magic.wizards.com/en/news/feature/collecting-modern-horizons-3'},{title:'Collecting Bloomburrow',url:'https://magic.wizards.com/en/news/feature/collecting-bloomburrow'}],references:records},null,2));
