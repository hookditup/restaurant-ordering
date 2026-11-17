import glob, os, subprocess
from PIL import Image
import segno
root = os.path.dirname(os.path.abspath(__file__)); site = root + '/site'
os.makedirs(site + '/menus/img', exist_ok=True); os.makedirs(site + '/qr', exist_ok=True)
tmp = root + '/pdfpng'; os.makedirs(tmp, exist_ok=True)
for f in glob.glob(root + '/assets/menus/*.pdf'):
    s = os.path.basename(f)[:-4]
    subprocess.run(['pdftoppm', '-r', '130', '-png', f, f'{tmp}/{s}'], check=True)
for p in glob.glob(tmp + '/*.png'):
    n = os.path.basename(p)[:-4]
    Image.open(p).convert('RGB').save(f'{site}/menus/img/{n}.webp', quality=78, method=6)
logo = Image.open(root + '/assets/img/site/raw-logo').convert('RGBA')
sq = logo.crop((0, 0, logo.height, logo.height)); sq.thumbnail((64, 64)); sq.save(site + '/img/site/favicon.png')
for k, path in {'review': '/review', 'rewards': '/rewards', 'questions': '/questions', 'reservations': '/reservations'}.items():
    q = segno.make('https://lupitasvalley.com' + path, error='h')
    q.save(f'{site}/qr/{k}.png', scale=20, border=3, dark='#000000', light='#ffffff')
    q.save(f'{site}/qr/{k}.svg', scale=10, border=3)
