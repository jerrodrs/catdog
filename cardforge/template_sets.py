"""Validated declarative frame sets. No generated Python or external fonts execute."""
import json
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageColor, ImageChops, ImageFilter, ImageOps

SHAPES=('classic','angular','rounded','stepped','ticket','ribbon','pill','scalloped','custom')
# Rules-box silhouette: the panel keeps its fixed position and text area; only its lower outline varies.
PANEL_BOTTOMS=('arch','flat','notch','step')
PANEL_CORNERS=('square','cut','rounded','notched')
SKIN_KEYS=('title_skin','alias_skin','type_skin','rules_skin','stats_skin','crest_skin')
REQUIRED_LAYOUTS=('creature','artifact','enchantment','instant','sorcery','land','planeswalker','token','transform_front','transform_back','adventure','prepare','saga')


# Card-position measurements belong to the user (frame editor drags and resizes), never to the designer.
POSITION_KEYS=('title_offset_y','rules_offset_y','stats_x','stats_y','stats_width','stats_height')


def drop_designer_positions(config,controls):
    """Remove position offsets the user did not set, so a generated frame cannot pin the rules box or stats box in
    place (an offset overrides fitted rules sizing). The user's own values are re-applied by apply_controls.
    Returns the sorted keys that were removed."""
    removed=set()
    for style in [config.get('style',{}),*config.get('layouts',{}).values()]:
        for key in POSITION_KEYS:
            if key in style and controls.get(key) is None:style.pop(key);removed.add(key)
    return sorted(removed)


def apply_controls(config,controls):
    rules_sizing=controls.get('rules_sizing')
    rules_sizing=rules_sizing if rules_sizing in ('fit','full') else 'fit'
    material=controls.get('rail_material','agent')
    materials={'copper':('#B97842','#FFE0AC','#4B2619'),'gold':('#B28B38','#FFEB9F','#4D371A'),'silver':('#AEBAC3','#F2FAFF','#39434F')}
    for style in [config.setdefault('style',{}),*config.get('layouts',{}).values()]:
        style['rules_sizing']=rules_sizing
        for key in ('border_mode','rules_sizing','legendary_style'):
            if controls.get(key) not in (None,'agent'):style[key]=controls[key]
        for key in ('title_padding','type_padding','alias_padding','title_offset_y','rules_offset_y','stats_x','stats_y','stats_width','stats_height'):
            if controls.get(key) is not None:style[key]=controls[key]
        if material in materials:
            style['rail_color'],style['rail_highlight'],style['rail_shadow']=materials[material]
            style['rail_finish']='engraved';style['rail_width']=max(18,style.get('rail_width',config.get('style',{}).get('rail_width',12)))
        elif material=='coloured':
            for key in ('rail_color','rail_highlight','rail_shadow'):style.pop(key,None)
            style['rail_finish']='flat'
    return config


GEOMETRY_VERSION=2


def migrate_set(config):
    """Frame sets authored before the rules panel ran down to the bottom margin (no geometry_version) placed their
    lower-edge decorations and ornaments around the old panel bottom, y=1974. Move those pieces down with the
    panel; card-edge perimeter trim and full-height pieces stay put. In place and idempotent."""
    if not isinstance(config,dict) or config.get('renderer')=='mse' or config.get('geometry_version',1)>=GEOMETRY_VERSION:return config
    from .frames import PANEL_SHIFT
    number=lambda v:isinstance(v,(int,float)) and not isinstance(v,bool)
    lower=lambda x0,y0,x1,y1:x0>=40 and x1<=1460 and 1800<=y0<=1990
    for item in config.get('decorations',[]) if isinstance(config.get('decorations'),list) else []:
        box=item.get('box') if isinstance(item,dict) else None
        if isinstance(box,list) and len(box)==4 and all(map(number,box)) and lower(*box):
            shift=max(0,min(PANEL_SHIFT,2100-box[3]));item['box']=[box[0],box[1]+shift,box[2],box[3]+shift]
    for item in config.get('ornaments',[]) if isinstance(config.get('ornaments'),list) else []:
        points=item.get('points') if isinstance(item,dict) else None
        if isinstance(points,list) and points and all(isinstance(p,list) and len(p)==2 and all(map(number,p)) for p in points):
            xs,ys=[p[0] for p in points],[p[1] for p in points]
            if lower(min(xs),min(ys),max(xs),max(ys)):item['points']=[[x,y+PANEL_SHIFT] for x,y in points]
    for style in [config.get('style',{}),*(config.get('layouts',{}) or {}).values()]:
        if isinstance(style,dict) and number(style.get('stats_y')):style['stats_y']=min(2038,style['stats_y']+PANEL_SHIFT)
    config['geometry_version']=GEOMETRY_VERSION
    return config


