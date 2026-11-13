"""Reuse an explicitly selected illustration; never copy another deck's cosmetics by default."""
import copy,json,shutil,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
request_path=Path(sys.argv[1]).resolve();directory=request_path.parent
request=json.loads(request_path.read_text());source=request['reuse_source']
card=copy.deepcopy(request.get('current_base') or source['card'])
if not request.get('current_base'):
    for face in card.get('faces',[card]):
        for key in ('display_name','flavor_text','frame_style'):face.pop(key,None)
faces=card.get('faces',[card])
if len(faces)!=len(source['art_paths']):raise ValueError('The selected artwork has a different number of card faces.')
for i,(face,art_path) in enumerate(zip(faces,source['art_paths'])):
    original=Path(art_path).resolve(strict=True);saved=directory/('selected-art-'+str(i)+original.suffix.lower());shutil.copyfile(original,saved);face['art']=saved.name
    source_face=source['card'].get('faces',[source['card']])[i]
    source_dir=Path(source['manifest_path']).parent
    for field in ('art_prompt',):
        value=source_face.get(field)
        if isinstance(value,str):
            candidate=(source_dir/value).resolve()
            if candidate.is_file() and (candidate.is_relative_to(ROOT) or candidate.is_relative_to(Path(request['library_root']))):
                dest=directory/('source-'+str(i)+'-'+field+candidate.suffix);shutil.copyfile(candidate,dest);face[field]=dest.name
    snapshot=source_face.get('source',{}).get('snapshot')
    if isinstance(snapshot,str):
        candidate=(source_dir/snapshot).resolve()
        if candidate.is_file() and (candidate.is_relative_to(ROOT) or candidate.is_relative_to(Path(request['library_root']))):
            dest=directory/('source-snapshot-'+str(i)+candidate.suffix);shutil.copyfile(candidate,dest);face.setdefault('source',{})['snapshot']=dest.name
manifest=directory/'manifest.json';manifest.write_text(json.dumps({'cards':[card]},indent=2))
from studio.verify_result import main
sys.argv=[str(ROOT/'studio/verify_result.py'),str(manifest),str(directory)]
main()
