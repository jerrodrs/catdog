"""Deterministic vector ornaments and motif symbols for frame sets.

Ornaments are drawn on the 2x frame layer and masked away from the measured lettering
and statistics regions of each card, so they may sit over artwork without touching text.
"""
import math
from functools import lru_cache
from PIL import Image, ImageDraw, ImageChops, ImageFilter

KINDS = ('line', 'polygon', 'ellipse', 'symbol')
SYMBOLS = ('spade', 'heart', 'diamond', 'club', 'star', 'sparkle', 'chip', 'coin', 'crown', 'die', 'moon', 'leaf', 'gear')
ROLES = ('rim', 'highlight', 'shadow', 'header')
SUPERSAMPLE = 4


def colour(item, palette, key):
    """Resolve a fixed colour or a palette role (so motifs follow each card's colour identity)."""
    tint = item.get(key + '_tint') if key != 'color' else item.get('tint')
    if tint:
        return palette[tint]
    return item.get(key)


@lru_cache(maxsize=256)
def symbol_mask(name, size, rotation=0):
    """Antialiased 'L' mask of a motif symbol whose unit design spans size x size pixels."""
    n = size * SUPERSAMPLE / 2
    image = Image.new('L', (round(2*n), round(2*n)))
    d = ImageDraw.Draw(image)
    # Unit coordinates span [-1, 1]; translate into the supersampled canvas.
    def p(points):
        return [((x+1)*n, (y+1)*n) for x, y in points]
    def circle(cx, cy, r, fill=255):
        d.ellipse(((cx+1-r)*n, (cy+1-r)*n, (cx+1+r)*n, (cy+1+r)*n), fill=fill)
    if name == 'diamond':
        d.polygon(p([(0, -1), (.72, 0), (0, 1), (-.72, 0)]), fill=255)
    elif name == 'heart':
        circle(-.46, -.38, .5); circle(.46, -.38, .5)
        d.polygon(p([(-.94, -.22), (.94, -.22), (0, .96)]), fill=255)
    elif name == 'spade':
        circle(-.44, .18, .48); circle(.44, .18, .48)
        d.polygon(p([(-.9, .06), (.9, .06), (0, -1)]), fill=255)
        d.polygon(p([(0, .2), (.32, 1), (-.32, 1)]), fill=255)
    elif name == 'club':
        circle(0, -.5, .4); circle(-.48, .1, .4); circle(.48, .1, .4)
        d.polygon(p([(0, -.1), (.3, 1), (-.3, 1)]), fill=255)
    elif name in ('star', 'sparkle'):
        points, inner = (5, .4) if name == 'star' else (4, .2)
        d.polygon(p([((1 if i % 2 == 0 else inner)*math.sin(i*math.pi/points), -(1 if i % 2 == 0 else inner)*math.cos(i*math.pi/points)) for i in range(points*2)]), fill=255)
    elif name == 'chip':
        circle(0, 0, 1)
        for i in range(8):
            a = i*math.pi/4
            c, s = math.cos(a), math.sin(a)
            d.polygon(p([(c*.78-s*.11, s*.78+c*.11), (c*1.02-s*.11, s*1.02+c*.11), (c*1.02+s*.11, s*1.02-c*.11), (c*.78+s*.11, s*.78-c*.11)]), fill=0)
        circle(0, 0, .66, 0); circle(0, 0, .58)
    elif name == 'coin':
        circle(0, 0, 1); circle(0, 0, .84, 0); circle(0, 0, .74)
    elif name == 'crown':
        d.polygon(p([(-1, .7), (1, .7), (1, -.35), (.5, .12), (0, -.85), (-.5, .12), (-1, -.35)]), fill=255)
    elif name == 'die':
        d.rounded_rectangle(p([(-1, -1), (1, 1)]), radius=.28*n, fill=255)
        for x, y in ((-.5, -.5), (.5, .5), (0, 0), (.5, -.5), (-.5, .5)):
            circle(x, y, .15, 0)
    elif name == 'moon':
        circle(0, 0, 1); circle(.42, -.22, .86, 0)
    elif name == 'leaf':
        side = [(.62*4*(s/20)*(1-s/20), 2*s/20-1) for s in range(21)]
        d.polygon(p(side + [(-x, y) for x, y in reversed(side)]), fill=255)
    elif name == 'gear':
        circle(0, 0, .74)
        for i in range(8):
            a = i*math.pi/4
            c, s = math.cos(a), math.sin(a)
            d.polygon(p([(c*.6-s*.16, s*.6+c*.16), (c*1-s*.13, s*1+c*.13), (c*1+s*.13, s*1-c*.13), (c*.6+s*.16, s*.6-c*.16)]), fill=255)
        circle(0, 0, .3, 0)
    else:
        raise ValueError('Unknown ornament symbol ' + name)
    if rotation:
        image = image.rotate(-rotation, resample=Image.Resampling.BICUBIC, expand=True)
    return image.resize((max(1, round(image.width/SUPERSAMPLE)), max(1, round(image.height/SUPERSAMPLE))), Image.Resampling.LANCZOS)


