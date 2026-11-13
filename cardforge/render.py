"""All card structure is typeset locally. No network or image generation here."""
from __future__ import annotations

import hashlib
import json
import math
import re
from functools import lru_cache
from pathlib import Path

import PIL
from PIL import Image, ImageDraw, ImageFont, ImageOps, features
from .frames import CONFIG as FRAME_CONFIG, PALETTE_PATH, TITLE_BOX, ALIAS_TEXT_BOX, type_box, frame_for, template_key
from .typography import cap_center, centered_text, centered_origin, ink_bounds

ROOT = Path(__file__).resolve().parent.parent
W, H = 1500, 2100
DPI = 600
VERSION = 'borderless-v2.5'
from .color import to_srgb, SRGB_PROFILE
from .resolution import canvas as new_canvas, wrap as wrap_canvas, unwrap, resolution, SCALE
FONTS = {
    'title': ROOT / 'assets/fonts/Beleren2016-Bold.ttf',
    'body': ROOT / 'assets/fonts/PlantinMTProRg.TTF',
    'italic': ROOT / 'assets/fonts/PlantinMTProRgIt.TTF',
    'symbol': ROOT / 'assets/fonts/mana.ttf',
    'alias': ROOT / 'assets/fonts/PlantinMTProSemiBdIt.TTF',
    'collector': ROOT / 'assets/fonts/Gotham-Medium.otf',
    'artist': ROOT / 'assets/fonts/Beleren2016SmallCaps-Bold.ttf',
}
COLORS = {'W': '#f8edcf', 'U': '#a8cddd', 'B': '#b6a8b9',
          'R': '#e4a58c', 'G': '#a7c6a0', 'C': '#cdc6b8'}
INK = '#171919'
TEXT = FRAME_CONFIG['ink']
PROFILES = {'standard': 1280, 'dense': 1100}
SYMBOL_ALIASES = {'T': 'tap', 'Q': 'untap', 'CHAOS': 'chaos', '∞': 'infinity'}


class LayoutError(ValueError):
    pass


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@lru_cache(maxsize=256)
def font(role, size):
    path = FONTS[role]
    if not path.is_file():
        raise LayoutError(f'Missing required {role} font: {path}; no fallback permitted')
    return ImageFont.truetype(str(path), size, layout_engine=ImageFont.Layout.BASIC)


@lru_cache(maxsize=1)
def glyphs():
    css = (ROOT / 'assets/mana.css').read_text()
    result = {}
    for selectors, code in re.findall(r'([^{}]+)\{\s*content:\s*"\\([0-9a-f]+)";\s*\}', css):
        for name in re.findall(r'\.ms-([\w-]+)::before', selectors):
            result[name] = chr(int(code, 16))
    return result


def symbol_key(token):
    key = SYMBOL_ALIASES.get(token, token.lower())
    if key not in glyphs():
        raise LayoutError(f'Unsupported symbol {{{token}}}; supply a supported symbol asset')
    return key


def validate_symbols(text):
    for token in re.findall(r'\{([^{}]+)\}', text):
        if '/' in token:
            parts = token.split('/')
            if len(parts) not in (2, 3) or any(p not in 'W U B R G P 2 C'.split() for p in parts):
                raise LayoutError(f'Unsupported hybrid symbol {{{token}}}')
            for p in parts:
                symbol_key(p)
        else:
            symbol_key(token)
    if '{' in re.sub(r'\{[^{}]+\}', '', text) or '}' in re.sub(r'\{[^{}]+\}', '', text):
        raise LayoutError('Unbalanced symbol braces')


