import json,sys
from pathlib import Path
from PIL import Image
r=json.loads(Path(sys.argv[1]).read_text());faces=[]
for index,item in enumerate(r['faces']):
    with Image.open(item['image_path']) as image:
        faces.append({'label':item['label'],'width':image.width,'height':image.height,'effective_ppi':round(min(image.width/2.5,image.height/3.5),1)})
report={}
if r.get('report_path') and Path(r['report_path']).is_file():
    try:report=json.loads(Path(r['report_path']).read_text())
    except (ValueError,OSError):pass
print(json.dumps({'faces':faces,'text_ppi':report.get('dpi') if report.get('text_rendering')=='native-font-rasterization' else None,'art':report.get('art_resolution'),'reconstruction':report.get('reconstruction'),'color_space':report.get('color_space'),'note':'Pixel resolution is measured at 63.5 x 88.9 mm. Saved artwork may already have been enlarged.'}))
