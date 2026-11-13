"""Trusted transient editor proof and saved annotated generation reference."""
import base64,io,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from PIL import ImageDraw
from cardforge.template_sets import apply_controls,preview_card,REQUIRED_LAYOUTS
from cardforge.render import render,font,PROFILES,text_plan
from cardforge.frames import CONFIG
from cardforge.decorations import load_set

def main():
    request=json.loads(Path(sys.argv[1]).read_text()) if len(sys.argv)>1 else json.load(sys.stdin)
    config_path=request.get('config_path') or (request.get('previous') or {}).get('config_path')
    config=load_set(config_path) if config_path else None
    controls=request.get('controls',{})
    changed=any(v is not None and v!='agent' for v in controls.values())
    if config is None and changed:
        # A custom revision starts from the included family's colours, not another deck theme.
        config={'schema_version':1,'name':request.get('name','Frame editor'),'style':{'shape':'classic','rail_width':12,'panel_color':CONFIG['panel_fill'],'panel_alpha':CONFIG['panel_alpha'],'text_color':CONFIG['ink']},'palettes':json.loads(json.dumps(CONFIG['colors'])),'layouts':{k:{} for k in REQUIRED_LAYOUTS}}
    if config is not None:config=apply_controls(config,controls)
    ctx=request.get('context') or next(iter(request.get('visual_edits',{}).get('annotations',[])),{})
    kind=ctx.get('layout','creature');family=ctx.get('family','G')
    colors=[] if family=='C' else ['W','U','R'] if family=='M' else list(family)
    card=preview_card(kind,config,colors,ctx.get('legendary',False),ctx.get('alias',False))
    # Real artwork is a live-proof convenience only; the annotated generation reference keeps the neutral placeholder.
    image,report=render(card,request.get('art_path') if len(sys.argv)<=2 else None)
    if len(sys.argv)>2:
        d=ImageDraw.Draw(image)
        for i,annotation in enumerate(request.get('visual_edits',{}).get('annotations',[])):
            if annotation['layout']!=kind or annotation['family']!=family or annotation['legendary']!=ctx.get('legendary',False) or annotation['alias']!=ctx.get('alias',False):continue
            x,y,w,h=annotation['rect'];box=(round(x*1500),round(y*2100),round((x+w)*1500),round((y+h)*2100))
            d.rectangle(box,outline='#FFB03A',width=7);d.rectangle((box[0],box[1],box[0]+48,box[1]+48),fill='#FFB03A');d.text((box[0]+8,box[1]+4),str(i+1),font=font('collector',32),fill='#15251B')
        image.save(sys.argv[2]);print(json.dumps({'image_path':sys.argv[2]}));return
    image.thumbnail((750,1050));buf=io.BytesIO();image.save(buf,format='PNG')
    print(json.dumps({'image':'data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode(),'geometry':report['geometry'],'alignment':report['alignment'],'type_top':report['type_top'],'controls':controls,'context':ctx,'resolved_positions':{'rules_offset_y':report['type_top']-text_plan(card).get('type_top',PROFILES[card.get('profile','standard')])}}))
if __name__=='__main__':main()
