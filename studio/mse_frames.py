"""Magic Set Editor template library for Frame Studio: catalogue, frame-set import and gallery previews.

  catalog                      print the template catalogue as JSON
  import STYLE DIRECTORY       write DIRECTORY/config.json for a template, then validate and preview every layout
  gallery ART OUT [STYLE…]     render a sample card per template (missing previews only) to OUT/<style>.jpg
"""
import json
from pathlib import Path
import sys
import traceback

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from cardforge import mse
from cardforge.render import render
from PIL import Image

GALLERY_CARD = {'id': 'template-preview', 'name': 'Template Preview', 'display_name': 'Wandering Explorer',
                'type_line': 'Legendary Creature — Cat Scout', 'mana_cost': '{2}{G}{G}', 'colors': ['G'], 'rarity': 'mythic',
                'oracle_text': 'Vigilance\nWhenever this creature attacks, draw a card.\n{T}: Add {G}.',
                'flavor_text': 'Every road begins with a single step.', 'power': '3', 'toughness': '4'}


def main():
    command = sys.argv[1]
    if command == 'catalog':
        print(json.dumps(mse.catalog()))
    elif command == 'import':
        style, directory = sys.argv[2], Path(sys.argv[3]).resolve(strict=True)
        config = mse.frame_config(style)
        target = directory/'config.json'
        target.write_text(json.dumps(config, indent=2)+'\n')
        from cardforge.decorations import load_set
        from cardforge.template_sets import check_and_preview
        result = check_and_preview(load_set(target), directory/'previews')
        print(json.dumps({**result, 'config_path': str(target)}))
    elif command == 'gallery':
        art, out = Path(sys.argv[2]).resolve(strict=True), Path(sys.argv[3])
        out.mkdir(parents=True, exist_ok=True)
        styles = sys.argv[4:] or [t['id'] for t in mse.catalog()['templates'] if t['usable']]
        for style in styles:
            target = out/f'{style}.jpg'
            if target.exists() or (out/f'{style}.failed').exists():
                continue
            try:
                image, _ = render({**GALLERY_CARD, 'frame_style': mse.frame_config(style)}, art, dpi=600)
                image.resize((500, 700), Image.Resampling.LANCZOS).save(target, quality=88)
            except Exception:
                (out/f'{style}.failed').write_text(traceback.format_exc()[-4000:])
            print(json.dumps({'style': style, 'ok': target.exists()}), flush=True)


if __name__ == '__main__':
    main()
