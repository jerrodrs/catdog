"""Deterministic, non-destructive outer-edge finishes, independent of card lettering.

Dimensions are project presets based on visual references, not Wizards production specs.
The original PNG and layout remain unchanged; use the same finished PNG for screen/export.
"""
import hashlib
import json
from pathlib import Path
import sys
import PIL
from PIL import Image, ImageDraw

COLORS = {'black': '#000000', 'classic': '#000000', 'modern': '#000000', 'white': '#f3f0e6', 'silver': '#aeb4b9', 'gold': '#b99a48'}


def finish(image, settings, report=None, card=None, official=False):
    report, card = report or {}, card or {}
    style = settings.get('style', 'black')
    width_mm = float(settings.get('width_mm', 1.2))
    if official or style == 'none' or width_mm == 0:
        return image.copy(), {'style': 'none', 'width_mm': 0, 'official_scan': official, 'taper_applied': False}
    if style not in COLORS or not 0 < width_mm <= 2.2:
        raise ValueError('Invalid outer border')
    w, h = image.size
    scale = 3
    width = max(1, round(width_mm * w / 63.5))
    mask = Image.new('L', (w * scale, h * scale), 255)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((width * scale, width * scale, (w - width) * scale - 1, (h - width) * scale - 1), radius=round(w * .018 * scale), fill=0)
    # Modern frame bottoms flare into a black lower area; keep the text/stats intact.
    if style == 'modern' and not official:
        start, end = .85 * h, h - .052 * h
        extra = min(w * .024, max(0, w * .063 - width))
        for side in (False, True):
            points = [(0, start), (width, start)]
            for i in range(41):
                t = i / 40
                points.append((width + extra * t * t * (3 - 2 * t), start + (end - start) * t))
            points.extend([(width + extra, h), (0, h)])
            if side:
                points = [(w - x, y) for x, y in points]
            draw.polygon([(round(x * scale), round(y * scale)) for x, y in points], fill=255)
        draw.rectangle((0, round(end * scale), w * scale, h * scale), fill=255)
    # Recesses for the actual statistics/loyalty panel, including editor positions.
    box = (report.get('geometry') or {}).get('stats')
    if not box and card.get('power') is not None:
        box = (1176, 1916, 1442, 2018)
    if card.get('loyalty') is not None:
        box = (1215, 1904, 1445, 2020)
    if box:
        x1, y1, x2, y2 = box
        box = (round((x1 - 6) / 1500 * w * scale), round((y1 - 6) / 2100 * h * scale), round((x2 + 6) / 1500 * w * scale), round((y2 + 6) / 2100 * h * scale))
        # Keep a nonempty straight segment: Pillow 9.x can reverse its internal
        # rectangle when an odd-height capsule uses exactly half-height radii.
        radius = max(0, min(box[2] - box[0], box[3] - box[1]) // 2 - 1)
        draw.rounded_rectangle(box, radius=radius, fill=0)
    mask = mask.resize((w, h), Image.Resampling.LANCZOS)
    overlay = Image.new('RGBA', image.size, COLORS[style])
    overlay.putalpha(mask)
    result = Image.alpha_composite(image.convert('RGBA'), overlay)
    if image.mode != 'RGBA':
        result = result.convert('RGB')
    return result, {'style': style, 'width_mm': width_mm, 'width_px': width, 'native_size': [w, h], 'source_preserved': True, 'pillow': PIL.__version__, 'official_scan': official, 'taper_applied': style == 'modern' and not official}


def main():
    request = json.loads(Path(sys.argv[1]).read_text())
    source, destination = Path(request['source']), Path(request['destination'])
    with Image.open(source) as original:
        original.load()
        prepared = original.convert('RGBA') if original.mode == 'RGBA' else original.convert('RGB')
        if request.get('thumbnail'):prepared.thumbnail((420,588),Image.Resampling.LANCZOS)
        image, report = finish(prepared, request['settings'], request.get('report'), request.get('card'), request.get('official', False))
    temp = destination.with_suffix('.tmp.png')
    if destination.suffix=='.webp':
        image.save(temp,format='WEBP',quality=90,method=4)
    else:
        image.save(temp, format='PNG', compress_level=4, dpi=(round(image.width / 2.5), round(image.height / 3.5)))
    temp.replace(destination)
    report.update(source=str(source), source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), output_sha256=hashlib.sha256(destination.read_bytes()).hexdigest(), renderer_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    destination.with_suffix('.report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
