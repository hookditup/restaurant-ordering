# Renders each menu PDF page sharp enough for high-density screens.
# Pages are shown at 1.75 CSS px per PDF point (so a small card menu isn't stretched across the page),
# rendered at twice that, capped at 2400 px wide. The build shows each image at half its pixel width.
import glob, os, subprocess, sys, tempfile
from PIL import Image
site = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'site')
MENUS = ['dinner', 'brunch', 'appetizers', 'kids', 'desserts', 'soft-drinks', 'spirits-cocktails']
for s in MENUS:
    pdf = f'{site}/menus/{s}-menu-heber-city.pdf'
    info = subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout
    w_pt = float([l for l in info.splitlines() if l.startswith('Page size')][0].split()[2])
    dpi = min(3.5 * 72, 2400 / (w_pt / 72))
    with tempfile.TemporaryDirectory() as t:
        subprocess.run(['pdftoppm', '-r', f'{dpi:.1f}', '-png', pdf, f'{t}/p'], check=True)
        for k, p in enumerate(sorted(glob.glob(f'{t}/p*.png')), 1):
            out = f'{site}/menus/img/{s}-{k}-heber-city.webp'
            Image.open(p).convert('RGB').save(out, quality=82, method=6)
            print(s, k, Image.open(out).size, f'{os.path.getsize(out)//1024} KB')
