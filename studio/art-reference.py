"""Validate and prepare locally uploaded references; originals remain untouched."""
import hashlib,json,sys,warnings
from pathlib import Path
from PIL import Image,ImageOps
Image.MAX_IMAGE_PIXELS=36000000
warnings.simplefilter('error',Image.DecompressionBombWarning)
p=Path(sys.argv[1]);source=p/'upload.bin'
with Image.open(source) as image:
    if image.format not in ('PNG','JPEG','WEBP'):raise ValueError('Use PNG, JPEG or WebP reference images.')
    fmt=image.format;image.load();image=ImageOps.exif_transpose(image).convert('RGB');size=image.size
    if min(size)<32:raise ValueError('Reference images must be at least 32 pixels on each side.')
    image.thumbnail((1800,1800));image.save(p/'reference.png')
    image.thumbnail((360,360));image.save(p/'thumb.jpg',quality=90)
ext={'PNG':'png','JPEG':'jpg','WEBP':'webp'}[fmt];original=p/('original.'+ext);source.rename(original)
print(json.dumps({'original_path':str(original),'image_path':str(p/'reference.png'),'thumb_path':str(p/'thumb.jpg'),'mime':{'PNG':'image/png','JPEG':'image/jpeg','WEBP':'image/webp'}[fmt],'width':size[0],'height':size[1],'sha256':hashlib.sha256(original.read_bytes()).hexdigest()}))
