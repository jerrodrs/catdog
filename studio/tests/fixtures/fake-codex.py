#!/usr/bin/env python3
"""Codex protocol fixture; synthetic artwork is used only in automated tests."""
import json
from pathlib import Path
import sys
import time
from PIL import Image, ImageDraw

args = sys.argv[1:]
output = Path(args[args.index('-o') + 1])
directory = output.parent
request_file=directory/'request.json'
if not request_file.exists():request_file=directory.parent/'request.json'
request = json.loads(request_file.read_text())
if request.get('task')=='extract_art_direction':
    assert args[-2]=='--', 'Image arguments must not consume the prompt'
    if request.get('instructions')=='RATE_LIMIT_ONCE' and directory.name=='attempt-1':
        print(json.dumps({'type':'turn.failed','error':{'message':'Selected model is at capacity.'}}),flush=True)
        sys.exit(1)
    sections={key:('Extracted '+key+' reference guidance.') for key in ['art_style','composition','characters','world','lighting','palette']}
    output.write_text(json.dumps({'status':'completed','sections':sections,'message':'Synthetic reference-analysis fixture.'}))
    print(json.dumps({'type':'turn.completed'}),flush=True)
    sys.exit(0)
if 'card' not in request:

    root=Path(__file__).resolve().parents[3]
    # Each option's target flavour level gets an example set that genuinely delivers it.
    target=(request.get('candidate') or {}).get('target') or 'classic'
    source={'classic':root/'examples/frame-set.json','stylised':root/'examples/frame-sets/art-deco.json','showcase':root/'examples/frame-sets/showcase-observatory.json'}[target]
    config=json.loads(source.read_text())
    config['name']=request['name']
    if config.get('textures'):
        import shutil;shutil.copytree(source.parent/'assets',directory/'assets',dirs_exist_ok=True)
    (directory/'config.json').write_text(json.dumps(config))
    (directory/'concept.json').write_text(json.dumps({'concepts':[{'name':'Fixture '+target,'motif':'test','materials':'test','signature_element':'test','flavour_level':target},{'name':'Alternative','flavour_level':'classic'}],'chosen':0,'rationale':'Fixture.'}))
    output.write_text(json.dumps({'status':'completed','config_path':str(directory/'config.json'),'message':'Synthetic template protocol fixture.'}))
    print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Fixture frame design ready.'}}),flush=True)
    sys.exit(0)
assert 'ONE card' in (directory / 'codex-prompt.txt').read_text()
assert args[:3] == ['exec', '--json', '--skip-git-repo-check']
print(json.dumps({'type': 'thread.started', 'thread_id': 'fixture-thread'}), flush=True)
print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'Fixture creates a deterministic renderer input.'}}), flush=True)
if request['card']['name'].startswith('Slow Card'):
    time.sleep(30)
if request['card']['name'].startswith('Rate Limited') and (request.get('attempt', 1) == 1 or 'Forever' in request['card']['name']):
    print(json.dumps({'type': 'turn.failed', 'error': {'code': 'rate_limit_exceeded', 'message': 'Rate limit exceeded (429).'}}), flush=True)
    sys.exit(1)
if request['card']['name']=='Capacity Once' and request.get('attempt',1)==1:
    print('Unable to locate review image contact-sheet.png',file=sys.stderr)
    print(json.dumps({'type':'turn.failed','error':{'message':'Selected model is at capacity. Please try a different model.'}}),flush=True)
    sys.exit(1)
if request['card']['name'] == 'Blocked Card':
    output.write_text(json.dumps({'status': 'blocked', 'message': 'Image generation unavailable in test fixture.', 'manifest_path': ''}))
    sys.exit(0)
image = Image.new('RGB', (1500, 2100), '#78946b')
draw = ImageDraw.Draw(image)
variant = request['card'].get('variant_index', 0)
for y in range(2100):
    draw.line((0, y, 1499, y), fill=(80 + variant % 100, 90 + y % 90, 70))
