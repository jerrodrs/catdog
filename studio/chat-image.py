"""Bound vision input size for CLI argv limits; never modify original artwork."""
import sys
from PIL import Image, ImageOps
image = ImageOps.exif_transpose(Image.open(sys.argv[1])).convert('RGB')
image.thumbnail((1100, 1100))
for _ in range(12):
    image.save(sys.argv[2], 'JPEG', quality=62, optimize=True)
    if __import__('os').path.getsize(sys.argv[2]) <= 27000:
        break
    image.thumbnail((int(image.width * .85), int(image.height * .85)))
