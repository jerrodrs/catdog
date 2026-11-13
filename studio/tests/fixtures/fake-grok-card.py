#!/usr/bin/env python3
"""Official Grok CLI protocol fixture; no network or real provider calls."""
import json,os,sys
from pathlib import Path
from PIL import Image
args=sys.argv[1:]
assert '--prompt-file' in args and '--output-format' in args
assert '--no-subagents' in args and '--no-plan' in args
assert os.environ.get('GROK_DISABLE_API_KEY_AUTH')=='true'
assert not os.environ.get('XAI_API_KEY')
prompt=Path(args[args.index('--prompt-file')+1]);directory=prompt.parent
request=json.loads((directory/'request.json').read_text())
assert request['image_generation']['provider']=='grok-cli'
assert 'ENTIRE card workflow' in prompt.read_text()
assert not (directory/'codex-prompt.txt').exists()
print(json.dumps({'type':'text','data':'Grok researched the fixture card and chose its own scene and naming.'}),flush=True)
if request.get('instructions')=='GROK_RATE_LIMIT_ONCE' and request.get('attempt',1)==1:
 print(json.dumps({'type':'error','message':'Rate limit exceeded (429). Retry after 0.01 seconds.'}),flush=True)
 sys.exit(1)
if request.get('instructions') in ('GROK_STALL_ONCE','GROK_STALL_ALWAYS') and (request.get('attempt',1)==1 or request['instructions']=='GROK_STALL_ALWAYS'):
 print(json.dumps({'type':'thought','data':'Reasoning before a stream that never finishes.'}),flush=True)
 import time
 time.sleep(60)
 sys.exit(0)
if request.get('instructions')=='GROK_BLOCKED':
 (directory/'result.json').write_text(json.dumps({'status':'blocked','message':'Fixture Grok image tool unavailable.','manifest_path':''}))
 sys.exit(0)
Image.new('RGB',(1500,2100),'#78946b').save(directory/'grok-art.png')
card={'id':'grok-sol-ring','name':request['card']['name'],'display_name':'Grok-crafted Hearthstone','type_line':'Artifact','mana_cost':'{1}','oracle_text':'{T}: Add {C}{C}.','colors':[],'color_identity':[],'layout':'normal','rarity':'uncommon','art':'grok-art.png','flavor_text':'A Grok-authored flavour line.'}
if request.get('art_prompt_contract',{}).get('mode')=='verbatim-style-v1':
    style=Path(request['style_file']).read_text()
    prompt='--- BEGIN DECK STYLE GUIDELINES (VERBATIM) ---\n'+style+'\n--- END DECK STYLE GUIDELINES ---\n\n--- CARD SCENE AND COMPOSITION ---\nA synthetic fixture scene.'
    (directory/'art-prompt.txt').write_text(prompt)
    for face in card.get('faces',[card]):face['art_prompt']='art-prompt.txt'
(directory/'manifest.json').write_text(json.dumps({'cards':[card]}))
scene={'shot_distance':'wide','viewpoint':'high_angle','subject_position':'right','pose':['resting'],'action':['glowing'],'setting':['stone','interior'],'lighting':['warm'],'summary':'A glowing artifact resting on stone inside a wide room.'}
if request.get('instructions')=='BATCH_TEST_VARIETY':scene['pose']=['test_'+request['card']['id']]
(directory/'scene.json').write_text(json.dumps(scene))
(directory/'result.json').write_text(json.dumps({'status':'completed','message':'Grok completed every creative step.','manifest_path':str(directory/'manifest.json')}))

if request.get('batch_consistency'):
    gallery=json.loads((Path(request['batch_consistency']['gallery_path'])/'index.json').read_text())
    peers=[v['version_id'] for v in gallery['cards'] if v['card_id']!=request['card']['id']]
    (directory/'batch-consistency-review.json').write_text(json.dumps({'batch_id':request['generation_batch']['id'],'reviewed_version_ids':peers[:3],'notes':'Synthetic protocol fixture: batch scope checked; not an AI visual assessment.'}))

print(json.dumps({'type':'tool_call','toolCallId':'fixture-image','toolName':'image_gen'}),flush=True)
print(json.dumps({'type':'end','stopReason':'end_turn','sessionId':'grok-fixture-session'}),flush=True)
