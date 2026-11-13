"""Reusable code-native frames with coloured rims, bevels and legendary crowns.

These are original template paths, not image-model output or traced card scans.
Geometry is supersampled for smooth print edges; selected frames are cached.
"""
import json
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageColor

ROOT = Path(__file__).resolve().parent.parent
PALETTE_PATH = ROOT/'assets/frame-palettes.json'
CONFIG = json.loads(PALETTE_PATH.read_text())
PALETTES = CONFIG['colors']
SIZE = (1500, 2100)
SCALE = 2
PAIRS = ('WU', 'UB', 'BR', 'RG', 'GW', 'WB', 'UR', 'BG', 'RW', 'GU')
KINDS = tuple('WUBRGC') + PAIRS + ('M',)
TITLE_BOX = (58, 54, 1442, 186)
ALIAS_BOX = (96, TITLE_BOX[3]-8, 1404, TITLE_BOX[3]+68)
ALIAS_TEXT_BOX = (152, TITLE_BOX[3], 1348, ALIAS_BOX[3])


def type_box(type_top):
    # Grow upwards so the approved rules panel and its text stay exactly in place.
    return (58, type_top-20, 1442, type_top+90)


def template_key(card):
    colors = set(card.get('colors', [])) - {'C'}
    if len(colors) == 2:
        color = next(pair for pair in PAIRS if set(pair) == colors)
    else:
        color = next(iter(colors)) if len(colors) == 1 else ('M' if colors else 'C')
    legendary = 'Legendary' in card['type_line'].split(' — ')[0].split()
    return f"{color}-{'legendary' if legendary else 'normal'}"


def palette(color):
    return PALETTES[color] if len(color) == 1 else PALETTES['M']


def _rgb(value):
    return ImageColor.getrgb(value)


def _mix(a, b, t):
    return tuple(round(x+(y-x)*t) for x, y in zip(a, b))


def bar_path(box):
    """Flat horizontal rails with curved, subtly pointed ends like the references."""
    x0, y0, x1, y1 = box
    mid = (y0+y1)/2
    points = [(x0+24, y0), (x1-24, y0)]
    # Elliptical outer ends, not a generic rounded UI rectangle.
    import math
    for i in range(25):
        angle = -math.pi/2 + math.pi*i/24
        points.append((x1-24+24*math.cos(angle), mid+(y1-y0)/2*math.sin(angle)))
    points.append((x0+24, y1))
    for i in range(25):
        angle = math.pi/2 + math.pi*i/24
        points.append((x0+24+24*math.cos(angle), mid+(y1-y0)/2*math.sin(angle)))
    return points


def alias_path():
    """An inset, tapered nameplate whose top edge tucks under the title rail."""
    x0, y0, x1, y1 = ALIAS_BOX
    return [(x0, y0), (x1, y0), (x1-42, y1), (x0+42, y1)]


def crown_path():
    """Raised central arch with symmetric shoulders and pointed corner fins."""
    top = [(30, 158), (30, 102), (42, 64), (57, 34), (91, 57),
           (152, 66), (193, 64), (225, 31), (260, 52), (338, 65),
           (470, 55), (620, 33), (635, 44)]
    # Gentle continuous arch at the centre instead of a zigzag crown.
    for i in range(21):
        x = 635+230*i/20
        top.append((x, 44-19*(1-((x-750)/115)**2)))
    top += [(880, 33), (1030, 55), (1162, 65), (1240, 52),
            (1275, 31), (1307, 64), (1348, 66), (1409, 57),
            (1443, 34), (1458, 64), (1470, 102), (1470, 158),
            (1435, 168), (1424, 193), (1350, 183), (1120, 184),
            (750, 178), (380, 184), (150, 183), (76, 193), (65, 168)]
    return top


def body_path(type_top):
    # Centre arch provides the reference's familiar bottom-frame contour.
    return [(78, type_top+76), (1422, type_top+76), (1422, 1974),
            (856, 1974), (832, 1956), (805, 1942), (778, 1936),
            (750, 1934), (722, 1936), (695, 1942), (668, 1956),
            (644, 1974), (78, 1974)]


def _mask(points):
    x0 = int(min(x for x, _ in points)*SCALE)-2*SCALE
    y0 = int(min(y for _, y in points)*SCALE)-2*SCALE
    x1 = int(max(x for x, _ in points)*SCALE)+2*SCALE+1
    y1 = int(max(y for _, y in points)*SCALE)+2*SCALE+1
    mask = Image.new('L', (x1-x0, y1-y0))
    ImageDraw.Draw(mask).polygon([(round(x*SCALE)-x0, round(y*SCALE)-y0) for x, y in points], fill=255)
    return mask, (x0, y0)


def _erode(mask, distance):
    # Directional mask inset. Zero-padded shifts prevent wraparound at pointed tips.
    distance = round(distance*SCALE)
    out = mask.copy()
    for dx, dy in ((distance, distance), (distance, -distance), (-distance, distance), (-distance, -distance)):
        shifted = Image.new('L', mask.size)
        shifted.paste(mask, (dx, dy))
        out = ImageChops.darker(out, shifted)
    return out


