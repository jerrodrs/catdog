#!/usr/bin/env python3
"""Stands in for `python3 studio/mse_frames.py …` so Studio tests run without Magic Set Editor."""
import json
import sys
from pathlib import Path

args = sys.argv[2:]
TEMPLATES = [
    {'id': 'm15-showcase-test', 'name': 'Test Deco', 'full_name': 'Test Showcase', 'group': 'magic/M15 Frames/Booster Fun/Test Deco',
     'category': 'M15 Frames', 'ppi': 298, 'layout': 'normal', 'alias': True, 'missing_fonts': [], 'usable': True, 'sample': None},
    {'id': 'm15-split-test', 'name': 'Split', 'full_name': '', 'group': 'magic/M15 Frames/Standard/Split',
     'category': 'M15 Frames', 'ppi': 150, 'layout': 'special', 'alias': False, 'missing_fonts': [], 'usable': False, 'sample': None},
]
LAYOUTS = ['creature', 'artifact', 'enchantment', 'instant', 'sorcery', 'land', 'planeswalker', 'token', 'transform_front',
           'transform_back', 'adventure', 'prepare', 'saga']
if args[0] == 'catalog':
    print(json.dumps({'pack_revision': 'fixture', 'templates': TEMPLATES}))
elif args[0] == 'import':
    directory = Path(args[2])
    (directory/'previews').mkdir(parents=True, exist_ok=True)
    config = directory/'config.json'
    config.write_text(json.dumps({'schema_version': 3, 'renderer': 'mse', 'name': 'Test', 'mse': {'stylesheet': args[1], 'layouts': {}}}))
    (directory/'previews/contact-sheet.jpg').write_bytes(b'\xff\xd8\xff\xd9')
    print(json.dumps({'valid': True, 'layouts': LAYOUTS, 'proof_path': str(directory/'previews/contact-sheet.jpg'), 'config_path': str(config)}))
else:
    sys.exit('unexpected command')
