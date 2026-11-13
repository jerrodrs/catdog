import argparse
import json
import sys
from pathlib import Path

from PIL import Image

from .render import LayoutError, font, save_card, validate, text_plan


def main():
    parser = argparse.ArgumentParser(description='Deterministic borderless card compositor')
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('render', 'check'):
        p = sub.add_parser(command)
        p.add_argument('manifest', type=Path)
        p.add_argument('--out', type=Path, default=Path('output/cards'))
        p.add_argument('--proof', action='store_true', help='Allow clearly marked art placeholders')
        p.add_argument('--guides', action='store_true')
        p.add_argument('--dpi',type=int,choices=(600,1200),default=1200)
    p = sub.add_parser('import')
    p.add_argument('snapshot', type=Path, help='Saved Scryfall card object or list response')
    p.add_argument('--out', type=Path, required=True)
    p = sub.add_parser('frames', help='Export reusable colour/legendary frame templates and a proof sheet')
    p.add_argument('--out', type=Path, default=Path('assets/templates/borderless-v2'))
    p.add_argument('--proof-out', type=Path, default=Path('output/frame-templates-v2'))
    args = parser.parse_args()
    try:
        if args.command == 'frames':
            from .frames import export_library
            from .render import render
            from PIL import ImageDraw
            variants = export_library(args.out)
            args.proof_out.mkdir(parents=True, exist_ok=True)
            sheet = Image.new('RGB', (6*320+20, 6*480+20), '#18222b')
            for n, variant in enumerate(variants):
                color = variant['id'].split('-')[0]
                colors = list(color) if len(color) == 2 else ([] if color == 'C' else list('WUR') if color == 'M' else [color])
                card = dict(id=variant['id'], name='Original Card Name', display_name=variant['id'],
                            type_line=('Legendary ' if variant['legendary'] else '')+'Creature — Cat',
                            oracle_text='{T}: Add {C}.\nWhenever this creature attacks, draw a card.',
                            flavor_text='A familiar face along every road.', colors=colors,
                            mana_cost='{2}'+''.join('{'+c+'}' for c in colors), power='2', toughness='3',
                            art_credit='Frame template proof')
                image, _ = render(card)
                x, y = 20+(n%6)*320, 20+(n//6)*480
                sheet.paste(image.resize((300, 420), Image.Resampling.LANCZOS), (x, y))
                ImageDraw.Draw(sheet).text((x+4, y+431), variant['id'], fill='#f4efdf', font=font('collector', 23))
            sheet.save(args.proof_out/'template-matrix.jpg', quality=94)
            print(f"Exported {len(variants)} reusable templates to {args.out}")
            print(args.proof_out/'template-matrix.jpg')
            return
        if args.command == 'import':
            data = json.loads(args.snapshot.read_text())
            raw = data if isinstance(data, list) else data.get('data', [data])
            cards = []
            from .render import digest
            import re
            for n, item in enumerate(raw, 1):
                if item.get('layout') not in ('normal','token','transform','modal_dfc','adventure','prepare','saga','class'):
                    raise LayoutError(f"{item.get('name')}: dedicated layout required")
                fields = ('name', 'mana_cost', 'type_line', 'oracle_text', 'colors',
                          'color_identity', 'power', 'toughness', 'loyalty', 'rarity', 'layout')
                card = {k: item[k] for k in fields if k in item}
                card.update(id=re.sub(r'[^a-z0-9]+', '-', item['name'].lower()).strip('-'),
                            collector_number=f'{n:03}', set_code='CUSTOM',
                            source={'oracle_id': item.get('oracle_id'), 'scryfall_id': item.get('id'),
                                    'url': item.get('scryfall_uri'),
                                    'snapshot_sha256': digest(args.snapshot)})
                if item.get('layout') in ('transform','modal_dfc'):
                    card['name']=item['card_faces'][0]['name']
                    card['faces']=[]
                    for index,face in enumerate(item['card_faces']):
                        part={k:face[k] for k in fields if k in face and k!='layout'}
                        part.update(id=card['id']+('-front' if index==0 else '-back'),layout='normal',rarity=item.get('rarity','rare'),source=card['source'])
                        if 'Saga' in part.get('type_line',''):part['layout']='saga'
                        card['faces'].append(part)
                if item.get('layout') in ('adventure','prepare'):
                    front,spell=item['card_faces']
                    primary={k:front[k] for k in fields if k in front and k!='layout'}
                    card.update(primary)
                    card['colors']=front.get('colors',front.get('color_indicator',[c for c in 'WUBRG' if re.search(r'\{[^}]*'+c+r'[^}]*\}',front.get('mana_cost',''))]))
                    card['spell']={k:spell[k] for k in fields if k in spell and k not in ('layout','power','toughness','loyalty')}
                    card['spell'].update(id=card['id']+'-spell',colors=spell.get('colors',[c for c in 'WUBRG' if re.search(r'\{[^}]*'+c+r'[^}]*\}',spell.get('mana_cost',''))]),source=card['source'])
                validate(card)
                cards.append(card)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps({'cards': cards}, indent=2, ensure_ascii=False)+'\n')
            print(f'Imported {len(cards)} cards; original Oracle text preserved')
            return
        manifest = json.loads(args.manifest.read_text())
        if not isinstance(manifest.get('cards'), list) or not manifest['cards']:
            raise LayoutError('Manifest must contain a nonempty cards array')
        ids, paths = set(), []
        # Preflight the entire batch before writing any files.
        from .render import render
        for card in manifest['cards']:
            validate(card)
            if card['id'] in ids:
                raise LayoutError(f"Duplicate card id: {card['id']}")
            ids.add(card['id'])
            from .faces import art_paths, is_double
            art = art_paths(card,args.manifest.parent)
            if (art is None or isinstance(art,list) and any(p is None for p in art)) and not args.proof:
                raise LayoutError(f"{card['id']}: missing art; use --proof for layout proofs")
            render(card, art, args.guides, dpi=args.dpi)
            paths.append(art)
        if args.command == 'check':
            print(f"PASS: {len(ids)} cards fit; fonts, symbols, layout and art validated")
            return
        images = []
        for card, art in zip(manifest['cards'], paths):
            path = save_card(card, args.out, art, args.guides, dpi=args.dpi)
            images.append(path)
            if is_double(card):
                images.append(path.with_name(path.stem+'-back.png'))
            print(path)
        # Contact sheet for reviewing consistency across the deck.
        columns = min(4, len(images))
        thumb = (375, 525)
        sheet = Image.new('RGB', (columns*395+20, ((len(images)+columns-1)//columns)*545+20), '#131b23')
        for n, path in enumerate(images):
            with Image.open(path) as im:
                sheet.paste(im.resize(thumb, Image.Resampling.LANCZOS), (20+(n%columns)*395, 20+(n//columns)*545))
        sheet.save(args.out/'contact-sheet.jpg', quality=95)
    except (LayoutError, OSError, ValueError, KeyError, TypeError) as exc:
        print(f'FAIL: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