def validate_set(config):
    from .render import LayoutError
    migrate_set(config)
    if not isinstance(config,dict) or config.get('schema_version') not in (1,2,3):
        raise LayoutError('Frame set requires schema_version 1, 2 or 3')
    if config.get('renderer')=='mse':
        from .mse import validate_config
        validate_config(config)
        return config
    if not isinstance(config.get('name'),str) or not config['name'].strip() or len(config['name'])>120:
        raise LayoutError('Frame set needs a name of up to 120 characters')
    for key in REQUIRED_LAYOUTS[:{1:10,2:12,3:13}[config['schema_version']]]:
        if not isinstance(config.get('layouts',{}).get(key),dict):
            raise LayoutError('Missing required frame template: '+key)
    def color(value):
        if not isinstance(value,str) or len(value)!=7 or not value.startswith('#'):
            raise LayoutError('Frame colours must use #RRGGBB notation')
        try: ImageColor.getrgb(value)
        except ValueError as e: raise LayoutError('Invalid frame colour') from e
    def luminance(rgb):
        values=[v/255 for v in rgb]
        linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in values]
        return sum(v*w for v,w in zip(linear,(.2126,.7152,.0722)))
    def contrast(rgb,text):
        a,b=luminance(rgb),luminance(ImageColor.getrgb(text))
        return (max(a,b)+.05)/(min(a,b)+.05)
    for key in 'WUBRGCM':
        palette=config.get('palettes',{}).get(key)
        if not isinstance(palette,dict): raise LayoutError('Missing colour family '+key)
        for field in ('rim','header','highlight','shadow'): color(palette.get(field))
    textures=config.get('textures',{}) if isinstance(config.get('textures',{}),dict) else {}
    for style in [config.get('style',{}),*config['layouts'].values()]:
        if not isinstance(style,dict): raise LayoutError('Invalid layout style')
        merged={**config.get('style',{}),**style}
        if style.get('shape','classic') not in SHAPES: raise LayoutError('Choose a frame shape: '+', '.join(SHAPES))
        if 'shape_cut' in style and (not isinstance(style['shape_cut'],int) or not 8<=style['shape_cut']<=60):raise LayoutError('shape_cut must be 8–60 px')
        if 'shape_profile' in style:validate_profile(style['shape_profile'],LayoutError)
        if merged.get('shape')=='custom' and 'shape_profile' not in merged:raise LayoutError('A custom bar shape needs a shape_profile')
        if style.get('panel_bottom','arch') not in PANEL_BOTTOMS:raise LayoutError('panel_bottom must be one of: '+', '.join(PANEL_BOTTOMS))
        if style.get('panel_corners','square') not in PANEL_CORNERS:raise LayoutError('panel_corners must be one of: '+', '.join(PANEL_CORNERS))
        if not isinstance(style.get('panel_corner_size',24),int) or not 8<=style.get('panel_corner_size',24)<=40:raise LayoutError('panel_corner_size must be 8–40 px')
        if 'rail_texture' in style and style['rail_texture'] not in textures:raise LayoutError('rail_texture must name an entry in textures')
        if not isinstance(style.get('rail_texture_strength',.6),(int,float)) or not .05<=style.get('rail_texture_strength',.6)<=1:raise LayoutError('rail_texture_strength must be 0.05–1')
        skins=config.get('skins',{}) if isinstance(config.get('skins',{}),dict) else {}
        for key in SKIN_KEYS:
            if key in style and style[key] not in skins:raise LayoutError(key+' must name an entry in skins')
        if style.get('border_mode','borderless') not in ('borderless','bordered'):raise LayoutError('Choose bordered or borderless')
        if style.get('rules_sizing','full') not in ('fit','full'):raise LayoutError('Choose fitted or full-height rules panels')
        if style.get('legendary_style','crest') not in ('crest','minimal'):raise LayoutError('Choose crest or minimal legendary treatment')
        if style.get('rail_finish','flat') not in ('flat','metallic','engraved','foil'):raise LayoutError('Choose flat, metallic, engraved or foil rails')
        if style.get('rail_style','single') not in ('single','double','pinstripe'):raise LayoutError('Choose single, double or pinstripe rails')
        for key in ('rail_color','rail_highlight','rail_shadow'):
            if key in style:color(style[key])
        for key in ('title_padding','type_padding','alias_padding'):
            if key in style and (not isinstance(style[key],(int,float)) or not 8<=style[key]<=60):raise LayoutError('Frame padding must be between 8 and 60 px')
        for key,minimum,maximum in [('title_offset_y',-10,100),('rules_offset_y',-150,600),('stats_x',40,1280),('stats_y',1906,2038),('stats_width',180,480),('stats_height',80,160)]:
            if key in style and (not isinstance(style[key],(int,float)) or not minimum<=style[key]<=maximum):raise LayoutError('Invalid visual frame position')
        if not isinstance(style.get('rail_width',12),int) or not 4<=style.get('rail_width',12)<=36: raise LayoutError('Frame rail_width must be 4–36 px')
        if not isinstance(style.get('panel_alpha',198),int) or not 160<=style.get('panel_alpha',198)<=255: raise LayoutError('Panel opacity must be 160–255')
        for key in ('title_texture','type_texture','rules_texture','stats_texture'):
            if key in style and style[key] not in textures:raise LayoutError(key+' must name an entry in textures')
        if not isinstance(style.get('texture_strength',.5),(int,float)) or not .05<=style.get('texture_strength',.5)<=1:raise LayoutError('texture_strength must be 0.05–1')
        if not isinstance(style.get('texture_scale',1),(int,float)) or not .25<=style.get('texture_scale',1)<=4:raise LayoutError('texture_scale must be 0.25–4')
        color(style.get('panel_color','#111a17'))
        for key in ('text_color','title_text_color','type_text_color','rules_text_color'):
            if key in style:color(style[key])
        ink=lambda element:merged.get(element+'_text_color',merged.get('text_color','#f4eed8'))
        # Flat-colour checks; textured panels are additionally measured on rendered pixels (measured_contrast).
        for name,palette in config['palettes'].items():
            if contrast(ImageColor.getrgb(palette['header']),ink('title'))<4:
                raise LayoutError('Header colour needs stronger contrast with the title lettering: '+name)
        rgb=ImageColor.getrgb(merged.get('panel_color','#111a17'))
        for element,alpha in (('rules',merged.get('panel_alpha',198)),('type',235)):
            if min(contrast(tuple(round(c*alpha/255+background*(1-alpha/255)) for c in rgb),ink(element)) for background in (0,255))<4:
                raise LayoutError('The '+element+' panel needs stronger contrast with its lettering, including over bright and dark artwork')
    if 'rarity_symbol' in config:
        from .rarity import validate as validate_rarity
        validate_rarity(config['rarity_symbol'],LayoutError)
    ornaments=config.get('ornaments',[])
    if not isinstance(ornaments,list) or len(ornaments)>160: raise LayoutError('Use at most 160 frame ornaments')
    from .ornaments import KINDS,SYMBOLS,ROLES
    for item in ornaments:
        if not isinstance(item,dict) or item.get('kind') not in KINDS: raise LayoutError('Ornaments support '+', '.join(KINDS))
        for key in ('color','fill'):
            if item.get(key) is not None:color(item[key])
        for key in ('tint','fill_tint'):
            if item.get(key) is not None and item[key] not in ROLES:raise LayoutError('Ornament tints must be a palette role: '+', '.join(ROLES))
        points=item.get('points')
        if not isinstance(points,list) or not 1<=len(points)<=60 or any(not isinstance(p,list) or len(p)!=2 or any(not isinstance(n,(int,float)) for n in p) or not -50<=p[0]<=1550 or not -50<=p[1]<=2150 for p in points): raise LayoutError('Ornament points must be [x,y] pairs on the 1500x2100 card')
        if item['kind']=='symbol':
            if item.get('symbol') not in SYMBOLS:raise LayoutError('Ornament symbols: '+', '.join(SYMBOLS))
            if len(points)!=1 or not isinstance(item.get('size'),(int,float)) or not 8<=item['size']<=600:raise LayoutError('A symbol needs one centre point and a size of 8–600 px')
            if not isinstance(item.get('rotation',0),(int,float)):raise LayoutError('Symbol rotation must be a number of degrees')
        elif item['kind']=='ellipse' and len(points)!=2: raise LayoutError('Ellipse needs two bounding corners')
        elif item['kind'] in ('line','polygon') and len(points)<2:raise LayoutError('Lines and polygons need at least two points')
        if not isinstance(item.get('width',2),(int,float)) or not 1<=item.get('width',2)<=24: raise LayoutError('Ornament line width must be 1–24')
        if not isinstance(item.get('opacity',1),(int,float)) or not .05<=item.get('opacity',1)<=1:raise LayoutError('Ornament opacity must be 0.05–1')
        if item.get('layer','over') not in ('over','under'):raise LayoutError('Use under or over for ornament layering')
    from .decorations import validate as validate_decorations
    validate_decorations(config)
    return config


# Ticket notches, swallowtails and scallops cut into the bar ends at mid-height, where the lettering sits.
# The renderer moves the lettering inward by the same depth (end_depth), keeping a classic bar's 36px clearance.
END_DEPTH=32
END_CUT_SHAPES=('ticket','ribbon','scalloped')