image.save(directory / 'art.png')
card = {'id': 'fixture-sol-ring', 'name': request['card']['name'],
        'display_name': 'Revised Hearthstone' if request['type'] == 'revise' else 'The Hearthstone',
        'mana_cost': '{1}', 'type_line': 'Artifact', 'oracle_text': '{T}: Add {C}{C}.',
        'flavor_text': 'A little warmth goes a long way.', 'colors': [], 'color_identity': [],
        'layout': 'normal', 'rarity': 'uncommon', 'profile': 'standard', 'art': 'art.png'}
manifest = directory / 'manifest.json'
if request['card']['name']=='Fixture Transform':
    face={'id':'fixture-transform-front','name':'Fixture Transform','type_line':'Creature — Cat','oracle_text':'When this creature dies, transform it.','mana_cost':'{1}{W}','colors':['W'],'power':'2','toughness':'2','art':'art.png'}
    back={'id':'fixture-transform-back','name':'Fixture Ascended','type_line':'Legendary Planeswalker — Test','oracle_text':'+1: Draw a card.\n−2: Create a 1/1 white Cat creature token.','colors':['W'],'loyalty':'3','art':'art.png'}
    card={'id':'fixture-transform','name':'Fixture Transform','layout':'transform','faces':[face,back]}
if request['card']['name'] in ('Bonecrusher Giant','Emeritus of Ideation'):
    import subprocess
    root=Path(__file__).resolve().parents[3]
    slug='bonecrusher-giant' if request['card']['name']=='Bonecrusher Giant' else 'emeritus-of-ideation'
    subprocess.run([sys.executable,'-m','cardforge','import',str(root/'data'/f'{slug}.scryfall.json'),'--out',str(manifest)],cwd=root,check=True,capture_output=True)
    card=json.loads(manifest.read_text())['cards'][0]
    card['art']='art.png'
if request['card']['name']=='Urabrask':
    import subprocess
    root=Path(__file__).resolve().parents[3]
    subprocess.run([sys.executable,'-m','cardforge','import',str(root/'data/urabrask.scryfall.json'),'--out',str(manifest)],cwd=root,check=True,capture_output=True)
    card=json.loads(manifest.read_text())['cards'][0]
    Image.new('RGB',(1500,2100),'#8c684a').save(directory/'back-art.png')
    card['faces'][0]['art']='art.png'
    card['faces'][1]['art']='back-art.png'
if request.get('art_prompt_contract',{}).get('mode')=='verbatim-style-v1':
    style=Path(request['style_file']).read_text()
    prompt='--- BEGIN DECK STYLE GUIDELINES (VERBATIM) ---\n'+style+'\n--- END DECK STYLE GUIDELINES ---\n\n--- CARD SCENE AND COMPOSITION ---\nA synthetic fixture scene.'
    (directory/'art-prompt.txt').write_text(prompt)
    for face in card.get('faces',[card]):face['art_prompt']='art-prompt.txt'
manifest.write_text(json.dumps({'cards': [card]}))
output.write_text(json.dumps({'status': 'completed', 'message': 'Fixture complete.', 'manifest_path': str(manifest)}))
scene = {'shot_distance': 'macro', 'viewpoint': 'overhead', 'subject_position': 'center',
         'pose': ['resting'], 'action': ['still life'], 'setting': ['tabletop'],
         'lighting': ['soft daylight'], 'summary': 'A small object resting on a tabletop, viewed from above.'}
if variant:
    for field in ('shot_distance', 'viewpoint', 'subject_position'):
        scene[field] = request['card']['scene_plan'][field]
    scene['pose'] = [request['card']['scene_plan']['pose_options'].split(',')[0].strip()]
if request.get('instructions')=='BATCH_TEST_VARIETY':scene['pose']=['test_'+request['card']['id']]
(directory / 'scene.json').write_text(json.dumps(scene))

if request.get('batch_consistency'):
    gallery=json.loads((Path(request['batch_consistency']['gallery_path'])/'index.json').read_text())
    peers=[v['version_id'] for v in gallery['cards'] if v['card_id']!=request['card']['id']]
    (directory/'batch-consistency-review.json').write_text(json.dumps({'batch_id':request['generation_batch']['id'],'reviewed_version_ids':peers[:3],'notes':'Synthetic protocol fixture: batch scope checked; not an AI visual assessment.'}))

print(json.dumps({'type': 'turn.completed'}), flush=True)
