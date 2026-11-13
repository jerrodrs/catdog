"""Frozen raster ornaments layered around deterministic, protected gameplay regions."""
import hashlib,json
from pathlib import Path
from PIL import Image,ImageDraw,ImageChops,ImageOps


def load_set(filename):
    filename=Path(filename).resolve(strict=True)
    config=json.loads(filename.read_text());config['_asset_root']=str(filename.parent)
    from .template_sets import migrate_set
    migrate_set(config)
    for item in [*config.get('decorations',[]),*config.get('textures',{}).values(),*config.get('skins',{}).values()]:
        source=asset_path(config,item)
        actual=hashlib.sha256(source.read_bytes()).hexdigest()
        if item.get('sha256') and item['sha256']!=actual:
            from .render import LayoutError
            raise LayoutError('A frozen frame decoration changed after it was selected')
        item['sha256']=actual
    return config


def asset_path(config,item):
    from .render import LayoutError
    root=config.get('_asset_root')
    if not root:raise LayoutError('Raster frame decorations require a frozen asset root; load the set with decorations.load_set.')
    root=Path(root).resolve(strict=True);filename=(root/item['image']).resolve(strict=True)
    if not filename.is_relative_to(root) or filename.suffix.lower()!='.png':raise LayoutError('Frame decoration must be a PNG inside its frame version.')
    return filename


def validate(config):
    from .render import LayoutError
    items=config.get('decorations',[])
    if not isinstance(items,list) or len(items)>24:raise LayoutError('Use at most 24 raster frame decorations')
    for item in items:
        if not isinstance(item,dict) or not isinstance(item.get('image'),str):raise LayoutError('A frame decoration requires a PNG image')
        box=item.get('box')
        if not isinstance(box,list) or len(box)!=4 or any(not isinstance(v,(int,float)) for v in box) or not 0<=box[0]<box[2]<=1500 or not 0<=box[1]<box[3]<=2100:raise LayoutError('Frame decoration bounds must lie within the card')
        if not isinstance(item.get('opacity',1),(int,float)) or not 0<item.get('opacity',1)<=1:raise LayoutError('Invalid decoration opacity')
        if item.get('fit','contain') not in ('contain','stretch','tile'):raise LayoutError('Use contain, stretch or tile for raster decorations')
        if item.get('layer','over') not in ('over','under'):raise LayoutError('Use under or over for decoration layering')
        if item.get('tint') not in (None,'rim','highlight','shadow','header'):raise LayoutError('Decoration tint must be a palette role: rim, highlight, shadow or header')
        if item.get('tint_mode','colorize') not in ('colorize','multiply'):raise LayoutError('Decoration tint_mode must be colorize or multiply')
        if not isinstance(item.get('tint_strength',1),(int,float)) or not 0<=item.get('tint_strength',1)<=1:raise LayoutError('Decoration tint_strength must be 0–1')
        filename=asset_path(config,item)
        if item.get('sha256') and hashlib.sha256(filename.read_bytes()).hexdigest()!=item['sha256']:raise LayoutError('A frozen frame decoration changed after it was selected')
        with Image.open(filename) as image:
            if image.format!='PNG' or image.width*image.height>36000000 or image.mode!='RGBA':raise LayoutError('Frame decorations require an RGBA PNG of at most 36 megapixels')
            alpha=image.getchannel('A')
            if alpha.getextrema()[0]!=0 or alpha.getextrema()[1]<64:raise LayoutError('Frame decorations need genuine transparency and visible detail')
    textures=config.get('textures',{})
    if not isinstance(textures,dict) or len(textures)>8:raise LayoutError('Use at most 8 named panel textures')
    for name,item in textures.items():
        if not isinstance(item,dict) or not isinstance(item.get('image'),str):raise LayoutError('A panel texture requires a PNG image')
        filename=asset_path(config,item)
        if item.get('sha256') and hashlib.sha256(filename.read_bytes()).hexdigest()!=item['sha256']:raise LayoutError('A frozen panel texture changed after it was selected')
        with Image.open(filename) as image:
            if image.format!='PNG' or not 64<=image.width<=2048 or not 64<=image.height<=2048:raise LayoutError('Panel textures must be PNG tiles between 64 and 2048 px per side: '+name)
    skins=config.get('skins',{})
    if not isinstance(skins,dict) or len(skins)>12:raise LayoutError('Use at most 12 named panel skins')
    for name,item in skins.items():
        if not isinstance(item,dict) or not isinstance(item.get('image'),str):raise LayoutError('A panel skin requires a PNG image: '+name)
        filename=asset_path(config,item)
        if item.get('sha256') and hashlib.sha256(filename.read_bytes()).hexdigest()!=item['sha256']:raise LayoutError('A frozen panel skin changed after it was selected')
        with Image.open(filename) as image:
            if image.format!='PNG' or image.width*image.height>36000000 or min(image.size)<64:raise LayoutError('Panel skins must be PNGs of at least 64 px and at most 36 megapixels: '+name)
            size=image.size
        if item.get('fill','stretch') not in ('stretch','tile'):raise LayoutError('Skin fill must be stretch or tile: '+name)
        if not isinstance(item.get('scale',1),(int,float)) or not .25<=item.get('scale',1)<=2:raise LayoutError('Skin scale must be 0.25–2: '+name)
        for key in ('tint','covers_rails'):
            if not isinstance(item.get(key,False),bool):raise LayoutError(f'Skin {key} must be true or false: '+name)
        if 'slice' in item:
            cut=item['slice']
            if not isinstance(cut,list) or len(cut)!=4 or any(not isinstance(v,int) or v<0 for v in cut) or cut[0]+cut[2]>=size[0] or cut[1]+cut[3]>=size[1]:
                raise LayoutError('Skin slice must be [left, top, right, bottom] whole pixels leaving a centre: '+name)
    return items


