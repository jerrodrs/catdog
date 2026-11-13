import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from cardforge.template_sets import preview_card,colour_matrix,REQUIRED_LAYOUTS
from cardforge.frames import KINDS
from cardforge.decorations import load_set
from cardforge.render import render
directory=Path(sys.argv[2]).resolve(strict=True)
config=None if sys.argv[1]=='--builtin' else load_set(sys.argv[1])
destination=directory/'previews';destination.mkdir(exist_ok=True)
if sys.argv[3]=='matrix':
    colour_matrix(config,destination)
elif sys.argv[3]=='layout':
    kind=sys.argv[4]
    if kind not in REQUIRED_LAYOUTS:raise ValueError('Unknown frame layout')
    card=preview_card(kind,config)
    render(card)[0].save(destination/(kind+'.png'))
    render(card,frame_only=True)[0].save(destination/(kind+'.frame.png'))
else:
    kind,family,legendary,alias=sys.argv[3:7]
    if kind not in REQUIRED_LAYOUTS or family not in KINDS or legendary not in ('normal','legendary') or alias not in ('plain','alias'):raise ValueError('Invalid frame preview variant')
    colors=[] if family=='C' else ['W','U','R'] if family=='M' else list(family)
    card=preview_card(kind,config,colors,legendary=='legendary',alias=='alias')
    image,_=render(card)
    image.save(destination/(f'{kind}.{family}.{legendary}.{alias}.png'))