def validate(card):
    allowed = {'id', 'name', 'display_name', 'mana_cost', 'type_line', 'oracle_text',
               'flavor_text', 'colors', 'color_identity', 'power', 'toughness', 'loyalty',
               'layout', 'profile', 'art', 'art_focus', 'art_credit', 'collector_number',
               'set_code', 'rarity', 'quantity', 'commander', 'source', 'art_prompt', 'provenance', 'italic_phrases', 'faces', 'face_label', 'frame_style', 'spell'}
    unknown = set(card) - allowed
    if unknown:
        raise LayoutError(f'Unknown card fields: {sorted(unknown)}')
    if card.get('frame_style'):
        from .template_sets import validate_set
        validate_set(card['frame_style'])
    if card.get('layout') in ('transform', 'modal_dfc'):
        if not isinstance(card.get('faces'), list) or len(card['faces']) != 2:
            raise LayoutError('Double-faced cards require exactly two complete faces')
        for key in ('id','name'):
            if not isinstance(card.get(key),str) or not card[key].strip():
                raise LayoutError('Double-faced card requires id and name')
        for face in card['faces']:
            if face.get('layout') not in (None,'normal','planeswalker','token','saga','class'):
                raise LayoutError('Unsupported nested face layout')
            validate(face)
        if card['faces'][0]['id']==card['faces'][1]['id']:
            raise LayoutError('Double-faced card face IDs must differ')
        return
    for key in ('id', 'name', 'type_line', 'oracle_text'):
        if not isinstance(card.get(key), str) or (key != 'oracle_text' and not card[key].strip()):
            raise LayoutError(f'{key} must be a string' )
    for key in ('name', 'display_name', 'type_line'):
        if '\n' in card.get(key, '') or '\r' in card.get(key, ''):
            raise LayoutError(f'{key} must be a single line')
    for phrase in card.get('italic_phrases', []):
        if not isinstance(phrase, str) or not phrase or phrase not in card['oracle_text']:
            raise LayoutError('italic_phrases must contain nonempty substrings of oracle_text')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]*', card['id']):
        raise LayoutError('id must contain only letters, numbers, underscores and hyphens')
    if card.get('layout', 'normal') not in ('normal', 'token', 'planeswalker', 'adventure', 'prepare','saga','class'):
        raise LayoutError('Special layouts require a dedicated template; do not flatten them')
    if card.get('layout') == 'token' and (not card['type_line'].startswith('Token ') or card.get('mana_cost')):
        raise LayoutError('Token layout requires a Token type line and no mana cost')
    if 'Battle' in card['type_line']:
        raise LayoutError('This card type needs a dedicated template')
    if card.get('layout')=='class' and 'Class' not in card['type_line']:raise LayoutError('Class layout requires a Class type line')
    if 'Class' in card['type_line']:
        from .class_layout import blocks as class_blocks
        class_blocks(card['oracle_text'])
    if card.get('layout')=='saga' and 'Saga' not in card['type_line']:raise LayoutError('Saga layout requires a Saga type line')
    if 'Saga' in card['type_line']:
        from .saga import blocks
        blocks(card['oracle_text'])
    if card.get('profile', 'standard') not in PROFILES:
        raise LayoutError('Unknown layout profile')
    if any(x not in COLORS for x in card.get('colors', [])):
        raise LayoutError('Invalid frame color')
    if ('power' in card) != ('toughness' in card):
        raise LayoutError('Power and toughness must be provided together')
    if 'Creature' in card['type_line'] and 'power' not in card:
        raise LayoutError('Creature requires power and toughness')
    if 'Planeswalker' in card['type_line']:
        if 'loyalty' not in card or not re.fullmatch(r'(?:\d+|X)',str(card['loyalty'])):
            raise LayoutError('Planeswalker requires starting loyalty')
        if 'power' in card:
            raise LayoutError('Planeswalker cannot use a creature statistics box')
    elif 'loyalty' in card:
        raise LayoutError('Loyalty requires a planeswalker type line')
    if card.get('layout')=='planeswalker' and 'Planeswalker' not in card['type_line']:
        raise LayoutError('Planeswalker layout requires a planeswalker type line')
    if card.get('layout') in ('adventure','prepare'):
        spell=card.get('spell')
        if not isinstance(spell,dict):raise LayoutError('Adventure and prepare cards require an inset spell object')
        if spell.get('art') or spell.get('faces') or spell.get('spell'):raise LayoutError('Inset spells share the parent artwork and cannot contain nested faces')
        if not any(t in spell.get('type_line','') for t in ('Instant','Sorcery')):raise LayoutError('Inset spell requires an instant or sorcery type line')
        validate({**spell,'id':spell.get('id',card['id']+'-spell'),'layout':'normal'})
    elif card.get('spell') is not None:raise LayoutError('Inset spells require adventure or prepare layout')
    cost = card.get('mana_cost', '')
    if re.sub(r'\{[^{}]+\}', '', cost):
        raise LayoutError('Mana cost must use brace notation, e.g. {2}{W}{U}')
    for key in ('mana_cost', 'oracle_text', 'flavor_text'):
        validate_symbols(card.get(key, ''))
    focus = card.get('art_focus', [0.5, 0.5])
    if len(focus) != 2 or any(not isinstance(v, (int, float)) or not 0 <= v <= 1 for v in focus):
        raise LayoutError('art_focus requires two numbers between 0 and 1')