def tinted(image,palette,item):
    """Recolour an RGBA decoration toward a palette role so one asset follows every colour identity."""
    role=item.get('tint')
    if not role:return image
    alpha=image.getchannel('A');strength=item.get('tint_strength',1)
    if item.get('tint_mode','colorize')=='multiply':
        coloured=ImageChops.multiply(image.convert('RGB'),Image.new('RGB',image.size,palette[role]))
    else:
        coloured=ImageOps.colorize(image.convert('L'),black=palette['shadow'],mid=palette[role],white=palette['highlight'])
    result=Image.blend(image.convert('RGB'),coloured,strength).convert('RGBA');result.putalpha(alpha);return result


def safe_mask(size,geometry,type_top,statistics=''):
    """Inverse of the measured lettering/statistics regions for one card; ornaments and decorations draw only here."""
    from .frames import PANEL_SHIFT,LOYALTY_SHIFT
    scale=2 if size[0]==3000 else 1
    protected=Image.new('L',size,0);d=ImageDraw.Draw(protected)
    boxes=[(94,geometry['title'][1]+4,1406,geometry['title'][3]-4),(152,geometry['alias_text'][1],1348,geometry['alias_text'][3]),(94,geometry['type'][1]+4,1406,geometry['type'][3]-4),(106,type_top+108,1394,1904+PANEL_SHIFT)]
    if geometry.get('stats'):
        x0,y0,x1,y1=geometry['stats'];boxes.append((x0-5,y0-5,x1+5,y1+5))
    if statistics=='loyalty':boxes.append((1215,1901+LOYALTY_SHIFT,1447,2045+LOYALTY_SHIFT))
    for box in boxes:d.rectangle(tuple(round(v*scale) for v in box),fill=255)
    return ImageChops.invert(protected)


def authored(size,box):
    """True when an image was drawn at exactly its box's size, at card units or print resolution (2 px per unit).
    Such images are placed as drawn: trimming their transparent margins would move a rim-aligned ring or edge band."""
    width,height=box[2]-box[0],box[3]-box[1]
    return tuple(size) in ((round(width),round(height)),(round(2*width),round(2*height)))


def tiled(image,width,height):
    """Repeat a seamless trim segment along the box's long axis at its true proportions, scaled to the short axis."""
    horizontal=width>=height
    scale=height/image.height if horizontal else width/image.width
    piece=image.resize((max(1,round(image.width*scale)),height) if horizontal else (width,max(1,round(image.height*scale))),Image.Resampling.LANCZOS)
    out=Image.new('RGBA',(width,height))
    for offset in range(0,width if horizontal else height,piece.width if horizontal else piece.height):
        out.alpha_composite(piece,(offset,0) if horizontal else (0,offset))
    return out


def apply(layer,config,geometry,type_top,kind,legendary,position='over',statistics='',palette=None,safe=None):
    scale=2 if layer.width==3000 else 1
    safe=safe if safe is not None else safe_mask(layer.size,geometry,type_top,statistics)
    for item in config.get('decorations',[]):
        if item.get('layer','over')!=position or item.get('layouts') and kind not in item['layouts']:continue
        if 'legendary' in item and item['legendary']!=legendary:continue
        with Image.open(asset_path(config,item)) as original:
            original=original.convert('RGBA');bbox=original.getchannel('A').point(lambda v:255 if v>8 else 0).getbbox()
            if not bbox:continue
            exact=authored(original.size,item['box'])
            if not exact:original=original.crop(bbox)
            if item.get('mirror_x'):original=ImageOps.mirror(original)
            if palette:original=tinted(original,palette,item)
            x0,y0,x1,y1=[round(v*scale) for v in item['box']];width,height=x1-x0,y1-y0
            fit=item.get('fit','contain')
            if exact:image=original if original.size==(width,height) else original.resize((width,height),Image.Resampling.LANCZOS)
            else:image=original.resize((width,height),Image.Resampling.LANCZOS) if fit=='stretch' else tiled(original,width,height) if fit=='tile' else ImageOps.contain(original,(width,height),Image.Resampling.LANCZOS)
            tile=Image.new('RGBA',layer.size);tile.alpha_composite(image,(x0+(width-image.width)//2,y0+(height-image.height)//2))
            alpha=ImageChops.multiply(tile.getchannel('A'),safe)
            if item.get('opacity',1)!=1:alpha=alpha.point(lambda v:round(v*item['opacity']))
            tile.putalpha(alpha);layer.alpha_composite(tile)
