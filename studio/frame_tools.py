"""Frame designer's toolkit: exact geometry, clean painted assets and fast proofs while building a frame set.

    python3 studio/frame_tools.py anchors CONFIG [--layout creature] [--legendary] [--alias]
    python3 studio/frame_tools.py cutout SOURCE DEST [--key auto|#RRGGBB] [--tolerance 40] [--softness 30] [--trim]
    python3 studio/frame_tools.py seamless SOURCE DEST [--axis x|y|both] [--blend 0.15]
    python3 studio/frame_tools.py proof CONFIG [--layout creature] [--colors R] [--legendary] [--alias] [--art PATH] [--out DIR]
    python3 studio/frame_tools.py check CONFIG

Coordinates are logical card units (1500 x 2100); print resolution is 2 px per unit (3000 x 4200).
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageOps

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT/'studio'))


def _config(path):
    from cardforge.decorations import load_set
    from cardforge.template_sets import validate_set
    return validate_set(load_set(Path(path)))


def _card(config, layout, colors, legendary, alias):
    from cardforge.template_sets import preview_card
    return preview_card(layout, config, colors, legendary, alias)


def anchors(args):
    """Where every frame surface sits for one structure, so painted pieces can be drawn to exact boxes."""
    from cardforge.render import render
    from cardforge.geometry import boxes
    from cardforge.template_sets import body_points, layout_style, FRAME_MARGIN, FRAME_EDGE
    config = _config(args.config)
    card = _card(config, args.layout, list(args.colors), args.legendary, args.alias)
    report = render(card, frame_only=True)[1]
    type_top = report['type_top']
    geometry = boxes(card, type_top)
    body = body_points(layout_style(card), type_top)
    xs, ys = [x for x, _ in body], [y for _, y in body]
    surfaces = {k: [round(v) for v in geometry[k]] for k in ('title', 'alias', 'type', 'stats') if geometry.get(k)}
    if not args.alias:
        surfaces.pop('alias', None)
    surfaces['rules_panel'] = [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))]
    top = surfaces['alias'][3] if args.alias else surfaces['title'][3]
    surfaces['art_window'] = [94, round(top+22), 1406, round(surfaces['type'][1]-22)]
    out = {
        'layout': args.layout, 'legendary': args.legendary, 'alias': args.alias, 'type_top': type_top,
        'units': 'logical card px (1500x2100); multiply by 2 for print-resolution pixels',
        'surfaces': surfaces,
        'print_px': {k: [v*2 for v in box] for k, box in surfaces.items()},
        'decoration_zone': f'Painted decorations and ornaments must sit on the frame: on a surface above, within {FRAME_MARGIN} px of its edge, or in the outer {FRAME_EDGE} px band of the card. More than 10% off that zone fails review. The art_window stays clear.',
        'note': 'The rules panel and type bar move with rules length (type_top); bars grow for thick rails. Draw end caps and corner pieces relative to bar ends, and run anchors for a short and a long card when placement matters.',
    }
    print(json.dumps(out, indent=2))


def cutout(args):
    """Turn a piece painted on a flat background into a clean RGBA asset: soft keyed edges and colour spill removed."""
    import numpy as np
    image = Image.open(args.source).convert('RGBA')
    rgba = np.asarray(image, dtype=float)
    existing = rgba[..., 3]
    if existing.min() < 250 and args.key == 'auto':
        print(json.dumps({'note': 'Source already has transparency; copied without keying.', 'size': image.size}))
        out = image
    else:
        rgb = rgba[..., :3]
        if args.key == 'auto':
            border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
            key = np.median(border, axis=0)
        else:
            key = np.array([int(args.key[i:i+2], 16) for i in (1, 3, 5)], dtype=float)
        distance = np.sqrt(((rgb-key)**2).sum(axis=2))
        alpha = np.clip((distance-args.tolerance)/max(1, args.softness), 0, 1)
        # Remove the background colour blended into antialiased edges.
        a = np.maximum(alpha, 1e-3)[..., None]
        clean = np.clip((rgb-(1-a)*key)/a, 0, 255)
        clean = np.where(alpha[..., None] > 0, clean, 0)
        out = Image.fromarray(np.dstack([clean, alpha*existing]).astype('uint8'), 'RGBA')
        print(json.dumps({'key': '#%02x%02x%02x' % tuple(int(v) for v in key), 'transparent_share': round(float((alpha == 0).mean()), 3), 'size': out.size}))
    if args.trim:
        box = out.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
        if box:
            out = out.crop(box)
    out.save(args.dest)


def seamless(args):
    """Make a texture tile or trim segment repeat without a visible seam by cross-fading its wrap-around edges."""
    import numpy as np
    image = Image.open(args.source)
    mode = 'RGBA' if image.mode in ('RGBA', 'LA', 'P') else 'RGB'
    data = np.asarray(image.convert(mode), dtype=float)

    def wrap(array, axis):
        size = array.shape[axis]
        blend = max(2, round(size*args.blend))
        head = np.take(array, range(0, blend), axis=axis)
        tail = np.take(array, range(size-blend, size), axis=axis)
        middle = np.take(array, range(blend, size-blend), axis=axis)
        shape = [1]*array.ndim
        shape[axis] = blend
        ramp = np.linspace(0, 1, blend).reshape(shape)
        # The output starts where the original tail ended, so the last column flows into the first.
        return np.concatenate([tail*(1-ramp)+head*ramp, middle], axis=axis)
    if args.axis in ('x', 'both'):
        data = wrap(data, 1)
    if args.axis in ('y', 'both'):
        data = wrap(data, 0)
    out = Image.fromarray(np.clip(data, 0, 255).astype('uint8'), mode)
    out.save(args.dest)
    print(json.dumps({'size': out.size, 'axis': args.axis}))


def proof(args):
    """Render one card at print resolution with real art, plus actual-size crops of the bar ends and lower panel."""
    from cardforge.render import render
    config = _config(args.config)
    card = _card(config, args.layout, list(args.colors), args.legendary, args.alias)
    art = args.art
    if not art:
        request = Path(args.config).resolve().parent/'request.json'
        picks = json.loads(request.read_text()).get('review_art') or [] if request.is_file() else []
        art = next((p['path'] for p in picks if Path(p['path']).is_file()), None)
    image, report = render(card, art, dpi=1200)
    image = image.convert('RGB')
    out = Path(args.out or Path(args.config).resolve().parent/'previews')
    out.mkdir(parents=True, exist_ok=True)
    name = f"proof-{args.layout}{'-legendary' if args.legendary else ''}{'-alias' if args.alias else ''}"
    image.save(out/f'{name}.png')
    w, h = image.size
    t = report['type_top']*2
    crops = [(0, 0, 900, 520), (w-900, 0, w, 520), (0, t-120, 900, min(h, t+700)), (w-900, h-820, w, h)]
    sheet = Image.new('RGB', (1820, 1840), '#18241e')
    for i, box in enumerate(crops):
        piece = image.crop(box)
        piece.thumbnail((900, 910))
        sheet.paste(piece, (10+(i % 2)*910, 10+(i//2)*920))
    sheet.save(out/f'{name}-crops.jpg', quality=92)
    image.resize((750, 1050), Image.Resampling.LANCZOS).save(out/f'{name}-small.jpg', quality=90)
    print(json.dumps({'card': str(out/f'{name}.png'), 'crops': str(out/f'{name}-crops.jpg'), 'thumbnail': str(out/f'{name}-small.jpg'), 'art': art}))


def check(args):
    """Fast pre-flight before the full verifier: schema, measured contrast, print quality and art clearance."""
    from cardforge.template_sets import measured_contrast, art_intrusions
    from frame_review import asset_quality, features
    problems = []
    try:
        config = _config(args.config)
    except Exception as error:
        print(json.dumps({'ok': False, 'problems': [str(error)]}, indent=2))
        sys.exit(1)
    try:
        contrast = measured_contrast(config)
    except Exception as error:
        contrast = None
        problems.append(str(error))
    problems += asset_quality(config) + art_intrusions(config)
    print(json.dumps({'ok': not problems, 'measured_contrast': contrast, 'features': features(config), 'problems': problems}, indent=2))
    sys.exit(1 if problems else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('anchors', 'proof'):
        p = sub.add_parser(name)
        p.add_argument('config')
        p.add_argument('--layout', default='creature')
        p.add_argument('--colors', default='R', help='colour identity letters, e.g. R, WU, or "" for colourless')
        p.add_argument('--legendary', action='store_true')
        p.add_argument('--alias', action='store_true', help='show the original-name tab under a renamed title')
        if name == 'proof':
            p.add_argument('--art')
            p.add_argument('--out')
    p = sub.add_parser('cutout')
    p.add_argument('source')
    p.add_argument('dest')
    p.add_argument('--key', default='auto')
    p.add_argument('--tolerance', type=float, default=40)
    p.add_argument('--softness', type=float, default=30)
    p.add_argument('--trim', action='store_true')
    p = sub.add_parser('seamless')
    p.add_argument('source')
    p.add_argument('dest')
    p.add_argument('--axis', choices=('x', 'y', 'both'), default='both')
    p.add_argument('--blend', type=float, default=.15)
    p = sub.add_parser('check')
    p.add_argument('config')
    args = parser.parse_args()
    {'anchors': anchors, 'cutout': cutout, 'seamless': seamless, 'proof': proof, 'check': check}[args.command](args)


if __name__ == '__main__':
    main()
