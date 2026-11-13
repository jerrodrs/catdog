"""Dedicated loyalty-ability layout; shared fonts and original frame family."""
import math
import re
from PIL import ImageDraw
from .typography import cap_center, centered_text
from .frames import LOYALTY_SHIFT


def ability_blocks(text):
    result = []
    for line in text.split('\n'):
        match = re.match(r'^([+−-]?(?:\d+|X)):\s*(.*)$', line)
        result.append({'cost': match[1] if match else None, 'text': match[2] if match else line})
    return result


def text_plan(card):
    from .render import wrap, LayoutError
    from .geometry import BODY_SIZES,planning_type_top
    type_top = planning_type_top(card,780 if card.get('profile') == 'dense' else 950)
    top, bottom = type_top + 118, 1870+LOYALTY_SHIFT
    from .template_sets import rules_inset
    inset = rules_inset(card)
    for size in (s for s in BODY_SIZES if s<=56):
        scale=size/64
        ability_gap=round(24*scale)
        leading, y, blocks = math.ceil(size * 1.13), top, []
        for ability in ability_blocks(card['oracle_text']):
            left = 240 if ability['cost'] is not None else 106 + inset
            lines = wrap(ability['text'], size, 1394 - inset - left, italic_phrases=card.get('italic_phrases', []))
            height = max(math.ceil(90*scale) if ability['cost'] is not None else 0, len(lines) * leading)
            blocks.append({**ability, 'left': left, 'top': y, 'height': height, 'lines': lines})
            y += height + ability_gap
        if blocks:
            y -= ability_gap
        flavor = wrap(card.get('flavor_text', ''), size, 1288 - 2*inset, True)
        flavor_gap=round(38*scale)
        flavor_top = y + (flavor_gap if flavor and blocks else 0)
        height = flavor_top + len(flavor) * leading - top
        if height <= bottom - top:
            return {'size': size, 'leading': leading, 'rules': [line for b in blocks for line in b['lines']],
                    'flavor': flavor, 'gap': flavor_gap, 'ability_gap':ability_gap, 'top': top, 'bottom': bottom, 'height': height,
                    'ability_blocks': blocks, 'type_top': type_top, 'flavor_top': flavor_top}
    raise LayoutError('Planeswalker abilities + flavour overflow within the 40% height limit at the 36px readability floor. Retain all Oracle text.')


def draw(image, card, plan, alignment):
    from .render import font, fitted, symbol, advance
    from .template_sets import text_color
    TEXT=text_color(card);HEADER_TEXT=text_color(card,'title')
    def lines_at(lines, left, top):
        y = top
        for line in lines:
            x = left
            for token, role in line:
                baseline = round(y) + font('body', plan['size']).getmetrics()[0]
                if token.startswith('{'):
                    size = round(plan['size'] * .82)
                    center = cap_center(font('body', plan['size']), baseline)
                    symbol_y = round(center - (size + 1) / 2)
                    image.alpha_composite(symbol(token[1:-1], size), (round(x), symbol_y))
                    alignment.setdefault('inline_symbols', []).append({'token': token, 'disc_center_y': symbol_y+(size+1)/2, 'text_cap_center_y': center, 'baseline': baseline})
                else:
                    ImageDraw.Draw(image).text((round(x), baseline), token, font=font(role, plan['size']), fill=TEXT, anchor='ls')
                x += advance(token, role, plan['size'])
            y += plan['leading']
    for index, block in enumerate(plan['ability_blocks']):
        d = ImageDraw.Draw(image)
        if index:
            divider=block['top']-plan['ability_gap']/2
            d.line((106, divider, 1394, divider), fill='#b4bca278', width=2)
        if block['cost'] is not None:
            scale=plan['size']/64
            y = block['top'] + 4*scale
            points = [(143+(x-143)*scale,y+h*scale) for x,h in [(92,0),(192,0),(211,37),(192,78),(92,78),(75,37)]]
            colors=card.get('colors',[]);key=colors[0] if len(colors)==1 else 'M' if colors else 'C'
            palette=card.get('frame_style',{}).get('palettes',{}).get(key,{})
            d.polygon(points, fill=palette.get('header','#15271f'), outline=palette.get('highlight','#b4c59b'), width=3)
            cost_font = fitted('title', block['cost'], round(61*scale), round(48*scale), 102*scale)
            alignment.setdefault('loyalty_abilities', []).append({'cost':block['cost'], 'box':[143-68*scale,y,143+68*scale,y+78*scale], 'text':block['text']})
            centered_text(d,(143-63*scale,y+2*scale,143+63*scale,y+76*scale),block['cost'],cost_font,HEADER_TEXT,align='center')
        lines_at(block['lines'],block['left'],block['top'])
    if plan['flavor']:
        d=ImageDraw.Draw(image)
        d.line((106,plan['flavor_top']-plan['gap']/2,1394,plan['flavor_top']-plan['gap']/2),fill='#c7c2ad',width=2)
        from .template_sets import rules_inset
        lines_at(plan['flavor'],106+rules_inset(card),plan['flavor_top'])
    loyalty_font=fitted('title',str(card['loyalty']),78,48,150)
    alignment['loyalty']=centered_text(ImageDraw.Draw(image),(1230,1914+LOYALTY_SHIFT,1430,2010+LOYALTY_SHIFT),str(card['loyalty']),loyalty_font,HEADER_TEXT,align='center')
