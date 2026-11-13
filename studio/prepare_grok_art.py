"""Record and prepare a CLI image for print composition without inventing native resolution."""
import hashlib,json,math,sys
from pathlib import Path
from PIL import Image,ImageOps
source,target=map(Path,sys.argv[1:3])
with Image.open(source) as original:
    if original.width*original.height>36000000:raise ValueError('Generated image exceeds the 36 megapixel limit.')
    image=ImageOps.exif_transpose(original).convert('RGB');native=image.size
    if min(native)<256 or not .5<=native[0]/native[1]<=1:raise ValueError('Expected a portrait image with usable dimensions.')
    scale=max(1,1500/native[0],2100/native[1])
    if scale>1:image=image.resize((math.ceil(native[0]*scale),math.ceil(native[1]*scale)),Image.Resampling.LANCZOS)
    image.save(target,dpi=(600,600))
    print(json.dumps({'native_dimensions':native,'prepared_dimensions':image.size,'upscaled':scale>1,'scale_factor':scale,'method':'Lanczos resampling; native resolution retained in source','source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'image_sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))
