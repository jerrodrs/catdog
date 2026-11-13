"""Frame-set rarity symbols.

A frame set may define its own vector rarity glyph (`rarity_symbol`) styled to match the frame. The renderer
colours it per rarity like a printed expansion symbol: black for common, silver for uncommon, gold for rare and
orange-red for mythic, with a dark outline (a light one on common so it reads on dark type bars).
"""
from functools import lru_cache
import json
from PIL import Image, ImageDraw, ImageChops, ImageFilter

SIZE = 50  # logical px; the glyph's [-1, 1] unit square maps onto this box beside the type line
OUTLINE = 2.5
RARITIES = {
    'common': ('#3a3e40', '#202628', '#111416'),
    'uncommon': ('#eef4f5', '#a9b5b7', '#5f6b6c'),
    'rare': ('#fbe8ae', '#c99c45', '#7d5a24'),
    'mythic': ('#ffd08c', '#e2622b', '#962611'),
}
OUTLINES = {'common': '#ece6d6'}
SHAPES = ('polygon', 'circle', 'symbol')
SUPERSAMPLE = 4


def validate(spec, error):
    """Raise error(message) unless spec is a legible vector glyph."""
    if not isinstance(spec, dict) or not isinstance(spec.get('shapes'), list) or not 1 <= len(spec['shapes']) <= 24:
        raise error('rarity_symbol needs 1–24 shapes')
    if not isinstance(spec.get('name', ''), str) or len(spec.get('name', '')) > 60:
        raise error('rarity_symbol name must be up to 60 characters')
    from .ornaments import SYMBOLS
    unit = lambda v: isinstance(v, (int, float)) and -1.2 <= v <= 1.2
    for i, shape in enumerate(spec['shapes']):
        kind = shape.get('shape') if isinstance(shape, dict) else None
        if kind not in SHAPES:
            raise error(f'rarity_symbol shape {i} must be one of {", ".join(SHAPES)}')
        if not isinstance(shape.get('cut', False), bool):
            raise error(f'rarity_symbol shape {i} cut must be true or false')
        if kind == 'polygon':
            points = shape.get('points')
            if not isinstance(points, list) or not 3 <= len(points) <= 64 or not all(isinstance(p, list) and len(p) == 2 and unit(p[0]) and unit(p[1]) for p in points):
                raise error(f'rarity_symbol polygon {i} needs 3–64 [x, y] points within -1.2..1.2')
        else:
            centre = shape.get('center')
            if not isinstance(centre, list) or len(centre) != 2 or not all(unit(v) for v in centre):
                raise error(f'rarity_symbol shape {i} needs a center within -1.2..1.2')
            if kind == 'circle' and not (isinstance(shape.get('r'), (int, float)) and .04 <= shape['r'] <= 1.2):
                raise error(f'rarity_symbol circle {i} radius must be 0.04–1.2')
            if kind == 'symbol':
                if shape.get('symbol') not in SYMBOLS:
                    raise error(f'rarity_symbol shape {i} symbol must be one of {", ".join(SYMBOLS)}')
                if not (isinstance(shape.get('size'), (int, float)) and .1 <= shape['size'] <= 2.4):
                    raise error(f'rarity_symbol symbol {i} size must be 0.1–2.4')
                if not isinstance(shape.get('rotation', 0), (int, float)):
                    raise error(f'rarity_symbol symbol {i} rotation must be a number')
    coverage = sum(mask(json.dumps(spec, sort_keys=True), 64).getdata()) / 255 / 64 / 64
    if not .12 <= coverage <= .85:
        raise error(f'rarity_symbol covers {coverage:.0%} of its box; keep it between 12% and 85% so it reads as a solid glyph at card size')


@lru_cache(maxsize=32)
def mask(serialized, size):
    """Antialiased 'L' mask of the glyph on a size x size square; shapes add in order, cut shapes subtract."""
    from .ornaments import symbol_mask
    spec = json.loads(serialized)
    n = size * SUPERSAMPLE
    canvas = Image.new('L', (n, n))
    d = ImageDraw.Draw(canvas)
    at = lambda x, y: ((x+1)/2*n, (y+1)/2*n)
    for shape in spec['shapes']:
        fill = 0 if shape.get('cut') else 255
        if shape['shape'] == 'polygon':
            d.polygon([at(x, y) for x, y in shape['points']], fill=fill)
        elif shape['shape'] == 'circle':
            (cx, cy), r = at(*shape['center']), shape['r']/2*n
            d.ellipse((cx-r, cy-r, cx+r, cy+r), fill=fill)
        else:
            glyph = symbol_mask(shape['symbol'], max(1, round(shape['size']/2*size)), shape.get('rotation', 0))
            glyph = glyph.resize((glyph.width*SUPERSAMPLE, glyph.height*SUPERSAMPLE), Image.Resampling.LANCZOS)
            cx, cy = at(*shape['center'])
            stamp = Image.new('L', (n, n))
            stamp.paste(glyph, (round(cx-glyph.width/2), round(cy-glyph.height/2)))
            canvas = ImageChops.subtract(canvas, stamp) if shape.get('cut') else ImageChops.lighter(canvas, stamp)
            d = ImageDraw.Draw(canvas)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def tile(spec, rarity, scale=1):
    """The coloured, outlined glyph at native pixel scale, with the (logical) padding added around SIZE."""
    size = round(SIZE*scale)
    shape = mask(json.dumps(spec, sort_keys=True), size)
    pad = round(OUTLINE*scale) + 1
    full = Image.new('L', (size+2*pad, size+2*pad))
    full.paste(shape, (pad, pad))
    grown = full.filter(ImageFilter.MaxFilter(2*round(OUTLINE*scale)+1))
    light, base, dark = RARITIES.get(rarity, RARITIES['rare'])
    # Diagonal sheen: highlight at the top left through the base colour to shadow at the bottom right.
    gradient = Image.linear_gradient('L').rotate(45, resample=Image.Resampling.BICUBIC, expand=True).resize(full.size)
    upper = Image.composite(Image.new('RGB', full.size, base), Image.new('RGB', full.size, light), gradient.point(lambda v: min(255, v*2)))
    colour = Image.composite(Image.new('RGB', full.size, dark), upper, gradient.point(lambda v: max(0, v*2-255)))
    out = Image.new('RGBA', full.size, OUTLINES.get(rarity, '#101414'))
    out.putalpha(grown)
    body = colour.convert('RGBA'); body.putalpha(full)
    out.alpha_composite(body)
    return out, pad/scale
