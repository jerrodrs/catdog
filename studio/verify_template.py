import json
from pathlib import Path
import sys
# --final: the designer has finished; differences from sibling options are then reported, not failed.
FINAL='--final' in sys.argv
if FINAL:sys.argv.remove('--final')
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from cardforge.template_sets import check_and_preview,apply_controls,drop_designer_positions
from cardforge.decorations import load_set
directory=Path(sys.argv[2]).resolve(strict=True)
if sys.argv[1]=='--builtin':
    config=None;data=None
else:
    config=Path(sys.argv[1]).resolve(strict=True)
    if not config.is_relative_to(directory): raise ValueError('Frame configuration must be inside its version directory.')
    data=json.loads(config.read_text())
request=json.loads(Path(sys.argv[3]).read_text()) if len(sys.argv)>3 else {}
removed=[]
if len(sys.argv)>3 and data is not None:
    # Generated designs may not set card positions; only the user's editor measurements survive.
    if request.get('design_process'):removed=drop_designer_positions(data,request.get('controls',{}))
    data=apply_controls(data,request.get('controls',{}));config.write_text(json.dumps(data,indent=2))
if config is not None:data=load_set(config)
result=check_and_preview(data,directory/'previews')
if config is not None and request.get('design_process'):
    # Flavour level delivered, distinct from the user's other sets, and proofed on real illustrations.
    sys.path.insert(0,str(Path(__file__).resolve().parent))
    from frame_review import review
    try:result['design_review']=review(data,request,directory,directory/'previews',final=FINAL)
    except ValueError as e:sys.exit(str(e))
if removed:result['removed_positions']={'keys':removed,'note':'Position offsets are the user\'s editor measurements; designer values were removed. Use rules_sizing and padding instead.'}
print(json.dumps({**result,'config_path':str(config) if config else None}))