def _draw_item(item, palette, scale):
    """Render one ornament onto a tightly cropped RGBA tile; returns (tile, origin)."""
    stroke = colour(item, palette, 'color') or '#ffffff'
    fill = colour(item, palette, 'fill')
    width = max(1, round(item.get('width', 2)*scale))
    points = [(x*scale, y*scale) for x, y in item['points']]
    if item['kind'] == 'symbol':
        size = round(item['size']*scale)
        mask = symbol_mask(item['symbol'], size, item.get('rotation', 0))
        tile = Image.new('RGBA', mask.size)
        tile.paste(fill or stroke, (0, 0), mask)
        if fill and (item.get('color') or item.get('tint')):
            # Outline the filled motif in the stroke colour, grown outward from its mask.
            grown = Image.new('L', (mask.width+2*width, mask.height+2*width))
            grown.paste(mask, (width, width))
            grown = grown.filter(ImageFilter.MaxFilter(2*(width//2)+1))
            framed = Image.new('RGBA', grown.size, stroke)
            framed.putalpha(grown)
            framed.alpha_composite(tile, (width, width))
            tile = framed
        cx, cy = points[0]
        return tile, (round(cx - tile.width/2), round(cy - tile.height/2))
    pad = width + 2
    x0, y0 = min(x for x, _ in points) - pad, min(y for _, y in points) - pad
    x1, y1 = max(x for x, _ in points) + pad, max(y for _, y in points) + pad
    tile = Image.new('RGBA', (max(1, round(x1-x0)), max(1, round(y1-y0))))
    d = ImageDraw.Draw(tile)
    local = [(x-x0, y-y0) for x, y in points]
    if item['kind'] == 'line':
        d.line(local, fill=stroke, width=width, joint='curve')
    elif item['kind'] == 'polygon':
        d.polygon(local, fill=fill, outline=stroke, width=width)
    else:
        d.ellipse((local[0], local[1]), fill=fill, outline=stroke, width=width)
    return tile, (round(x0), round(y0))


def draw(layer, config, palette, kind, legendary, position, safe, scale=2):
    """Composite the ornaments for one layer position, masked to the safe (non-text) area."""
    items = [item for item in config.get('ornaments', []) if item.get('layer', 'over') == position
             and not (item.get('layouts') and kind not in item['layouts'])
             and not ('legendary' in item and item['legendary'] != legendary)]
    if not items:
        return
    canvas = Image.new('RGBA', layer.size)
    for item in items:
        tile, origin = _draw_item(item, palette, scale)
        if item.get('opacity', 1) != 1:
            tile.putalpha(tile.getchannel('A').point(lambda v, o=item['opacity']: round(v*o)))
        canvas.alpha_composite(tile, (max(0, origin[0]), max(0, origin[1])), (max(0, -origin[0]), max(0, -origin[1])))
    canvas.putalpha(ImageChops.multiply(canvas.getchannel('A'), safe))
    layer.alpha_composite(canvas)
