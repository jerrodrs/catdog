import json
from pathlib import Path
import sys
import zipfile

request = json.loads(Path(sys.argv[1]).read_text())
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED, compresslevel=4) as archive:
    archive.writestr('decklist.txt', request['decklist'])
    archive.writestr('deck.json', json.dumps(request['deck'], indent=2, ensure_ascii=False))
    for index, version in enumerate(request['versions'], 1):
        image = Path(version['image_path'])
        archive.write(image, f"cards/{index:03}-{image.stem}.png")
        for face in json.loads(version.get('faces_json') or '[]'):
            if face['label'] == 'back':
                back = Path(face['image_path'])
                archive.write(back, f"cards/{index:03}-{back.stem}.png")
