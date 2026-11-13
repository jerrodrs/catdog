"""Design review for generated frame sets: flavour delivered, options of one run distinct from each other, proofed on real art."""
import json
from pathlib import Path
from PIL import Image, ImageChops, ImageFilter, ImageStat

# Calibrated on the user's library: near-duplicate frames scored 0.73–0.84; genuinely different sets 0.48–0.68.


def _frame(path):
    return Image.open(path).convert('RGBA').resize((150, 210), Image.Resampling.LANCZOS)


def similarity(a_path, b_path):
    """0–1 likeness of two creature frame layers: shared frame area, colour where frames exist, and edge structure."""
    a, b = _frame(a_path), _frame(b_path)
    ma = a.getchannel('A').point(lambda v: 255 if v > 32 else 0)
    mb = b.getchannel('A').point(lambda v: 255 if v > 32 else 0)
    union, inter = ImageChops.lighter(ma, mb), ImageChops.multiply(ma, mb)
    overlap = ImageStat.Stat(inter).sum[0] / max(1, ImageStat.Stat(union).sum[0])
    colour = 1 - sum(ImageStat.Stat(ImageChops.difference(a.convert('RGB'), b.convert('RGB')), union).mean) / 3 / 255
    def flat(image):
        grey = Image.new('RGBA', image.size, (128, 128, 128, 255))
        grey.alpha_composite(image)
        return grey.convert('L').filter(ImageFilter.FIND_EDGES)
    ea, eb = flat(a), flat(b)
    edge = 1 - ImageStat.Stat(ImageChops.difference(ea, eb)).mean[0] / max(1, ImageStat.Stat(ea).mean[0] + ImageStat.Stat(eb).mean[0])
    return round((overlap + colour + 2*edge) / 4, 3)


def features(config):
    """Themed elements a frame actually uses, across its global style and layout overrides."""
    styles = [config.get('style', {}), *config.get('layouts', {}).values()]
    ornaments = config.get('ornaments', [])
    decorations = config.get('decorations', [])
    area = sum((d['box'][2]-d['box'][0])*(d['box'][3]-d['box'][1]) for d in decorations) / (1500*2100)
    skins = {s[k] for s in styles for k in ('title_skin', 'alias_skin', 'type_skin', 'rules_skin', 'stats_skin', 'crest_skin') if s.get(k)}
    return {
        'shape': any(s.get('shape') not in (None, 'classic', 'angular') or 'shape_cut' in s or s.get('panel_bottom', 'arch') != 'arch' or s.get('panel_corners', 'square') != 'square' for s in styles),
        'custom_shape': any(s.get('shape') == 'custom' for s in styles),
        'rails': any(s.get('rail_style', 'single') != 'single' or s.get('rail_finish') == 'foil' or s.get('rail_texture') for s in styles),
        # Frames are shapes, borders and materials: linework counts, pictorial symbols are not allowed.
        'linework': sum(1 for o in ornaments if o.get('kind') in ('line', 'polygon', 'ellipse')) >= 4,
        'symbols': sorted({o.get('symbol', '') for o in ornaments if o.get('kind') == 'symbol'}),
        'textures': sum(1 for k in ('title_texture', 'type_texture', 'rules_texture', 'stats_texture') if any(s.get(k) for s in styles)),
        'skins': len(skins),
        'skinned_surfaces': sorted({k[:-5] for s in styles for k in ('title_skin', 'alias_skin', 'type_skin', 'rules_skin', 'stats_skin', 'crest_skin') if s.get(k)}),
        'decorations': len(decorations),
        'decoration_area': round(min(area, 1), 3),
    }


def flavour_problems(level, found):
    signals = sum(bool(found[k]) for k in ('shape', 'rails', 'linework', 'textures', 'decorations', 'skins'))
    if level == 'stylised' and signals < 2:
        return ['Stylised frames need at least two themed elements (bar or panel shape, rail style/texture, frame linework, panel textures, painted skins or painted decorations); this set has %d.' % signals]
    if level == 'showcase':
        problems = []
        # Showcase means genuinely painted material, not flat fills with a couple of accents.
        if len(found['skinned_surfaces']) < 2 and found['decorations'] < 3:
            problems.append('Showcase frames need painted surfaces: skins on at least two panel types (e.g. title and rules), or at least three painted decorations on the frame.')
        if signals < 3:
            problems.append('Showcase frames need at least three themed elements; this set has %d.' % signals)
        return problems
    return []