def tokens(text, italic=False, italic_phrases=()):
    """Symbols are indivisible. Parenthetical reminder text becomes italic."""
    depth = 0
    spans = [match.span() for phrase in italic_phrases for match in re.finditer(re.escape(phrase), text)]
    for match in re.finditer(r'\{[^{}]+\}|\n|[^\S\n]+|[^\s{}]+', text):
        part = match.group()
        role = 'italic' if italic or depth or '(' in part or any(a <= match.start() < b for a, b in spans) else 'body'
        yield (part, role)
        depth = max(0, depth + part.count('(') - part.count(')'))


def advance(token, role, size):
    return size * 0.96 if token.startswith('{') else font(role, size).getlength(token)


def wrap(text, size, width, italic=False, italic_phrases=()):
    lines, line, used = [], [], 0
    groups, group = [], []
    for token, role in tokens(text, italic, italic_phrases):
        if token.isspace():
            if group:
                groups.append(group)
                group = []
            groups.append([(token, role)])
        else:
            group.append((token, role))
    if group:
        groups.append(group)
    for group in groups:
        token = ''.join(t for t, _ in group)
        if token == '\n':
            lines.append(line)
            line, used = [], 0
            continue
        amount = sum(advance(t, role, size) for t, role in group)
        if amount > width:
            raise LayoutError(f'Unbreakable text exceeds panel width: {token}')
        if used + amount > width and line and not token.isspace():
            while line and line[-1][0].isspace():
                line.pop()
            lines.append(line)
            line, used = [], 0
        if token.isspace() and not line:
            continue
        line.extend(group)
        used += amount
    if line:
        while line and line[-1][0].isspace():
            line.pop()
        lines.append(line)
    return lines


def text_plan(card):
    if 'Saga' in card.get('type_line',''):
        from .saga import text_plan as saga_plan
        return saga_plan(card)
    if 'Class' in card.get('type_line',''):
        from .class_layout import text_plan as class_plan
        return class_plan(card)
    if card.get('layout') in ('adventure','prepare'):
        from .subsets import text_plan as subset_plan
        return subset_plan(card)
    if 'Planeswalker' in card.get('type_line',''):
        from .planeswalker import text_plan as walker_plan
        return walker_plan(card)
    from .geometry import BODY_SIZES,planning_type_top
    type_top=planning_type_top(card,PROFILES[card.get('profile','standard')])
    top = type_top + 118
    from .frames import text_bottom
    bottom = text_bottom(card)
    from .template_sets import rules_inset, rules_bottom
    width = 1288 - 2*rules_inset(card)
    bottom = rules_bottom(card, bottom)
    for size in BODY_SIZES:
        rules = wrap(card['oracle_text'], size, width, italic_phrases=card.get('italic_phrases', []))
        flavor = wrap(card.get('flavor_text', ''), size, width, True)
        leading = math.ceil(size * 1.13)
        gap = 38 if rules and flavor else 0
        height = (len(rules) + len(flavor)) * leading + gap
        if height <= bottom - top:
            return dict(size=size, leading=leading, rules=rules, flavor=flavor,
                        gap=gap, top=top, bottom=bottom, height=height,type_top=type_top)
    raise LayoutError('Rules + flavour text overflow within the 40% height limit at the 36px readability floor. '
                      'Remove optional flavour or use a dedicated layout; never truncate Oracle text.')