def _gradient(color, layer, dimensions, origin_x=0):
    p = palette(color)
    left = _rgb(PALETTES[color[0]]['rim'] if len(color) == 2 else p['rim'])
    right = _rgb(PALETTES[color[1]]['rim'] if len(color) == 2 else p['rim'])
    width, height = dimensions
    strip = Image.new('RGB', (width, 1))
    strip.putdata([_mix(left, right, (x+origin_x)/(SIZE[0]*SCALE-1)) for x in range(width)])
    if layer == 'header':
        # A restrained vertical highlight on coloured bars.
        light = _mix(_rgb(p['header']), (255, 255, 235), .12)
        dark = _mix(_rgb(p['header']), (0, 0, 0), .13)
        vertical = Image.new('RGB', (1, 120))
        for y in range(120):
            vertical.putpixel((0, y), _mix(light, dark, y/119))
        return vertical.resize(dimensions)
    return strip.resize(dimensions)


def _paint(layer, color, mask, opacity=255):
    fill = Image.new('RGBA', layer.size, color) if isinstance(color, str) else color.convert('RGBA')
    if opacity != 255:
        mask = mask.point(lambda value: round(value*opacity/255))
    fill.putalpha(mask)
    layer.alpha_composite(fill)


def _bevel(layer, points, color, fill, alpha=255, rim=12):
    """Outer keyline → coloured rail → directional light/shadow → inner keyline."""
    mask, origin = _mask(points)
    tile = Image.new('RGBA', mask.size)
    _paint(tile, '#080e0d', mask)
    rail = _erode(mask, 3)
    _paint(tile, _gradient(color, 'rim', mask.size, origin[0]), rail)
    inner = _erode(mask, rim)
    # Rim face is lit from the upper left; highlights follow the shape contour.
    light_edge = ImageChops.subtract(rail, ImageChops.offset(rail, 3*SCALE, 3*SCALE))
    dark_edge = ImageChops.subtract(rail, ImageChops.offset(rail, -3*SCALE, -3*SCALE))
    _paint(tile, palette(color)['highlight'], light_edge, 235)
    _paint(tile, palette(color)['shadow'], dark_edge, 245)
    _paint(tile, '#111816', inner)
    surface = _erode(mask, rim+3)
    # Leave the interior transparent on frame exports and darken only once.
    tile.paste((0, 0, 0, 0), (0, 0), surface)
    if fill in ('header', 'rim'):
        fill = _gradient(color, fill, mask.size, origin[0])
    _paint(tile, fill, surface, alpha)
    glint = ImageChops.subtract(surface, ImageChops.offset(surface, 0, 2*SCALE))
    _paint(tile, '#f0ead1', glint, 105)
    layer.alpha_composite(tile, origin)


@lru_cache(maxsize=8)
def _build(key, type_top, alias, stats, output_scale=1):
    color, variant = key.split('-')
    layer = Image.new('RGBA', (SIZE[0]*SCALE, SIZE[1]*SCALE))
    if variant == 'legendary':
        _bevel(layer, crown_path(), color, 'rim', 255, 6)
    # Rules first so its rails join cleanly beneath the type bar.
    _bevel(layer, body_path(type_top), color, CONFIG['panel_fill'], CONFIG['panel_alpha'], 12)
    if alias:
        # Paint behind the header: its hidden top rail joins the two components.
        _bevel(layer, alias_path(), color, '#282d28', 226, 7)
    _bevel(layer, bar_path(TITLE_BOX), color, 'header', 245, 12)
    _bevel(layer, bar_path(type_box(type_top)), color, '#171c1b', 222, 12)
    if stats:
        if stats == 'loyalty':
            _bevel(layer, [(1220,1906),(1442,1906),(1442,1980),(1331,2040),(1220,1980)], color, 'header', 250, 11)
        else:
            _bevel(layer, bar_path((1176, 1916, 1442, 2018)), color, 'header', 250, 11)
    return layer if output_scale==2 else layer.resize(SIZE, Image.Resampling.LANCZOS)


def frame_for(card, type_top, output_scale=1):
    if card.get('frame_style'):
        from .template_sets import custom_frame
        return custom_frame(card,type_top,output_scale)
    key = template_key(card)
    alias = bool(card.get('display_name') and card['display_name'] != card['name'])
    return _build(key, type_top, alias, 'loyalty' if 'loyalty' in card else 'power' in card,output_scale).copy()


def export_library(destination):
    """Materialise the same cached templates used by production rendering."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    variants = []
    for color in KINDS:
        for legendary in (False, True):
            key = f"{color}-{'legendary' if legendary else 'normal'}"
            filename = key+'.png'
            _build(key, 1280, True, True).save(destination/filename, dpi=(600, 600))
            variants.append({'id': key, 'file': filename, 'colors': list(color) if len(color) == 2 else color,
                             'legendary': legendary, 'profile': 'standard', 'alias': True, 'stats': True})
    manifest = {'version': CONFIG['version'], 'dimensions': list(SIZE), 'templates': variants,
                'note': 'Base proofs include alias and stats. Production selects those components per card.'}
    (destination/'index.json').write_text(json.dumps(manifest, indent=2)+'\n')
    return variants
