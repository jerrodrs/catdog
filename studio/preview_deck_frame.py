"""Transient deck-frame proof: one saved card recomposed with another frame set, without saving a version."""
import json
from pathlib import Path
import sys
import uuid
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cardforge.render import render, validate, SRGB_PROFILE
from verify_result import apply_frame_set, apply_appearance
from cardforge.borders import finish


def prepare(request):
    manifest = Path(request['manifest_path']).resolve(strict=True)
    source = manifest.parent / 'source-manifest.json'
    if not source.exists():
        source = manifest
    data = json.loads(source.read_text())
    card = next((c for c in data.get('cards', []) if c.get('id') == request.get('card_id')), None) or data['cards'][0]
    apply_frame_set(card, request)
    apply_appearance(card, request)
    from cardforge.faces import is_double, face_cards
    if is_double(card):
        card = face_cards(card)[0]
    arts = []
    for face in [card]:
        if not face.get('art'):
            raise ValueError('This version has no saved art reference to preview.')
        art = (source.parent / face['art']).resolve(strict=True)
        if not any(art.is_relative_to(Path(p).resolve()) for p in request['allowed_roots']):
            raise ValueError('Artwork must be a local project asset.')
        arts.append(art)
    width = int(request.get('width', 900))
    validate(card)
    fast_mse = False
    if (card.get('frame_style') or {}).get('renderer') == 'mse':
        from cardforge.template_sets import layout_kind
        from cardforge.mse import FALLBACK_KINDS
        fast_mse = layout_kind(card) not in FALLBACK_KINDS and 'Planeswalker' not in card['type_line']
    return card, arts[0], width, fast_mse


def save_preview(request, card, image, report):
    image, border_report = finish(image, request.get('border_settings', {'style': 'none', 'width_mm': 0}), report, card)
    report['border'] = border_report
    report['preview'] = True
    destination = Path(request['destination'])
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.stem + '.' + uuid.uuid4().hex + '.tmp.png')
    image.save(temporary, icc_profile=SRGB_PROFILE, compress_level=3)
    # Retain logical geometry and preview provenance beside the transient image.
    destination.with_suffix('.report.json').write_text(json.dumps(report, indent=2) + '\n')
    temporary.replace(destination)
    return {'image_path': str(destination)}


def preview(request):
    card, art, width, fast_mse = prepare(request)
    if fast_mse:
        from cardforge.mse import render_preview
        image, report = render_preview(card, art, width)
    else:
        image, report = render(card, art, dpi=600)
        image = image.resize((width, round(width * image.height / image.width)), Image.Resampling.LANCZOS)
    return save_preview(request, card, image, report)


def preview_batch(requests):
    results = [None] * len(requests)
    groups = {}
    for index, request in enumerate(requests):
        try:
            card, art, width, fast_mse = prepare(request)
            if not fast_mse:
                image, report = render(card, art, dpi=600)
                image = image.resize((width, round(width * image.height / image.width)), Image.Resampling.LANCZOS)
                results[index] = save_preview(request, card, image, report)
                continue
            from cardforge.mse import stylesheet_for
            key = (stylesheet_for(card, card['frame_style'])[0], width,
                   json.dumps(card['frame_style'].get('rarity_symbol'), sort_keys=True))
            groups.setdefault(key, []).append((index, card, art))
        except Exception as error:
            results[index] = {'error': str(error)}
    for (_, width, _), items in groups.items():
        try:
            from cardforge.mse import render_previews
            outputs = render_previews([(card, art) for _, card, art in items], width)
            for (index, card, _), (image, report) in zip(items, outputs):
                results[index] = save_preview(requests[index], card, image, report)
        except Exception as error:
            for index, _, _ in items:
                results[index] = {'error': str(error)}
    return {'results': results}


def main():
    request = json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(preview_batch(request['jobs']) if 'jobs' in request else preview(request)))


if __name__ == '__main__':
    main()