# Painted pieces render at print resolution (2 px per logical px). More enlargement than this, or uneven
# scaling, shows as blur and stretching on a printed card.
MAX_UPSCALE = 1.25
MAX_DISTORTION = 1.06
# Largest print-resolution size (px) each skinned surface reaches: bars at full width, the rules box at full height.
SKIN_TARGETS = {'title': (2768, 300), 'alias': (2616, 160), 'type': (2768, 240), 'rules': (2688, 1600), 'stats': (960, 320), 'crest': (2880, 320)}


def asset_quality(config):
    """Painted decorations and textures that would print stretched or soft."""
    from cardforge.decorations import asset_path, authored
    problems = []
    for item in config.get('decorations', []):
        with Image.open(asset_path(config, item)) as image:
            box = image.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
            size = image.size
        if not box:
            continue
        if authored(size, item['box']):
            # Placed exactly as drawn; only images drawn at card units (1 px per unit) are enlarged.
            if size[0] < 2*(item['box'][2]-item['box'][0]):
                problems.append(f'Decoration {item["image"]} is drawn at card units and will be enlarged 2x; draw it at print resolution ({2*(item["box"][2]-item["box"][0])}x{2*(item["box"][3]-item["box"][1])} px).')
            continue
        width, height = box[2]-box[0], box[3]-box[1]
        bw, bh = 2*(item['box'][2]-item['box'][0]), 2*(item['box'][3]-item['box'][1])
        fit = item.get('fit', 'contain')
        sx, sy = bw/width, bh/height
        name = item['image']
        if fit == 'stretch' and max(sx, sy)/min(sx, sy) > MAX_DISTORTION:
            problems.append(f'Decoration {name} is stretched {max(sx, sy)/min(sx, sy):.1f}x out of proportion in box {item["box"]}. Paint it at the box\'s proportions, or use fit "tile" with a seamless segment for long trim.')
            continue
        scale = (bh/height if bw >= bh else bw/width) if fit == 'tile' else min(sx, sy) if fit == 'contain' else max(sx, sy)
        if scale > MAX_UPSCALE:
            problems.append(f'Decoration {name} is enlarged {scale:.1f}x at print resolution and will look soft. Supply at least {round(width*scale/MAX_UPSCALE)}x{round(height*scale/MAX_UPSCALE)} px of painted detail (2 px per card unit), or shrink its box.')
    styles = [config.get('style', {}), *config.get('layouts', {}).values()]
    for surface, (tw, th) in SKIN_TARGETS.items():
        for name in {s.get(surface + '_skin') for s in styles} - {None}:
            item = config['skins'][name]
            with Image.open(asset_path(config, item)) as image:
                width, height = image.size
            scale = item.get('scale', 1)
            width, height = width*scale, height*scale
            if scale > MAX_UPSCALE:
                problems.append(f'Skin {name} uses scale {scale}; paint it larger instead of enlarging it.')
            elif not item.get('slice'):
                factor = max(tw/width, th/height)
                if factor > MAX_UPSCALE:
                    problems.append(f'Skin {name} is enlarged {factor:.1f}x to cover the {surface} panel (about {tw}x{th} px at print size). Give it a slice so its border keeps native size and use fill "tile" with a seamless centre, or supply a larger image.')
            elif item.get('fill', 'stretch') == 'stretch':
                left, top, right, bottom = [v*scale for v in item['slice']]
                factor = max((tw-left-right)/max(1, width-left-right), (th-top-bottom)/max(1, height-top-bottom))
                if factor > MAX_UPSCALE:
                    problems.append(f'Skin {name} stretches its centre {factor:.1f}x on the {surface} panel and will look soft. Use fill "tile" with a seamless centre, or supply a larger image.')
    if any(s.get('texture_scale', 1) > MAX_UPSCALE for s in styles):
        problems.append(f'texture_scale above {MAX_UPSCALE} enlarges panel textures past their resolution; supply a larger seamless tile instead.')
    return problems


