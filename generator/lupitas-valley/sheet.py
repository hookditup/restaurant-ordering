import glob
from PIL import Image, ImageDraw
fs = sorted(glob.glob('pv/*.png')); ims = [Image.open(f).convert('RGB') for f in fs]
S = Image.new('RGB', (1350, 520), 'white'); x = 0; y = 0
for k, (f, i) in enumerate(zip(fs, ims)):
    i.thumbnail((330, 230))
    if k == 4: x = 0; y = 260
    S.paste(i, (x, y + 14)); ImageDraw.Draw(S).text((x, y), f[3:], fill='black'); x += 336
S.save('pv_sheet.png')
