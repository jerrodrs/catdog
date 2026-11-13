#!/usr/bin/env python3
"""Run only inside the OS sandbox. Synthetic art is exclusively for tests."""
import json, os, pathlib, sys, subprocess
from PIL import Image
args=sys.argv[1:]
job=pathlib.Path('/work/job');r=json.loads((job/'sandbox-request.json').read_text())
assert os.getcwd()=='/work'
assert pathlib.Path('/work/card-style.txt').read_text()==(job/'style.txt').read_text()
assert not pathlib.Path('/home/jseger/magic-cards/catdog/library').exists()
assert not pathlib.Path('/home/jseger/.codex/generated_images').exists()
assert not pathlib.Path('/work/library').exists()
assert not pathlib.Path('/work/studio/server.mjs').exists()
assert pathlib.Path('/work/assets/fonts/Beleren2016-Bold.ttf').is_file()
if r.get('instructions')=='SANDBOX_RATE_ONCE' and r.get('attempt',1)==1:
    print(json.dumps({'type':'turn.failed','error':{'message':'Rate limit exceeded (429).'}}),flush=True)
    sys.exit(1)
Image.new('RGB',(1500,2100),(44,67,93)).save(job/'art.png')
card={'id':'sol-ring','name':'Sol Ring','type_line':'Artifact','oracle_text':'{T}: Add {C}{C}.','mana_cost':'{1}','colors':[],'rarity':'uncommon','art':'/work/job/art.png','art_prompt':'/work/job/art-prompt.txt'}
style=(job/'style.txt').read_text();(job/'art-prompt.txt').write_text('--- BEGIN DECK STYLE GUIDELINES (VERBATIM) ---\n'+style+'\n--- END DECK STYLE GUIDELINES ---\n\n--- CARD SCENE AND COMPOSITION ---\nA test scene.\n')
(job/'scene.json').write_text(json.dumps({'shot_distance':'macro','viewpoint':'overhead','subject_position':'center','pose':['resting'],'action':['illuminating'],'setting':['table'],'lighting':['cool'],'summary':'Synthetic test object.'}))
(job/'manifest.json').write_text(json.dumps({'cards':[card]}))
subprocess.run(['python3','-m','cardforge','check',str(job/'manifest.json')],check=True)
subprocess.run(['python3','-m','cardforge','render',str(job/'manifest.json'),'--out',str(job/'sandbox-render')],check=True)
(job/'result.json').write_text(json.dumps({'status':'completed','message':'Isolated fixture passed filesystem checks.','manifest_path':'/work/job/manifest.json'}))

if r.get('batch_consistency'):
    gallery=json.loads((pathlib.Path(r['batch_consistency']['gallery_path'])/'index.json').read_text())
    peers=[v['version_id'] for v in gallery['cards'] if v['card_id']!=r['card']['id']]
    (job/'batch-consistency-review.json').write_text(json.dumps({'batch_id':r['generation_batch']['id'],'reviewed_version_ids':peers[:3],'notes':'Synthetic protocol fixture: batch scope checked; not an AI visual assessment.'}))

(job/'sandbox-probe.json').write_text(json.dumps({'cwd':os.getcwd(),'history':r.get('previous_version') is not None,'reference_images':len(r.get('style_context',{}).get('reference_images',[])),'library_access':False,'root_defaults':False}))
if '--prompt-file' in args:print(json.dumps({'type':'end','stopReason':'end_turn','sessionId':'isolated-grok-fixture'}))
else:print(json.dumps({'type':'thread.started','thread_id':'isolated-codex-fixture'}))
