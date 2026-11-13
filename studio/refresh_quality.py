"""Re-render an immutable saved card without regenerating or reinterpreting art."""
import copy,json,sys,hashlib
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from cardforge.render import save_card,validate
from cardforge.faces import art_paths,face_cards,is_double

def refresh(request):
    source=Path(request['manifest_path']).resolve(strict=True);directory=Path(request['directory']).resolve();directory.mkdir(parents=True,exist_ok=True)
    document=json.loads(source.read_text());wanted=request.get('card_id')
    raw=next((c for c in document['cards'] if c['id']==wanted),document['cards'][0] if len(document['cards'])==1 else None)
    if raw is None: raise ValueError('Saved manifest has no matching card.')
    def resolve_card(card):
        card=copy.deepcopy(card)
        for face in card.get('faces',[card]):
            for field in ('art','art_prompt'):
                if face.get(field):
                    candidate=(source.parent/face[field]).resolve()
                    if field=='art' or candidate.is_file():face[field]=str(candidate.resolve(strict=field=='art'))
        return card
    card=resolve_card(raw);validate(card)
    base=source.parent/'source-manifest.json'
    base_doc=json.loads(base.read_text()) if base.exists() else {'cards':[raw]}
    base_raw=next((c for c in base_doc['cards'] if c['id']==raw['id']),raw)
    (directory/'source-manifest.json').write_text(json.dumps({'cards':[resolve_card(base_raw)]},indent=2,ensure_ascii=False))
    manifest=directory/'manifest.json';manifest.write_text(json.dumps({'cards':[card]},indent=2,ensure_ascii=False))
    arts=art_paths(card,source.parent);target=save_card(card,directory/'rendered',arts,dpi=1200)
    report_path=target.with_suffix('.report.json');report=json.loads(report_path.read_text())
    first=arts[0] if isinstance(arts,list) else arts
    with Image.open(first) as art:report['art_pixels_sha256']=hashlib.sha256(art.convert('RGB').tobytes()).hexdigest()
    report['quality_upgrade']={'source_version_id':request.get('source_version_id'),'source_manifest':str(source),'art_regenerated':False,'layout_coordinates_preserved':True}
    report_path.write_text(json.dumps(report,indent=2))
    (directory/'quality-upgrade.json').write_text(json.dumps(report['quality_upgrade'],indent=2))
    faces=[{'label':'front' if i==0 else 'back','name':face['name'],'image_path':str(target if i==0 else target.with_name(target.stem+'-back.png')),'frame_path':str((target if i==0 else target.with_name(target.stem+'-back.png')).with_suffix('.frame.png'))} for i,face in enumerate(card['faces'])] if is_double(card) else []
    return {'image_path':str(target),'frame_path':str(target.with_suffix('.frame.png')),'report_path':str(report_path),'manifest_path':str(manifest),'summary':card,'faces':faces}
if __name__=='__main__':print(json.dumps(refresh(json.loads(Path(sys.argv[1]).read_text())),ensure_ascii=False))