def validate_profile(profile,error):
    """A custom bar end: [inset, t] pairs from the bar's top (t=0) to its bottom (t=1). The right end mirrors it."""
    if not isinstance(profile,list) or not 3<=len(profile)<=40 or any(not isinstance(p,list) or len(p)!=2 or any(not isinstance(v,(int,float)) for v in p) for p in profile):
        raise error('shape_profile needs 3–40 [inset, t] pairs')
    ts=[p[1] for p in profile]
    if ts[0]!=0 or ts[-1]!=1 or any(b<a for a,b in zip(ts,ts[1:])):raise error('shape_profile t values must run from 0 to 1 without going back')
    for inset,t in profile:
        if not 0<=inset<=60:raise error('shape_profile insets must be 0–60 px')
        if .25<=t<=.75 and inset>40:raise error('shape_profile insets beside the lettering (t 0.25–0.75) must be at most 40 px')


def shape_profile(style):
    """A custom bar's end profile as a hashable tuple, or None for the preset shapes."""
    profile=style.get('shape_profile') if style.get('shape')=='custom' else None
    return tuple((float(a),float(b)) for a,b in profile) if profile else None


def style_bar(style,box):
    """The outline of a title, type or stats bar for a layout style, presets and custom profiles alike."""
    return bar_shape(style.get('shape','classic'),tuple(box),style.get('shape_cut'),shape_profile(style))


def body_points(style,type_top):
    """Rules-box outline. Its top, sides and text area never move; panel_bottom and panel_corners only reshape the
    lower edge and lower corners, below the last rules line (rules_bottom keeps text above the arch top)."""
    import math
    from .frames import body_path,PANEL_BOTTOM,PANEL_SHIFT
    bottom,corners,c=style.get('panel_bottom','arch'),style.get('panel_corners','square'),style.get('panel_corner_size',24)
    if bottom=='arch' and corners=='square':return body_path(type_top)
    top=type_top+76;x1,y1=1422,PANEL_BOTTOM
    if corners=='cut':corner=[(x1,y1-c),(x1-c,y1)]
    elif corners=='rounded':corner=[(x1-c+c*math.cos(math.radians(a)),y1-c+c*math.sin(math.radians(a))) for a in range(0,91,6)]
    elif corners=='notched':corner=[(x1-c*math.sin(math.radians(a)),y1-c*math.cos(math.radians(a))) for a in range(0,91,6)]
    else:corner=[(x1,y1)]
    centre={'arch':body_path(type_top)[3:12],'flat':[],'notch':[(812,y1),(750,y1-34),(688,y1)],'step':[(812,y1),(812,y1-30),(688,y1-30),(688,y1)]}[bottom]
    return [(78,top),(x1,top),*corner,*centre,*[(1500-x,y) for x,y in reversed(corner)]]


def end_depth(shape,box,cut=None):
    """How far a bar shape cuts into its ends at mid-height (0 for shapes whose ends stay square there)."""
    h=box[3]-box[1]
    if shape=='ticket':return min(cut or 20,h/3,END_DEPTH)
    if shape=='ribbon':return min(cut or 22,END_DEPTH)
    if shape=='scalloped':return min(cut or 18,h/6*1.4,END_DEPTH)
    return 0


@lru_cache(maxsize=64)
def shape_inset(shape,box,cut=None,profile=None):
    """How far a bar outline sits inside its box beside the lettering (the middle half of the bar's height),
    beyond the 6px a classic bar's angled cap already uses. Measured from the rasterised outline, so every shape is covered."""
    import numpy as np
    if shape=='classic':return 0
    x0,y0,x1,y1=box;h=y1-y0;points=bar_shape(shape,box,cut,profile)
    mask=Image.new('L',(round(x1-x0)+1,round(h)+1));ImageDraw.Draw(mask).polygon([(x-x0,y-y0) for x,y in points],fill=255)
    rows=np.asarray(mask)[round(h/4):round(3*h/4)+1]>0
    if not rows.any(axis=1).all():return 0
    left,right=rows.argmax(axis=1).max(),rows[:,::-1].argmax(axis=1).max()
    # Sharp inward cusps (scallop joins) are thinner than a pixel row, so outline vertices count too.
    beside=[(x,y) for x,y in points if y0+h/4<=y<=y1-h/4]
    left=max([left]+[x-x0 for x,_ in beside if x<(x0+x1)/2]);right=max([right]+[x1-x for x,_ in beside if x>=(x0+x1)/2])
    return max(0,round(max(left,right))-6)


# Lettering, mana symbols and the rarity symbol keep this much clear space from a bar's inner rail edge.
TEXT_GAP=8
TITLE_TOP=18  # the highest a title bar may start
LETTER_MARGIN=36  # default anchors sit 36px inside a bar: 94 and 1406 on the 58–1442 title/type bars
PROBE='Tbdfhklgjpqy'  # tallest ascenders and deepest descenders


