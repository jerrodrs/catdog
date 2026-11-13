"""Normalize high-resolution full-card uploads and remove declared existing bleed."""
import hashlib,json,sys
from pathlib import Path
from PIL import Image,ImageOps
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from cardforge.color import to_srgb,SRGB_PROFILE
r=json.loads(Path(sys.argv[1]).read_text());result=[]
for i,file in enumerate(r['files']):
    source=Path(file)
    with Image.open(source) as raw:
        if raw.width*raw.height>36000000 or min(raw.size)<256:raise ValueError('Upload card images between 256 pixels and 36 megapixels.')
        raw=ImageOps.exif_transpose(raw);original=list(raw.size);image=to_srgb(raw).convert('RGB');bleed=r.get('bleed_mm',0)
        x=round(image.width*bleed/(r.get('card_width',63.5)+2*bleed));y=round(image.height*bleed/(r.get('card_height',88.9)+2*bleed))
        if x or y:image=image.crop((x,y,image.width-x,image.height-y))
        target=Path(r['directory'])/('back.png' if i else 'front.png');image.save(target,icc_profile=SRGB_PROFILE,compress_level=4)
        result.append({'label':'back' if i else 'front','image_path':str(target),'width':image.width,'height':image.height,'original_pixels':original,'removed_bleed_mm':bleed,'cropped_pixels':[x,y],'color_space':'sRGB','source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'effective_ppi':round(min(image.width/(r.get('card_width',63.5)/25.4),image.height/(r.get('card_height',88.9)/25.4)),1)})
print(json.dumps({'faces':result}))
