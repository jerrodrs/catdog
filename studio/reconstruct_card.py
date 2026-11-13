"""Rebuild official artwork with deterministic type, symbols and an original frame.
This produces a labelled reconstruction in metadata, not an exact printing scan.
"""
import json,sys,subprocess,math
from pathlib import Path
from PIL import Image,ImageOps,ImageColor
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from cardforge.color import to_srgb,SRGB_PROFILE
from cardforge.render import save_card
from cardforge.faces import art_paths,is_double
request=json.loads(Path(sys.argv[1]).read_text());directory=Path(request['directory']);printing=json.loads(Path(request['printing_path']).read_text());manifest=directory/'manifest.json'
subprocess.run([sys.executable,'-m','cardforge','import',request['printing_path'],'--out',str(manifest)],cwd=ROOT,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
card=json.loads(manifest.read_text())['cards'][0]
config=json.loads((ROOT/'examples/frame-set.json').read_text());config['name']='Reconstructed MTG · bordered';config['ornaments']=[]
config['style'].update(shape='classic',border_mode='bordered',rules_sizing='fit',text_color='#171919',panel_color='#f1eddf',panel_alpha=245)
for palette in config['palettes'].values():
    rgb=ImageColor.getrgb(palette['header']);palette['header']='#'+''.join(f'{round(c*.35+255*.65):02x}' for c in rgb)
quality=[];faces=card.get('faces',[card]);original_faces=printing.get('card_faces') if is_double(card) else [printing]
for i,face in enumerate(faces):
    original=original_faces[i];face['frame_style']=config
    face['flavor_text']=original.get('flavor_text','')
    face['source'].update(snapshot=str(Path(request['printing_path']).resolve()),reconstruction='Official artwork with newly typeset English Oracle text; original template, not an exact scan')
    source=Path(request['art_paths'][i]);target=directory/f'official-art-{i}.png'
    with Image.open(source) as raw:
        if raw.width*raw.height>36000000 or min(raw.size)<256:raise ValueError('Artwork must be at least 256 pixels and at most 36 megapixels.')
        raw=ImageOps.exif_transpose(raw);native=list(raw.size);image=to_srgb(raw).convert('RGB');scale=max(1,1500/image.width,2100/image.height)
        if scale>1:image=image.resize((math.ceil(image.width*scale),math.ceil(image.height*scale)),Image.Resampling.LANCZOS)
        image.save(target,icc_profile=SRGB_PROFILE)
    face['art']=str(target);quality.append({'source_pixels':native,'prepared_pixels':list(image.size),'enlarged':scale>1,'source_kind':request.get('art_sources',['scryfall-art-crop']*len(faces))[i]})
manifest.write_text(json.dumps({'cards':[card]},indent=2,ensure_ascii=False));(directory/'source-manifest.json').write_text(manifest.read_text())
target=save_card(card,directory/'rendered',art_paths(card,directory),dpi=1200)
report_path=target.with_suffix('.report.json');report=json.loads(report_path.read_text());report['reconstruction']={'printing_id':printing['id'],'text_mode':'current English Oracle','art_sources':quality,'exact_original_frame':False};report_path.write_text(json.dumps(report,indent=2))
face_outputs=[{'label':'front' if i==0 else 'back','name':f['name'],'image_path':str(target if i==0 else target.with_name(target.stem+'-back.png')),'frame_path':str((target if i==0 else target.with_name(target.stem+'-back.png')).with_suffix('.frame.png'))} for i,f in enumerate(faces)] if is_double(card) else []
print(json.dumps({'image_path':str(target),'frame_path':str(target.with_suffix('.frame.png')),'manifest_path':str(manifest),'report_path':str(report_path),'summary':card,'faces':face_outputs,'art_quality':quality}))