def rail_depth(style):
    """How far a panel's rails reach inside its outline: the rail itself plus a double rail's inner ring."""
    width=style.get('rail_width',12)
    return width+(5+max(2,width//6) if style.get('rail_style')=='double' else 0)


@lru_cache(maxsize=256)
def clear_interior(points,depth):
    """The panel interior inside its rails, as a boolean array on the logical grid with its (x, y) origin."""
    import numpy as np
    from .frames import _mask,_erode,SCALE
    mask,(ox,oy)=_mask(list(points))
    inner=np.asarray(_erode(mask,depth))[::SCALE,::SCALE]>127
    return inner,(ox/SCALE,oy/SCALE)


def clear_span(points,depth,y0,y1):
    """Leftmost and rightmost x the panel interior leaves open on every row from y0 to y1 (logical px)."""
    import numpy as np
    inner,(ox,oy)=clear_interior(tuple(map(tuple,points)),depth)
    rows=inner[max(0,int(y0-oy)):max(0,int(y1-oy)+1)]
    if not len(rows) or not rows.any(axis=1).all():return None
    return ox+rows.argmax(axis=1).max(),ox+rows.shape[1]-1-rows[:,::-1].argmax(axis=1).max()


def clear_height(points,depth):
    """Top and bottom y of the panel interior at its horizontal centre (logical px)."""
    import numpy as np
    inner,(ox,oy)=clear_interior(tuple(map(tuple,points)),depth)
    column=inner[:,inner.shape[1]//2]
    if not column.any():return None
    return oy+column.argmax(),oy+len(column)-1-column[::-1].argmax()


def content_extent(element):
    """How far a bar's contents reach above and below its centre at the largest type size."""
    from .render import font
    from .typography import ink_bounds
    face=font('alias',45) if element=='alias' else font('title',80 if element=='title' else 57)
    _,top,_,bottom=ink_bounds(PROBE,face)
    if element=='alias':return (bottom-top)/2,(bottom-top)/2  # aliases centre on their visible ink
    _,cap_top,_,cap_bottom=ink_bounds('T',face);centre=(cap_top+cap_bottom)/2
    symbol=36 if element=='title' else 28  # mana symbols (68px with shadow); rarity glyph (50px plus outline)
    return max(centre-top,symbol),max(bottom-centre,symbol)


def bar_points(card,element,box):
    style=layout_style(card)
    if element=='alias':
        x0,y0,x1,y1=box;return [(x0,y0),(x1,y0),(x1-42,y1),(x0+42,y1)]
    return style_bar(style,box)


def fit_bar(card,element,box,floor=None):
    """Grow a title, type or alias bar until its rails leave room for the lettering and symbols.
    Title bars grow evenly about their centre, type bars upwards (so the rules panel stays put), alias tabs downwards."""
    import math
    if not card.get('frame_style'):return box
    depth=rail_depth(layout_style(card));above,below=content_extent(element)
    for _ in range(6):
        x0,y0,x1,y1=box
        if element=='alias':
            # The tab's top edge sits under the title bar; its text box starts at floor (the title bar's bottom).
            clear=clear_height(bar_points(card,element,box),depth)
            bottom=clear[1] if clear else y0
            centre=(floor+y1)/2
            grow=max(0,math.ceil(2*((centre+below)-(bottom-TEXT_GAP))),math.ceil(2*((floor+TEXT_GAP)-(centre-above))))
            if not grow:return box
            box=(x0,y0,x1,y1+grow);continue
        clear=clear_height(bar_points(card,element,box),depth)
        centre=(y0+y1)/2
        need=max(0,(clear[0]+TEXT_GAP)-(centre-above),(centre+below)-(clear[1]-TEXT_GAP)) if clear else above+below
        grow=math.ceil(need)
        if not grow:return box
        if element=='title':
            # Near the card's top edge the title bar grows downwards instead.
            top=max(TITLE_TOP,y0-grow);box=(x0,top,x1,y1+grow+(top-(y0-grow)))
        else:box=(x0,y0-2*grow,x1,y1)
    return box


def text_inset(card,element,geometry):
    """Extra left/right lettering margin a frame set's bar needs on the title or type bar: its shape's end cuts
    and its rails, measured on the rows the lettering and symbols occupy."""
    import math
    if not card.get('frame_style'):return 0
    style=layout_style(card);box=tuple(geometry[element])
    cut=shape_inset(style.get('shape','classic'),box,style.get('shape_cut'),shape_profile(style))
    above,below=content_extent(element);centre=(box[1]+box[3])/2
    span=clear_span(bar_points(card,element,box),rail_depth(style),centre-above,centre+below)
    if span is None:return cut
    need=max(span[0]+TEXT_GAP-(box[0]+LETTER_MARGIN),(box[2]-LETTER_MARGIN)-(span[1]-TEXT_GAP),0)
    return max(cut,math.ceil(need))


def rules_inset(card):
    """Extra left/right margin for rules text, so a rules panel's thick or double rails never touch it.
    The panel starts at x=78 and rules text at x=106."""
    if not card.get('frame_style'):return 0
    return max(0,78+rail_depth(layout_style(card))+TEXT_GAP-106)


def rules_bottom(card,bottom):
    """Lowest rules line-box bottom on a frame set: the last line's ink (about 10px above it) stays clear of the
    rails along the panel's bottom arch, whose top is 40px above the panel bottom."""
    from .frames import PANEL_BOTTOM
    if not card.get('frame_style'):return bottom
    return min(bottom,PANEL_BOTTOM-40-rail_depth(layout_style(card))-TEXT_GAP+10)


def alias_text_box(card,geometry):
    """The original-name text box, narrowed so the name stays clear of the tab's angled, railed ends."""
    import math
    box=geometry['alias_text']
    if not card.get('frame_style'):return box
    above,below=content_extent('alias');centre=(box[1]+box[3])/2
    span=clear_span(bar_points(card,'alias',geometry['alias']),rail_depth(layout_style(card)),centre-above,centre+below)
    if span is None:return box
    inset=max(0,math.ceil(max(span[0]+TEXT_GAP-box[0],box[2]-(span[1]-TEXT_GAP))))
    return (box[0]+inset,box[1],box[2]-inset,box[3])


def stats_box(card,box):
    """Grow a power/toughness box evenly until its rails leave room for statistics at the 48px floor."""
    import math
    from .render import font
    from .typography import ink_bounds
    if not card.get('frame_style'):return box
    style=layout_style(card);depth=rail_depth(style)
    face=font('title',48);_,top,_,bottom=ink_bounds('0123456789/',face);half=(bottom-top)/2
    stats=f"{card.get('power','')}/{card.get('toughness','')}";bounds=ink_bounds(stats,face);width=max(face.getlength(stats),bounds[2]-min(0,bounds[0]))
    for _ in range(4):
        x0,y0,x1,y1=box;points=style_bar(style,box)
        clear=clear_height(points,depth);centre=(y0+y1)/2
        grow=math.ceil(max(0,(clear[0]+TEXT_GAP)-(centre-half),(centre+half)-(clear[1]-TEXT_GAP)) if clear else 2*half)
        span=clear_span(points,depth,centre-half,centre+half) if not grow else None
        # Wide statistics widen the box leftwards, keeping its right edge where the editor placed it.
        widen=math.ceil(max(0,width-(span[1]-span[0]-2*TEXT_GAP))) if span else 0
        if not grow and not widen:return box
        box=(x0-widen,y0-grow,x1,y1+grow)
    return box


def stats_area(card,box):
    """The open interior of a power/toughness box: (x0, y0, x1, y1) where the statistics may be lettered."""
    if not card.get('frame_style'):return (box[0]+23,box[1]+12,box[2]-23,box[3]-12)
    style=layout_style(card);depth=rail_depth(style)
    points=style_bar(style,box)
    clear=clear_height(points,depth)
    if not clear:return (box[0]+23,box[1]+12,box[2]-23,box[3]-12)
    top,bottom=clear[0]+TEXT_GAP,clear[1]-TEXT_GAP
    span=clear_span(points,depth,top,bottom)
    left,right=(span[0]+TEXT_GAP,span[1]-TEXT_GAP) if span else (box[0]+23,box[2]-23)
    return (left,top,right,bottom)


def bar_shape(shape,box,cut=None,profile=None):
    """Outline for a title/type/stats bar. Every shape stays inside its measured box, so text anchors never move."""
    import math
    from .frames import bar_path
    x0,y0,x1,y1=box;h=y1-y0;mid=(y0+y1)/2
    if shape=='classic':return bar_path(box)
    if shape=='custom':
        # Designer-drawn end silhouette (brackets, ogees, arrow points, double notches...), mirrored on the right.
        profile=profile or ((12,0),(0,.5),(12,1))
        return [(x1-inset,y0+t*h) for inset,t in profile]+[(x0+inset,y0+t*h) for inset,t in reversed(profile)]
    if shape in ('rounded','pill'):
        radius=h/2 if shape=='pill' else min(cut or 26,h/2);points=[]
        for cx,cy,start in [(x1-radius,y0+radius,-90),(x1-radius,y1-radius,0),(x0+radius,y1-radius,90),(x0+radius,y0+radius,180)]:
            points.extend((cx+radius*math.cos(math.radians(start+angle)),cy+radius*math.sin(math.radians(start+angle))) for angle in range(0,91,6))
        return points
    if shape=='stepped':
        # Art-deco double step at each corner.
        c=min(cut or 24,h/3);s=c/2
        return [(x0+c,y0),(x1-c,y0),(x1-c,y0+s),(x1-s,y0+s),(x1-s,y0+c),(x1,y0+c),(x1,y1-c),(x1-s,y1-c),(x1-s,y1-s),(x1-c,y1-s),(x1-c,y1),(x0+c,y1),(x0+c,y1-s),(x0+s,y1-s),(x0+s,y1-c),(x0,y1-c),(x0,y0+c),(x0+s,y0+c),(x0+s,y0+s),(x0+c,y0+s)]
    if shape=='ticket':
        # Square ends with semicircular notches, like a raffle ticket or casino voucher.
        r=end_depth(shape,box,cut);points=[(x0,y0),(x1,y0)]
        points.extend((x1-r*math.sin(math.radians(a)),mid-r*math.cos(math.radians(a))) for a in range(0,181,10))
        points.extend([(x1,y1),(x0,y1)])
        points.extend((x0+r*math.sin(math.radians(a)),mid+r*math.cos(math.radians(a))) for a in range(0,181,10))
        return points
    if shape=='ribbon':
        # Swallowtail banner ends; the notch depth is capped so it never reaches lettering.
        c=end_depth(shape,box,cut)
        return [(x0,y0),(x1,y0),(x1-c,mid),(x1,y1),(x0,y1),(x0+c,mid)]
    if shape=='scalloped':
        # Three outward scallops on each end, contained within the box.
        r=h/6;inset=end_depth(shape,box,cut);points=[(x0+inset,y0),(x1-inset,y0)]
        for i in range(3):
            cy=y0+r*(2*i+1)
            points.extend((x1-inset+inset*math.sin(math.radians(a)),cy-r*math.cos(math.radians(a))) for a in range(0,181,15))
        points.append((x0+inset,y1))
        for i in range(3):
            cy=y1-r*(2*i+1)
            points.extend((x0+inset-inset*math.sin(math.radians(a)),cy+r*math.cos(math.radians(a))) for a in range(0,181,15))
        return points
    c=cut or 23
    return [(x0+c,y0),(x1-c,y0),(x1,y0+c),(x1,y1-c),(x1-c,y1),(x0+c,y1),(x0,y1-c),(x0,y0+c)]


def foil(size,origin,base,highlight,shadow):
    """Diagonal metallic sheen bands for foil rails, continuous across the whole card."""
    import numpy as np
    w,h=size;x0,y0=origin
    yy,xx=np.mgrid[y0:y0+h,x0:x0+w]
    t=np.abs(((xx+yy)/420.0)%2-1)[...,None]
    b,l,s=(np.array(ImageColor.getrgb(c),dtype=float) for c in (base,highlight,shadow))
    rgb=np.where(t<.5,s+(b-s)*(t/.5),b+(l-b)*((t-.5)/.5))
    return Image.fromarray(rgb.astype('uint8'),'RGB')


@lru_cache(maxsize=16)
def _texture_canvas(path,sha,scale):
    with Image.open(path) as tile:
        tile=tile.convert('RGB')
        if scale!=1:tile=tile.resize((max(8,round(tile.width*scale)),max(8,round(tile.height*scale))),Image.Resampling.LANCZOS)
    canvas=Image.new('RGB',(3000,4200))
    for y in range(0,4200,tile.height):
        for x in range(0,3000,tile.width):canvas.paste(tile,(x,y))
    return canvas


def panel_texture(config,name,scale,size,origin,tint=None):
    """Tiled material for a panel, aligned to the card so adjacent panels share one surface. Tinted textures follow the panel's colour."""
    from .decorations import asset_path
    item=config['textures'][name];path=asset_path(config,item)
    canvas=_texture_canvas(str(path),item.get('sha256',''),float(scale))
    x0,y0=origin;crop=canvas.crop((max(0,x0),max(0,y0),max(0,x0)+size[0],max(0,y0)+size[1]))
    if tint:
        rgb=ImageColor.getrgb(tint)
        dark=tuple(round(c*.45) for c in rgb);light=tuple(round(c+(255-c)*.4) for c in rgb)
        crop=ImageOps.colorize(crop.convert('L'),black=dark,mid=rgb,white=light)
    return crop


def _repeat(piece,width,height):
    """Repeat a piece at its native size to fill width x height (one copy on axes that already match)."""
    if piece.size==(width,height):return piece
    out=Image.new('RGBA',(width,height))
    for y in range(0,height,piece.height):
        for x in range(0,width,piece.width):out.alpha_composite(piece,(x,y))
    return out


def nine_slice(image,size,slices,fill='stretch',scale=1.0):
    """Fit a painted panel to size (print px) the way game UIs do: the four corners keep their painted size, the
    edges run along the sides and the centre fills the rest, so a burned parchment edge or stitched leather border
    survives any panel height. slices=[left, top, right, bottom] in source px; fill 'stretch' or 'tile'."""
    width,height=size
    if scale!=1:
        image=image.resize((max(1,round(image.width*scale)),max(1,round(image.height*scale))),Image.Resampling.LANCZOS);slices=[round(v*scale) for v in slices]
    left,top,right,bottom=slices
    shrink=min(1,width/max(1,left+right),height/max(1,top+bottom))
    if shrink<1:
        image=image.resize((max(1,round(image.width*shrink)),max(1,round(image.height*shrink))),Image.Resampling.LANCZOS);left,top,right,bottom=[round(v*shrink) for v in (left,top,right,bottom)]
    W,H=image.size;out=Image.new('RGBA',(width,height))
    for sx0,sx1,dx0,dx1 in ((0,left,0,left),(left,W-right,left,width-right),(W-right,W,width-right,width)):
        for sy0,sy1,dy0,dy1 in ((0,top,0,top),(top,H-bottom,top,height-bottom),(H-bottom,H,height-bottom,height)):
            if sx1<=sx0 or sy1<=sy0 or dx1<=dx0 or dy1<=dy0:continue
            piece=image.crop((sx0,sy0,sx1,sy1));target=(dx1-dx0,dy1-dy0)
            if fill=='tile':
                # Keep painted detail at its native size; only an axis that is fixed (corners, edge depth) is fitted.
                fixed=(target[0] if sx0==0 or sx1==W else piece.width,target[1] if sy0==0 or sy1==H else piece.height)
                piece=_repeat(piece if piece.size==fixed else piece.resize(fixed,Image.Resampling.LANCZOS),*target)
            elif piece.size!=target:piece=piece.resize(target,Image.Resampling.LANCZOS)
            out.alpha_composite(piece,(dx0,dy0))
    return out


@lru_cache(maxsize=24)
def _skin_source(path,sha):
    with Image.open(path) as image:return image.convert('RGBA')


def panel_skin(config,name,size,tint=None):
    """A painted, non-repeating panel surface fitted to one panel's bounds: nine-slice when slices are given,
    otherwise scaled to cover. Tinted skins follow the panel's colour like tinted textures."""
    from .decorations import asset_path
    item=config['skins'][name];source=_skin_source(str(asset_path(config,item)),item.get('sha256',''))
    image=nine_slice(source,size,item['slice'],item.get('fill','stretch'),item.get('scale',1)) if item.get('slice') else ImageOps.fit(source,size,Image.Resampling.LANCZOS)
    if tint and item.get('tint'):
        rgb=ImageColor.getrgb(tint);alpha=image.getchannel('A')
        image=ImageOps.colorize(image.convert('L'),black=tuple(round(c*.45) for c in rgb),mid=rgb,white=tuple(round(c+(255-c)*.4) for c in rgb)).convert('RGBA');image.putalpha(alpha)
    return image


def layout_style(card):
    config=migrate_set(card.get('frame_style') or {})
    kind=layout_kind(card)
    fallback=config.get('layouts',{}).get('enchantment',{}) if kind in ('saga','class') else config.get('layouts',{}).get('creature',{}) if kind in ('adventure','prepare') else {}
    return {**config.get('style',{}),**config.get('layouts',{}).get(kind,fallback)}


def layout_kind(card):
    if 'Saga' in card.get('type_line',''):return 'saga'
    if 'Class' in card.get('type_line',''):return 'class'
    if card.get('layout') in ('adventure','prepare'): return card['layout']
    if card.get('face_label'): return 'transform_'+card['face_label']
    if card.get('layout')=='token': return 'token'
    for name in ('Planeswalker','Creature','Land','Artifact','Enchantment','Instant','Sorcery'):
        if name in card['type_line']: return name.lower()
    return 'artifact'


def text_color(card,element='rules'):
    """Lettering colour for one surface: title (header-filled bars, stats, cost shields), type bar or rules panel."""
    from .frames import CONFIG
    style=layout_style(card)
    return style.get(element+'_text_color',style.get('text_color',CONFIG['ink']))


def custom_frame(card,type_top,output_scale=1):
    config=validate_set(card['frame_style'])
    from .geometry import boxes
    geometry=boxes(card,type_top)
    has_alias=bool(card.get('display_name') and card['display_name']!=card['name'])
    geometry['art']=[94,round((geometry['alias'][3] if has_alias else geometry['title'][3])+22),1406,round(geometry['type'][1]-22)]
    return _build(json.dumps(config,sort_keys=True),card.get('colors',[]) and ''.join(sorted(set(card['colors']))) or 'C',
                  'Legendary' in card['type_line'],layout_kind(card),type_top,bool(card.get('display_name') and card['display_name']!=card['name']),
                  'loyalty' if 'loyalty' in card else 'stats' if 'power' in card else '',json.dumps(geometry),output_scale).copy()


@lru_cache(maxsize=8)
def _build(serialized,colors,legendary,kind,type_top,alias,stats,geometry_json,output_scale=1):
    from .frames import _mask,_erode,_paint,TITLE_BOX,type_box,bar_path,body_path,alias_path,crown_path,loyalty_shield
    config=json.loads(serialized)
    style={**config.get('style',{}),**config['layouts'].get(kind,config['layouts'].get('creature',{}))}
    geometry=json.loads(geometry_json)
    palette=config['palettes'][colors if colors in 'WUBRGC' and len(colors)==1 else 'M']
    layer=Image.new('RGBA',(3000,4200))
    bordered=style.get('border_mode')=='bordered'
    if bordered:
        draw=ImageDraw.Draw(layer)
        draw.rectangle((0,0,3000,4200),fill='#111111')
        draw.rounded_rectangle((64,64,2936,4136),radius=105,fill=palette['rim'])
        left,top,right,bottom=geometry['art']
        draw.rectangle((left*2-12,top*2-12,right*2+12,bottom*2+12),fill=palette['shadow'])
        draw.rectangle((left*2,top*2,right*2,bottom*2),fill=(0,0,0,0))
    from .decorations import apply as apply_decorations,safe_mask
    from .ornaments import draw as draw_ornaments
    safe=safe_mask(layer.size,geometry,type_top,stats)
    apply_decorations(layer,config,geometry,type_top,kind,legendary,'under',stats,palette,safe)
    draw_ornaments(layer,config,palette,kind,legendary,'under',safe)
    def shaped(box):
        return style_bar(style,box)
    def skin(tile,name,region,fill,alpha):
        # Painted surface clipped to the panel (or its interior), at the panel's opacity.
        box=region.getbbox()
        if not box:return
        image=panel_skin(config,name,(box[2]-box[0],box[3]-box[1]),fill)
        cover=Image.new('RGBA',tile.size);cover.alpha_composite(image,(box[0],box[1]))
        clip=ImageChops.multiply(cover.getchannel('A'),region)
        if alpha!=255:clip=clip.point(lambda v:round(v*alpha/255))
        cover.putalpha(clip);tile.alpha_composite(cover)
    def panel(points,fill,alpha=255,texture=None,surface=None):
        mask,origin=_mask(points);tile=Image.new('RGBA',mask.size)
        shadow=style.get('rail_shadow',palette['shadow']);highlight=style.get('rail_highlight',palette['highlight'])
        _paint(tile,shadow,mask);rail=_erode(mask,3)
        if style.get('rail_color') and style.get('rail_finish')=='foil':
            _paint(tile,foil(mask.size,origin,style['rail_color'],highlight,shadow),rail)
        elif style.get('rail_color'):
            base=ImageColor.getrgb(style['rail_color'])
            if style.get('rail_finish','flat')!='flat':
                light=ImageColor.getrgb(highlight);dark=ImageColor.getrgb(shadow);gradient=Image.new('RGB',(1,mask.height))
                for y in range(mask.height):
                    t=y/max(1,mask.height-1);a,b,u=(light,base,t*2) if t<.5 else (base,dark,(t-.5)*2)
                    gradient.putpixel((0,y),tuple(round(x+(z-x)*u) for x,z in zip(a,b)))
                _paint(tile,gradient.resize(mask.size),rail)
            else:_paint(tile,style['rail_color'],rail)
        elif len(colors)==2:
            left=ImageColor.getrgb(config['palettes'][colors[0]]['rim']);right=ImageColor.getrgb(config['palettes'][colors[1]]['rim'])
            gradient=Image.new('RGB',(mask.width,1));gradient.putdata([tuple(round(a+(b-a)*(x+origin[0])/2999) for a,b in zip(left,right)) for x in range(mask.width)])
            _paint(tile,gradient.resize(mask.size),rail)
        else:_paint(tile,palette['rim'],rail)
        light=ImageChops.subtract(rail,ImageChops.offset(rail,4,4));_paint(tile,highlight,light,240)
        width=style.get('rail_width',12)
        if style.get('rail_texture'):
            # Hammered metal, carved wood, braided leather... painted across the rail band.
            name=style['rail_texture'];band=ImageChops.subtract(rail,_erode(mask,width))
            _paint(tile,panel_texture(config,name,style.get('texture_scale',1),mask.size,origin,(style.get('rail_color') or palette['rim']) if config['textures'][name].get('tint',True) else None),band,round(255*style.get('rail_texture_strength',.6)))
        if style.get('rail_finish')=='engraved':
            groove=ImageChops.subtract(_erode(mask,max(5,width//2)),_erode(mask,max(5,width//2)+2));_paint(tile,shadow,groove,230)
        if style.get('rail_color'):
            accent=ImageChops.subtract(_erode(mask,max(4,width-3)),_erode(mask,width));_paint(tile,palette['rim'],accent)
        if style.get('rail_style')=='pinstripe':
            stripe=ImageChops.subtract(_erode(mask,max(4,width//2-1)),_erode(mask,max(4,width//2-1)+1));_paint(tile,highlight,stripe,235)
        inner=_erode(mask,width);tile.paste((0,0,0,0),(0,0),inner);_paint(tile,fill,inner,alpha)
        if texture:
            name=style.get(texture+'_texture')
            if name:_paint(tile,panel_texture(config,name,style.get('texture_scale',1),mask.size,origin,fill if config['textures'][name].get('tint',True) else None),inner,round(alpha*style.get('texture_strength',.5)))
        skin_name=style.get((surface or texture or '')+'_skin') if (surface or texture) else None
        covers=skin_name and config['skins'][skin_name].get('covers_rails')
        if skin_name and not covers:skin(tile,skin_name,inner,fill,alpha)
        if style.get('rail_style')=='double':
            ring=ImageChops.subtract(_erode(mask,width+5),_erode(mask,width+5+max(2,width//6)))
            _paint(tile,style.get('rail_color',palette['rim']),ring);_paint(tile,highlight,ImageChops.subtract(ring,ImageChops.offset(ring,2,2)),200)
        if covers:skin(tile,skin_name,mask,fill,max(alpha,235))
        layer.alpha_composite(tile,origin)
    if legendary and style.get('legendary_style','crest')=='crest':
        scale=(geometry['title'][3]-geometry['title'][1])/132
        panel([(x,(geometry['title'][1]+geometry['title'][3])/2+(y-120)*scale) for x,y in crown_path()],palette['rim'],surface='crest')
    panel(body_points(style,type_top),style.get('panel_color','#111a17'),style.get('panel_alpha',198),'rules')
    if alias:
        x0,y0,x1,y1=geometry['alias'];panel([(x0,y0),(x1,y0),(x1-42,y1),(x0+42,y1)],palette['header'],max(235,style.get('panel_alpha',198)),'title',surface='alias')
    panel(shaped(geometry['title']),palette['header'],245 if style.get('panel_alpha',198)<255 else 255,'title')
    panel(shaped(geometry['type']),style.get('panel_color','#111a17'),max(235,style.get('panel_alpha',198)),'type')
    if stats=='loyalty': panel(loyalty_shield(),palette['header'],255,'stats')
    elif stats: panel(shaped(geometry['stats']),palette['header'],255,'stats')
    draw_ornaments(layer,config,palette,kind,legendary,'over',safe)
    apply_decorations(layer,config,geometry,type_top,kind,legendary,'over',stats,palette,safe)
    if bordered:
        mask=Image.new('L',layer.size,0);ImageDraw.Draw(mask).rounded_rectangle((64,64,2936,4136),radius=105,fill=255)
        clipped=Image.new('RGBA',layer.size,'#111111');clipped.paste(layer,(0,0),mask);layer=clipped
    return layer if output_scale==2 else layer.resize((1500,2100),Image.Resampling.LANCZOS)


def preview_card(kind,config,colors=None,legendary=None,alias=False):
    card={'id':kind,'name':kind.replace('_',' ').title()+' Preview','mana_cost':'{2}{G}',
          'type_line':'Creature — Cat','oracle_text':'Whenever this creature attacks, draw a card.','colors':['G'],
          'rarity':'rare','frame_style':config}
    if config is None:card.pop('frame_style')
    if kind=='creature': card.update(power='2',toughness='3')
    elif kind=='planeswalker': card.update(type_line='Legendary Planeswalker — Preview',oracle_text='+1: Draw a card.\n−2: Create a 2/2 green Cat creature token.\n−7: You gain 10 life.',loyalty='3')
    elif kind in ('adventure','prepare'):
        card.update(layout=kind,power='2',toughness='3',oracle_text='This creature enters prepared.' if kind=='prepare' else 'Whenever this creature attacks, draw a card.',spell={'id':'preview-spell','name':'Prepared Insight' if kind=='prepare' else 'A New Adventure','mana_cost':'{1}{U}','type_line':'Instant' if kind=='prepare' else 'Sorcery — Adventure','oracle_text':'Draw two cards.','colors':['U']})
    elif kind=='saga':card.update(layout='saga',type_line='Enchantment — Saga',oracle_text='(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI, II — Create a Treasure token.\nIII — Draw two cards.')
    elif kind=='land': card.update(type_line='Basic Land — Forest',mana_cost='',oracle_text='{T}: Add {G}.')
    elif kind=='token': card.update(type_line='Token Creature — Cat',layout='token',mana_cost='',oracle_text='',power='1',toughness='1')
    elif kind.startswith('transform_'): card.update(face_label=kind.split('_')[1],type_line='Creature — Cat',power='2',toughness='2')
    else: card.update(type_line=kind.title(),oracle_text='Draw two cards.')
    if colors is not None:
        card['colors']=colors
        if kind not in ('land','token','transform_back'):card['mana_cost']='{2}'+''.join('{'+c+'}' for c in colors)
    if legendary is True and not card['type_line'].startswith('Legendary '):card['type_line']='Legendary '+card['type_line']
    if legendary is False:card['type_line']=card['type_line'].replace('Legendary ','')
    if alias:card['display_name']='Custom Display Name'
    return card


def measured_contrast(config):
    """Worst-case lettering contrast on the rendered frame (textures and under-layers included), over black and white art.

    Returns {element: lowest 10th-percentile contrast}. Rules lettering needs 4.0; title and type bars 3.5.
    """
    import numpy as np
    from .render import LayoutError,text_plan,PROFILES
    from .frames import frame_for
    lowest={}
    for family in 'WUBRGCM':
        colors=[] if family=='C' else ['W','U','R'] if family=='M' else [family]
        for legendary in (False,):
            card=preview_card('creature',config,colors,legendary)
            plan=text_plan(card);type_top=plan.get('type_top',PROFILES[card.get('profile','standard')])
            from .geometry import boxes
            geometry=boxes(card,type_top)
            frame=frame_for(card,type_top).convert('RGBA')
            # Sample inside the rails, where lettering actually sits.
            inset=layout_style(card).get('rail_width',12)+8
            regions={'title':(110,geometry['title'][1]+inset,1180,geometry['title'][3]-inset),'type':(110,geometry['type'][1]+inset,1300,geometry['type'][3]-inset),'rules':(120,type_top+120,1380,min(1890,type_top+330))}
            if family!='W':regions.pop('type');regions.pop('rules')
            for background in (0,255):
                base=Image.new('RGBA',frame.size,(background,)*3+(255,));base.alpha_composite(frame)
                rgb=np.asarray(base.convert('RGB'),dtype=float)/255
                linear=np.where(rgb<=.04045,rgb/12.92,((rgb+.055)/1.055)**2.4)@np.array([.2126,.7152,.0722])
                for element,box in regions.items():
                    x0,y0,x1,y1=[round(v*frame.width/1500) for v in box]
                    if x1<=x0 or y1<=y0:continue
                    ink=text_color(card,element)
                    text=np.array(ImageColor.getrgb(ink),dtype=float)/255
                    text=float((np.where(text<=.04045,text/12.92,((text+.055)/1.055)**2.4)*np.array([.2126,.7152,.0722])).sum())
                    area=linear[y0:y1,x0:x1]
                    ratio=(np.maximum(area,text)+.05)/(np.minimum(area,text)+.05)
                    value=float(np.percentile(ratio,10))
                    lowest[element]=min(lowest.get(element,99),value)
    for element,minimum in (('rules',4.0),('title',3.5),('type',3.5)):
        if lowest.get(element,99)<minimum:
            raise LayoutError(f'Measured {element} lettering contrast is {lowest[element]:.2f}:1 on the rendered panel (needs {minimum}:1). Reduce texture_strength or under-layer detail, or adjust panel/text colours.')
    return {k:round(v,2) for k,v in lowest.items()}


# Ornaments may overhang a bar, panel or rail edge by this much (logical px), but never sit out in the illustration.
FRAME_MARGIN=24
# Printed showcase frames often run a thin decorative edge around the whole card; that perimeter band counts as frame.
FRAME_EDGE=72


def frame_zone(frame):
    """Where ornaments and decorations may paint: the rendered frame (rails, bars, panels, crest, border), grown by
    FRAME_MARGIN, plus the card's outer FRAME_EDGE band."""
    alpha=frame.getchannel('A').point(lambda v:255 if v>16 else 0)
    small=alpha.resize((alpha.width//4,alpha.height//4),Image.Resampling.BOX).point(lambda v:255 if v else 0)
    zone=small.filter(ImageFilter.MaxFilter(2*(FRAME_MARGIN//4)+1)).resize(alpha.size,Image.Resampling.NEAREST)
    edge=round(FRAME_EDGE*alpha.width/1500);ImageDraw.Draw(zone).rectangle((0,0,alpha.width-1,alpha.height-1),outline=255,width=edge)  # outline grows inward
    return zone


def art_intrusions(config,limit=.1):
    """Real Magic frames keep the illustration clear: report ornaments and painted decorations whose painted
    pixels fall more than `limit` outside the frame zone on any structure where they apply."""
    import numpy as np
    from .render import render,LayoutError
    from .frames import frame_for
    from .ornaments import draw as draw_ornaments
    from .decorations import apply as apply_decorations
    plain={**config,'ornaments':[],'decorations':[]};palette=config['palettes']['R'];size=(1500,2100);full=Image.new('L',size,255)
    painted=[]
    # Positions are absolute, so each item is painted once and compared with every structure's frame zone.
    for label,key in (('Ornament','ornaments'),('Decoration','decorations')):
        for i,item in enumerate(config.get(key,[])):
            bare={k:v for k,v in item.items() if k not in ('layouts','legendary')};bare['layer']='over';canvas=Image.new('RGBA',size)
            if label=='Ornament':draw_ornaments(canvas,{'ornaments':[bare]},palette,'creature',False,'over',full,scale=1)
            else:apply_decorations(canvas,{**config,'decorations':[bare]},None,0,'creature',False,'over','',palette,full)
            box=canvas.getchannel('A').getbbox()
            if box:painted.append((label,i,item,box,np.asarray(canvas.getchannel('A').crop(box),dtype=float)))
    zones={}
    def zone(kind,legendary):
        if (kind,legendary) not in zones:
            # The frame layer alone (no art vignette), at the rules height the real render measured.
            card=preview_card(kind,plain,['R'],legendary);type_top=render(card,frame_only=True)[1]['type_top']
            zones[(kind,legendary)]=np.asarray(frame_zone(frame_for(card,type_top).convert('RGBA').resize(size)),dtype=float)/255
        return zones[(kind,legendary)]
    worst={}
    for label,i,item,(x0,y0,x1,y1),alpha in painted:
        for kind in REQUIRED_LAYOUTS:
            if item.get('layouts') and kind not in item['layouts']:continue
            # A legendary crest only adds frame area, so non-legendary cards are the strict case for unfiltered items.
            legendary=item.get('legendary',False)
            try:inside=zone(kind,legendary)[y0:y1,x0:x1]
            except LayoutError:continue  # e.g. tokens have no legendary preview
            share=float((alpha*(1-inside)).sum()/alpha.sum())
            if share>limit and share>worst.get((label,i),(0,))[0]:worst[(label,i)]=(share,kind,legendary,item)
    problems=[]
    for (label,i),(share,kind,legendary,item) in sorted(worst.items()):
        what=item.get('symbol') or item.get('kind') or item.get('image','')
        problems.append(f"{label} {i+1} ({what}) sits over the illustration on {kind.replace('_',' ')}{' legendary' if legendary else ''} cards ({share:.0%} of it is off the frame). Ornaments and decorations must sit on the rails, bars, panels or border, never in the art.")
    return problems


def check_and_preview(config,destination):
    from .render import render,font
    if config is not None: validate_set(config)
    destination=Path(destination);destination.mkdir(parents=True,exist_ok=True)
    previews=[]
    for index,kind in enumerate(REQUIRED_LAYOUTS):
        card=preview_card(kind,config)
        image,report=render(card);target=destination/(kind+'.png');image.save(target);previews.append(target)
        from .frames import frame_for
        (render(card,frame_only=True)[0] if kind in ('adventure','prepare','saga') or (config or {}).get('renderer')=='mse' else frame_for(card,report['type_top'])).save(destination/(kind+'.frame.png'))
    sheet=Image.new('RGB',(5*320+20,((len(previews)+4)//5)*480+20),'#18241e')
    for i,path in enumerate(previews):
        with Image.open(path) as image: sheet.paste(image.resize((300,420),Image.Resampling.LANCZOS),(20+(i%5)*320,20+(i//5)*480))
        ImageDraw.Draw(sheet).text((24+(i%5)*320,451+(i//5)*480),REQUIRED_LAYOUTS[i].replace('_',' '),font=font('collector',21),fill='white')
    sheet.save(destination/'contact-sheet.jpg',quality=94)
    colour_variants=colour_matrix(config,destination)
    # Magic Set Editor templates carry their own printed colour schemes; the contrast probe measures cardforge panels.
    contrast=measured_contrast(config) if config is not None and config.get('renderer')!='mse' else None
    result={'colour_variants':colour_variants,'measured_contrast':contrast,'valid':True,'layouts':list(REQUIRED_LAYOUTS),'colour_families':['W','U','B','R','G','C','M'],'previews':[str(p) for p in previews],'proof_path':str(destination/'contact-sheet.jpg')}
    (destination/'validation.json').write_text(json.dumps(result,indent=2));return result


def colour_matrix(config,destination):
    from .frames import KINDS
    from .render import render,font
    destination=Path(destination);destination.mkdir(parents=True,exist_ok=True)
    sheet=Image.new('RGB',(7*230+20,5*355+20),'#18241e');records=[]
    for family in KINDS:
        colors=[] if family=='C' else ['W','U','R'] if family=='M' else list(family)
        for legendary in (False,True):
            key=family+'-'+('legendary' if legendary else 'normal')
            card=preview_card('creature',config,colors,legendary)
            card['name']=family+' Frame Preview'
            image,_=render(card);image=image.resize((210,294),Image.Resampling.LANCZOS)
            image.save(destination/('colour-'+key+'.jpg'),quality=92)
            i=len(records);x,y=20+(i%7)*230,20+(i//7)*355
            sheet.paste(image,(x,y));ImageDraw.Draw(sheet).text((x,y+302),key,font=font('collector',18),fill='white')
            records.append({'family':family,'legendary':legendary,'file':'colour-'+key+'.jpg'})
    sheet.save(destination/'colour-matrix.jpg',quality=94);return records
