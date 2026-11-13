"""Rebuild a job's one-card manifest using the trusted deterministic renderer."""
import argparse
import json
from pathlib import Path
import sys
import hashlib
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from cardforge.render import save_card, validate
from cardforge.decorations import load_set
from cardforge.template_sets import apply_controls


def apply_frame_set(card, request):
    """Apply a job's token spec and frame set in place, before appearance controls."""
    request_card = request.get('card', {})
    if request_card.get('entry_kind') == 'token':
        for field in ('name', 'type_line', 'oracle_text', 'colors', 'color_identity', 'layout', 'mana_cost', 'rarity', 'power', 'toughness'):
            card.pop(field, None)
        card.update(request_card['token_spec'])
    frame_set=request.get('frame_set')
    if frame_set:
        card.pop('frame_style',None)
        config=load_set(frame_set['config_path']) if frame_set.get('config_path') else None
        if config:config=apply_controls(config,{'rules_sizing':frame_set.get('rules_sizing','fit')})
        for face in card.get('faces',[card]):
            if config: face['frame_style']=config
            else: face.pop('frame_style',None)


def apply_appearance(card, request):
    """Apply explicit title, flavour, rarity and crop controls in place."""
    all_controls = request.get('card', {}).get('customization', {})
    face_cards = card.get('faces', [card])
    for index, face in enumerate(face_cards):
        controls = all_controls if index == 0 else all_controls.get('back', {})
        if controls.get('title_mode') == 'original':
            face.pop('display_name', None)
        elif controls.get('title_mode') == 'custom':
            face['display_name'] = controls['display_name']
        if controls.get('flavor_mode') == 'none':
            face.pop('flavor_text', None)
        elif controls.get('flavor_mode') == 'custom':
            face['flavor_text'] = controls['flavor_text']
        if controls.get('rarity', 'original') != 'original':
            face['rarity'] = controls['rarity']
        if 'art_focus' in controls:
            face['art_focus'] = controls['art_focus']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest', type=Path)
    parser.add_argument('version_dir', type=Path)
    args = parser.parse_args()
    manifest = args.manifest.resolve(strict=True)
    version_dir = args.version_dir.resolve(strict=True)
    if not manifest.is_relative_to(version_dir):
        raise ValueError('Manifest must be saved in this job’s version directory.')
    data = json.loads(manifest.read_text())
    if len(data.get('cards', [])) != 1:
        raise ValueError('A card job must return exactly one card.')
    card = data['cards'][0]
    request_file = version_dir / 'request.json'
    request = json.loads(request_file.read_text()) if request_file.exists() else {}
    apply_frame_set(card, request)
    source = version_dir / 'source-manifest.json'
    if not source.exists():
        source.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    apply_appearance(card, request)
    face_cards = card.get('faces', [card])
    validate(card)
    arts=[]
    for face in face_cards:
        if not face.get('art'):
            raise ValueError('Completed artwork is required for every face; placeholder proofs are not accepted.')
        art = (manifest.parent/face['art']).resolve(strict=True)
        if not art.is_relative_to(ROOT) and not art.is_relative_to(version_dir):
            raise ValueError('Artwork must be a local project asset.')
        arts.append(art)
    target = save_card(card, version_dir/'rendered', arts if len(arts)>1 else arts[0], dpi=request.get('render_dpi',1200))
    report_file = target.with_suffix('.report.json')
    report = json.loads(report_file.read_text())
    with Image.open(arts[0]) as image:
        report['art_pixels_sha256'] = hashlib.sha256(image.convert('RGB').tobytes()).hexdigest()
    report_file.write_text(json.dumps(report, indent=2) + '\n')
    manifest.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(json.dumps({'image_path': str(target), 'frame_path': str(target.with_suffix('.frame.png')),
                      'manifest_path': str(manifest), 'report_path': str(target.with_suffix('.report.json')),
                      'faces': [{'label':'front' if i==0 else 'back','name':face['name'],
                                 'image_path':str(target if i==0 else target.with_name(target.stem+'-back.png')),
                                 'frame_path':str((target if i==0 else target.with_name(target.stem+'-back.png')).with_suffix('.frame.png'))}
                                for i,face in enumerate(face_cards)] if len(face_cards)>1 else [],
                      'summary': card}, ensure_ascii=False))


if __name__ == '__main__':
    main()
