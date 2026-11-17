import glob, os, sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
for d, mw in (('img/menu', 800), ('img/site', 1600)):
    os.makedirs(os.path.join(out, d), exist_ok=True)
    for f in glob.glob(os.path.join(src, d, 'raw-*')):
        n = os.path.basename(f)[4:]
        im = Image.open(f)
        if n == 'logo':
            im.thumbnail((600, 600)); im.save(os.path.join(out, d, 'logo.png'), optimize=True); continue
        im = im.convert('RGB'); im.thumbnail((mw, mw)); im.save(os.path.join(out, d, n + '.webp'), quality=80, method=6)