def detail_crops(config, destination):
    """Actual-size crops of the joins where frame pieces meet: corners, bar ends, side borders and the stats box."""
    from cardforge.template_sets import preview_card
    from cardforge.render import render
    card = preview_card('creature', config, ['R'], True)
    image, _ = render(card, None, dpi=1200)
    image = image.convert('RGB')
    w, h = image.size
    regions = [(0, 0, 700, 700), (w-700, 0, w, 700), (0, h//2-350, 700, h//2+350), (w-700, h-700, w, h)]
    sheet = Image.new('RGB', (1420, 1420), '#18241e')
    for i, region in enumerate(regions):
        sheet.paste(image.crop(region), (10+(i % 2)*710, 10+(i//2)*710))
    sheet.save(destination / 'detail-crops.jpg', quality=92)
    return str(destination / 'detail-crops.jpg')


def real_art_proofs(config, request, destination):
    """Render the review cards with real illustrations: what the designer and the user actually judge."""
    from cardforge.template_sets import preview_card
    from cardforge.render import render
    picks = [p for p in request.get('review_art') or [] if Path(p['path']).is_file()]
    if not picks:
        return None
    tiles = []
    rarities = ('mythic', 'rare', 'uncommon', 'common')
    for i, pick in enumerate(picks):
        card = preview_card(pick['layout'], config, pick.get('colors') or [], pick.get('legendary', False))
        card['rarity'] = rarities[i % 4]  # show the set's rarity symbol in every rarity colour
        image, _ = render(card, pick['path'])
        image = image.convert('RGB').resize((500, 700), Image.Resampling.LANCZOS)
        image.save(destination / f'real-art-{i}.jpg', quality=90)
        tiles.append(image)
    sheet = Image.new('RGB', (len(tiles)*520+20, 740), '#18241e')
    for i, tile in enumerate(tiles):
        sheet.paste(tile, (20+i*520, 20))
    sheet.save(destination / 'real-art-proofs.jpg', quality=92)
    return {'path': str(destination / 'real-art-proofs.jpg'), 'count': len(tiles), 'cards': [p['name'] for p in picks]}


def sibling_problems(mine, request, version_dir, final=False):
    """The three options of a group are designed in parallel. Each must be a genuinely different design: compare with
    siblings that have already verified (their creature frame exists) and with their chosen concepts.
    Returns (problems, warnings, scores). After the designer finishes (final), differences are only reported."""
    problems, warnings, scores = [], [], []
    chosen = lambda folder: (lambda c: (c.get('concepts') or [{}])[c.get('chosen', 0)] if c.get('concepts') else {})(json.loads((Path(folder)/'concept.json').read_text()) if (Path(folder)/'concept.json').is_file() else {})
    own = chosen(version_dir)
    for sibling in request.get('siblings') or []:
        folder = Path(sibling['directory'])
        frame = folder/'previews'/'creature.frame.png'
        other = chosen(folder)
        if own.get('name') and other.get('name') and own['name'].strip().lower() == other['name'].strip().lower():
            (warnings if final else problems).append(f"Your chosen concept has the same name as the {sibling['label']} option (“{other['name']}”). The three options must be different designs: pick another of your concepts or develop a new one.")
        if frame.is_file() and Path(mine).is_file():
            score = similarity(mine, frame)
            scores.append({'name': sibling['label'], 'score': score, 'sibling': True})
            if score >= SIBLING_LIMIT:
                (warnings if final else problems).append(f"Looks too similar to the {sibling['label']} option designed alongside you (similarity {score:.2f}; limit {SIBLING_LIMIT}). Change the bar silhouette, rules-box shape, materials or painted surfaces so the three options offer a real choice.")
    return problems, warnings, scores


# Options designed together should differ at least as clearly as genuinely different sets do.
SIBLING_LIMIT = 0.7


def review(config, request, version_dir, previews, final=False):
    """Raises ValueError with actionable reasons; returns the review record otherwise."""
    concept_file = Path(version_dir) / 'concept.json'
    concept = json.loads(concept_file.read_text()) if concept_file.exists() else {}
    chosen = (concept.get('concepts') or [{}])[concept.get('chosen', 0)] if concept.get('concepts') else {}
    level = (request.get('candidate') or {}).get('target') or chosen.get('flavour_level') or 'stylised'
    from cardforge.template_sets import art_intrusions
    found = features(config)
    problems = flavour_problems(level, found) + art_intrusions(config) + asset_quality(config)
    if found['symbols']:
        problems.append('The frame must be shapes, borders and materials only, with no symbols or icons: remove the %s ornament symbols. The rarity symbol is the only symbol on the card.' % ', '.join(found['symbols']))
    if not config.get('rarity_symbol'):
        problems.append('Design a rarity_symbol for this frame set: a vector glyph styled to match the frame (see docs/frame-schema.md).')
    warnings, scores = [], []
    mine = Path(previews) / 'creature.frame.png'
    found_problems, found_warnings, sibling_scores = sibling_problems(mine, request, version_dir, final)
    problems += found_problems; warnings += found_warnings; scores += sibling_scores
    proofs = real_art_proofs(config, request, Path(previews))
    detail_crops(config, Path(previews))
    record = {'flavour_level': level, 'features': found, 'similarity': scores, 'warnings': warnings, 'problems': problems, 'real_art_proofs': proofs and proofs['path'], 'real_art_count': proofs['count'] if proofs else 0, 'real_art_cards': proofs['cards'] if proofs else []}
    (Path(version_dir) / 'design-review.json').write_text(json.dumps(record, indent=2))
    if problems:
        raise ValueError('Design review failed: ' + ' '.join(problems))
    return record