def fitted(role, text, preferred, minimum, width):
    for size in range(preferred, minimum - 1, -1):
        f = font(role, size)
        box = f.getbbox(text)
        if max(f.getlength(text), box[2] - min(0, box[0])) <= width:
            return f
    raise LayoutError(f'Text does not fit its fixed field: {text}')


def fitted_title(text, width):
    try:
        return fitted('title', text, 80, 56, width)
    except LayoutError as exc:
        raise LayoutError(f'Display title must fit on one line: {text}. Choose a shorter display_name; title fit overrides naming style prompts. Preserve the original Magic name.') from exc


def symbol(token, size):
    """Vector-font symbols; two-tone costs, never letter stand-ins."""
    out = new_canvas('RGBA', (size + 6, size + 6))
    d = ImageDraw.Draw(out)
    d.ellipse((3, 5, size+2, size+4), fill=(0, 0, 0, 110))
    parts = token.split('/')
    base = COLORS.get(parts[0], '#d2cec4')
    if token == 'Q':
        base = '#171919'
    d.ellipse((1, 1, size, size), fill=base, outline='#242724', width=max(1, size//35))
    if len(parts) > 1 and parts[1] != 'P':
        d.pieslice((1, 1, size, size), 45, 225, fill=COLORS.get(parts[1], '#d2cec4'))
    if len(parts) == 1 or parts[-1] == 'P':
        key = symbol_key('P' if parts[-1] == 'P' else token)
        f = font('symbol', round(size * .78))
        centered_text(d, (1, 1, size, size), glyphs()[key], f,
                      '#f4eedc' if token == 'Q' else INK, align='center')
    else:
        for p, x, y in ((parts[0], .31, .30), (parts[1], .70, .70)):
            half = size*.43
            centered_text(d, (size*x-half/2, size*y-half/2, size*x+half/2, size*y+half/2),
                          glyphs()[symbol_key(p)], font('symbol', round(half)), INK, align='center')
    return out


def render(card, art_path=None, guides=False, frame_only=False, dpi=600):
    with resolution(dpi):
        return _render(card, art_path, guides, frame_only, dpi)


def _render(card, art_path=None, guides=False, frame_only=False, dpi=600):
    validate(card)
    from .faces import is_double, face_cards
    if is_double(card):
        paths = art_path if isinstance(art_path, (list, tuple)) else [None, None]
        outputs = [render(face, paths[i], guides, frame_only, dpi) for i, face in enumerate(face_cards(card))]
        return outputs[0]
    if (card.get('frame_style') or {}).get('renderer') == 'mse':
        from .mse import render_card, FALLBACK_KINDS
        from .template_sets import layout_kind
        if layout_kind(card) not in FALLBACK_KINDS and 'Planeswalker' not in card['type_line']:
            return render_card(card, art_path, frame_only, dpi)
        card = {k: v for k, v in card.items() if k != 'frame_style'}
    from .template_sets import text_color as frame_text_color
    text_color=frame_text_color(card)
    title_ink,type_ink=frame_text_color(card,'title'),frame_text_color(card,'type')
    plan = text_plan(card)
    from .geometry import apply as apply_geometry
    geometry=apply_geometry(card,plan)
    art_region=geometry['art']
    art_size=(art_region[2]-art_region[0],art_region[3]-art_region[1])
    if frame_only:
        image = new_canvas('RGBA', (W, H))
    elif art_path:
        with Image.open(art_path) as src:
            src = to_srgb(ImageOps.exif_transpose(src)).convert('RGB')
            if src.width < art_size[0] or src.height < art_size[1]:
                raise LayoutError(f'Art must be at least {art_size[0]}×{art_size[1]}; got {src.size}')
            prepared=ImageOps.fit(src,tuple(v*SCALE.get() for v in art_size),Image.Resampling.LANCZOS,centering=tuple(card.get('art_focus',[.5,.5]))).convert('RGBA')
            if art_region==(0,0,W,H):image=wrap_canvas(prepared,(W,H))
            else:
                image=new_canvas('RGBA',(W,H),'#111111');image.paste(prepared,(art_region[0],art_region[1]))
    else:
        # Explicit layout proof. This is not generated art or a finished card.
        image = new_canvas('RGBA', (W, H), '#23363d')
        d = ImageDraw.Draw(image)
        for y in range(H):
            d.line((0, y, W, y), fill=(28+int(30*y/H), 48+int(28*y/H), 61+int(16*y/H)))
        for x in range(-H, W, 120):
            d.line((x, 0, x+H, H), fill='#4b6266', width=2)
        d.text((W/2, 700), 'ARTWORK PLACEHOLDER', font=font('title', 58), anchor='mm', fill='#c0c7bd')
    overlay = new_canvas('RGBA', (W, H))
    d = ImageDraw.Draw(overlay)
    for y in range(1960, H):
        d.line((0, y, W, y), fill=(0, 0, 0, int(190*(y-1960)/(H-1960))))
    image.alpha_composite(overlay)
    ty = plan.get('type_top', PROFILES[card.get('profile', 'standard')])
    image.alpha_composite(frame_for(card, ty, output_scale=SCALE.get()))
    alignment = {}
    costs = re.findall(r'\{([^{}]+)\}', card.get('mana_cost', ''))
    mana_size, step = 68, 76
    # Bar shapes that cut into their ends move the lettering inward by the same depth.
    from .template_sets import text_inset
    title_cut, type_cut = text_inset(card, 'title', geometry), text_inset(card, 'type', geometry)
    mana_left = 1406 - title_cut - len(costs)*step
    if mana_left < 300:
        raise LayoutError('Mana cost exceeds fixed header capacity')
    d = ImageDraw.Draw(image)
    title = card.get('display_name') or card['name']
    title_left = (148 if card.get('face_label') else 94) + title_cut
    title_width = (mana_left - 24 if costs else 1406 - title_cut) - title_left
    title_font = fitted_title(title, title_width)
    title_area = (title_left, geometry['title'][1], 1406 - title_cut, geometry['title'][3])
    title_center=(geometry['title'][1]+geometry['title'][3])/2
    if card.get('face_label'):
        c=title_cut
        d.ellipse((86+c,title_center-20,126+c,title_center+20),fill=title_ink,outline='#101a15',width=3)
        if card['face_label']=='back':
            d.ellipse((99+c,title_center-24,130+c,title_center+8),fill='#193429')
        else:
            for dx,dy in [(0,-27),(0,27),(-27,0),(27,0)]:
                d.line((106+c+dx*.75,title_center+dy*.75,106+c+dx,title_center+dy),fill=title_ink,width=3)
    alignment['title'] = centered_text(d, title_area, title, title_font, title_ink, vertical_reference='T')
    title_baseline = centered_origin(title, title_font, title_area, vertical_reference='T')[1]
    _, cap_top, _, cap_bottom = ink_bounds('T', title_font)
    alignment['title_capital'] = [title_baseline+cap_top, title_baseline+cap_bottom]
    for n, cost in enumerate(costs):
        image.alpha_composite(symbol(cost, mana_size), (mana_left+n*step, round(title_center-(mana_size+1)/2)))
    if card.get('display_name') and card['display_name'] != card['name']:
        d = ImageDraw.Draw(image)
        from .template_sets import alias_text_box
        alias_area=alias_text_box(card,geometry)
        f = fitted('alias', card['name'], 45, 34, alias_area[2]-alias_area[0])
        alignment['original_name'] = centered_text(d, alias_area, card['name'], f, title_ink, align='center')
    d = ImageDraw.Draw(image)
    type_bounds = geometry['type']
    type_left=94+type_cut
    if card.get('face_label')=='back' and card.get('colors'):
        type_left=150+type_cut
        colors=card['colors']
        indicator_y=(type_bounds[1]+type_bounds[3])/2-1
        for n,color in enumerate(colors):
            d.pieslice((94+type_cut,indicator_y-22,138+type_cut,indicator_y+22),n*360/len(colors),(n+1)*360/len(colors),fill=COLORS[color])
        d.ellipse((94+type_cut,indicator_y-22,138+type_cut,indicator_y+22),outline=type_ink,width=2)
    tf = fitted('title', card['type_line'], 57, 43, 1322-type_cut-type_left)
    type_area = (type_left, type_bounds[1], 1322-type_cut, type_bounds[3])
    alignment['type_line'] = centered_text(d, type_area, card['type_line'], tf, type_ink, vertical_reference='T')
    type_baseline = centered_origin(card['type_line'], tf, type_area, vertical_reference='T')[1]
    _, cap_top, _, cap_bottom = ink_bounds('T', tf)
    alignment['type_capital'] = [type_baseline+cap_top, type_baseline+cap_bottom]
    # Custom expansion diamond, deliberately no counterfeit official set mark.
    rarity_colors = {'common': '#202628', 'uncommon': '#9ca8a9', 'rare': '#ad893c', 'mythic': '#d35a2d'}
    mark_y=(type_bounds[1]+type_bounds[3])/2;mark_x=1378-type_cut
    rarity_symbol=(card.get('frame_style') or {}).get('rarity_symbol')
    if rarity_symbol:
        # The frame set's own glyph, coloured by rarity.
        from .rarity import tile as rarity_tile, SIZE as RARITY_SIZE
        glyph,pad=rarity_tile(rarity_symbol,card.get('rarity','rare'),SCALE.get())
        image.alpha_composite(glyph,(round(mark_x-RARITY_SIZE/2-pad),round(mark_y-RARITY_SIZE/2-pad)))
    else:
        d.polygon([(mark_x, mark_y-21), (mark_x+20, mark_y), (mark_x, mark_y+22), (mark_x-20, mark_y)],
                  fill=rarity_colors.get(card.get('rarity', 'rare'), '#ad893c'), outline=INK)
    if plan.get('subset_layout'):
        from .subsets import draw as draw_subset
        draw_subset(image,card,plan,alignment)
    if 'ability_blocks' in plan:
        from .planeswalker import draw as draw_walker
        draw_walker(image,card,plan,alignment)
    if 'saga_blocks' in plan:
        from .saga import draw as draw_saga
        draw_saga(image,card,plan,alignment)
    if 'class_blocks' in plan:
        from .class_layout import draw as draw_class
        draw_class(image,card,plan,alignment)
    y = plan['top']
    from .template_sets import rules_inset
    inset = rules_inset(card)
    for block, lines in (() if 'ability_blocks' in plan or 'saga_blocks' in plan or 'class_blocks' in plan else (('rules', plan['rules']), ('flavor', plan['flavor']))):
        if block == 'flavor' and lines and plan['rules']:
            d.line((106+inset, y+12, 1394-inset, y+12), fill='#c7c2ad', width=2)
            y += plan['gap']
        for line in lines:
            x = 106 + inset
            for token, role in line:
                if token.startswith('{'):
                    sz = round(plan['size']*.82)
                    baseline = round(y) + font('body', plan['size']).getmetrics()[0]
                    center = cap_center(font('body', plan['size']), baseline)
                    symbol_y = round(center-(sz+1)/2)
                    image.alpha_composite(symbol(token[1:-1], sz), (round(x), symbol_y))
                    alignment.setdefault('inline_symbols', []).append({
                        'token': token, 'disc_center_y': symbol_y+(sz+1)/2,
                        'text_cap_center_y': center, 'baseline': baseline})
                else:
                    baseline = round(y) + font('body', plan['size']).getmetrics()[0]
                    d.text((round(x), baseline), token, font=font(role, plan['size']), fill=text_color, anchor='ls')
                x += advance(token, role, plan['size'])
            y += plan['leading']
    if 'power' in card:
        d = ImageDraw.Draw(image)
        stats = f"{card['power']}/{card['toughness']}"
        stats_box=geometry['stats']
        from .template_sets import stats_area
        area=stats_area(card,stats_box)
        # Largest size whose digits fit the open interior inside the box's rails.
        size=next((n for n in range(78,47,-1) if (lambda b:b[3]-b[1])(ink_bounds('0123456789/',font('title',n)))<=area[3]-area[1]),48)
        sf = fitted('title', stats, min(size,int(stats_box[3]-stats_box[1]-24)), 48, area[2]-area[0])
        alignment['statistics'] = centered_text(d, stats_box, stats, sf, title_ink, align='center')
    d = ImageDraw.Draw(image)
    # The user wants a clean art-only footer. Provenance stays in the manifest/report.
    if guides:
        d.rectangle((60, 60, W-60, H-60), outline='#ff55d9', width=3)
        d.rectangle((106, plan['top'], 1394, plan['bottom']), outline='#00dede', width=3)
        d.line((mana_left, 50, mana_left, 250), fill='#ff55d9', width=3)
    report = {
        'template': VERSION, 'id': card['id'], 'name': card['name'], 'profile': card.get('profile', 'standard'),
        'frame_set':card.get('frame_style',{}).get('name','Bloomburrow inspired'),
        'geometry':geometry,'type_top':ty,
        'size': [W*SCALE.get(), H*SCALE.get()], 'dpi': dpi, 'logical_size': [W,H], 'text_rendering': 'native-font-rasterization', 'body_font_px': plan['size']*SCALE.get(), 'body_font_pt': plan['size']*72/DPI,
        'title_font_px': title_font.size*SCALE.get(), 'rules_lines': len(plan['rules']), 'flavor_lines': len(plan['flavor']),
        'text_height': plan['height'], 'text_capacity': plan['bottom']-plan['top'],
        'art_sha256': digest(art_path) if art_path else None,
        'input_sha256': hashlib.sha256(json.dumps(card, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
        'font_sha256': {k: digest(v) for k, v in FONTS.items()},
        'renderer_sha256': digest(__file__), 'symbols_css_sha256': digest(ROOT/'assets/mana.css'),
        'frame_template': template_key(card), 'frame_version': FRAME_CONFIG['version'],
        'frame_palette_sha256': digest(PALETTE_PATH),
        'frame_renderer_sha256': digest(ROOT/'cardforge/frames.py'),
        'typography_sha256': digest(ROOT/'cardforge/typography.py'), 'alignment': alignment,
        'pillow': PIL.__version__, 'freetype': features.version_module('freetype2'),
        'status': 'frame-overlay' if frame_only else ('composed' if art_path else 'layout-proof'),
        'footer_text': False, 'color_space': 'sRGB',
        'review_required': ['Compare Oracle text against snapshot', 'Inspect art crop and legibility at print size'],
    }
    if art_path:
        with Image.open(art_path) as original:
            report['art_resolution']={'source_pixels':list(original.size),'sampled_pixels':[v*SCALE.get() for v in art_size],'effective_ppi':round(min(original.width/(art_size[0]/600),original.height/(art_size[1]/600)),1),'enlarged':original.width<art_size[0]*SCALE.get() or original.height<art_size[1]*SCALE.get()}
    return unwrap(image) if frame_only else image.convert('RGB'), report


def save_card(card, destination, art_path=None, guides=False, dpi=600):
    from .faces import is_double, face_cards
    if is_double(card):
        validate(card)
        paths=art_path if isinstance(art_path,(list,tuple)) else [None,None]
        targets=[save_card(face,destination,paths[i],guides,dpi) for i,face in enumerate(face_cards(card))]
        report_path=targets[0].with_suffix('.report.json')
        report=json.loads(report_path.read_text())
        report['layout']=card['layout']
        report['faces']=[{'label':'front' if i==0 else 'back','name':card['faces'][i]['name'],'image':p.name} for i,p in enumerate(targets)]
        report_path.write_text(json.dumps(report,indent=2)+'\n')
        return targets[0]
    image, report = render(card, art_path, guides, dpi=dpi)
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / f"{card['id']}.png"
    image.save(target, dpi=(dpi, dpi), icc_profile=SRGB_PROFILE, optimize=False, compress_level=4)
    frame, _ = render(card, guides=guides, frame_only=True, dpi=dpi)
    frame_target = destination / f"{card['id']}.frame.png"
    frame.save(frame_target, dpi=(dpi, dpi), icc_profile=SRGB_PROFILE, optimize=False, compress_level=4)
    report['frame_sha256'] = digest(frame_target)
    report['output_sha256'] = digest(target)
    (destination / f"{card['id']}.report.json").write_text(json.dumps(report, indent=2)+'\n')
    return target
