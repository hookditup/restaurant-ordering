#!/usr/bin/env python3
"""Turn the Owner.com menu data for Tacos El Guero into the import_menu() payload.
Source: menu page data on tacoselguerout.com, taken Nov 18, 2026 (owner-export.json).
Run: python3 build_seed.py [folder for menu photos]"""
import io, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_IMG = sys.argv[1] if len(sys.argv) > 1 else None
d = json.load(open(f'{HERE}/owner-export.json', encoding='utf8'))
m = d['menu']
ITEMS = {i['id']: i for i in m['items']}
SETS = {s['id']: s for s in m['modifierSets']}
MODS = {x['id']: x for x in m['modifiers']}
DAY = {'monday': 'mon', 'tuesday': 'tue', 'wednesday': 'wed', 'thursday': 'thu', 'friday': 'fri', 'saturday': 'sat', 'sunday': 'sun'}


def t24(s):
    h, mi, ap = re.match(r'(\d+):(\d+) (AM|PM)', s).groups()
    return f'{int(h) % 12 + (12 if ap == "PM" else 0):02d}:{mi}'


def hours(raw):
    return {short: [[t24(x['start']), t24(x['end'])] for x in (raw.get(name) or {}).get('hours', [])]
            for name, short in DAY.items() if (raw.get(name) or {}).get('open')}


def slug(s):
    s = s.lower()
    for a, b in (('ñ', 'n'), ('é', 'e'), ('í', 'i'), ('ó', 'o'), ('á', 'a'), ('ú', 'u'), ('&', ' and ')):
        s = s.replace(a, b)
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]', '-', s)).strip('-')


def image(i):
    if not i.get('image'):
        return None
    s = slug(i['name'])
    if SITE_IMG:
        path = f'{SITE_IMG}/{s}.webp'
        if not os.path.exists(path):
            try:
                from PIL import Image
                raw = urllib.request.urlopen(i['image'], timeout=30).read()
                im = Image.open(io.BytesIO(raw))
                bg = Image.new('RGB', im.size, (255, 255, 255))
                bg.paste(im.convert('RGBA'), mask=im.convert('RGBA').split()[3])
                bg.thumbnail((800, 800))
                bg.save(path, quality=80, method=6)
            except Exception as e:
                print('no image for', i['name'], e)
                return None
    return f'/img/menu/{s}-heber-city.webp'


used, queue = [], [x for i in m['items'] for x in i['modifierSets']]
while queue:
    g = queue.pop(0)
    if g in used:
        continue
    used.append(g)
    for o in SETS[g]['modifiers']:
        queue += MODS[o]['modifierSets']

groups = [{'id': g, 'name': SETS[g]['name'], 'min': SETS[g]['min'], 'max': SETS[g]['max'], 'options': [
    {'id': o, 'name': MODS[o]['name'], 'price_cents': MODS[o]['amount'], 'sort': n, 'groups': MODS[o]['modifierSets']}
    for n, o in enumerate(SETS[g]['modifiers'])]} for g in used]

cats = []
for sort, c in enumerate(m['categories']):
    cats.append({'id': c['id'], 'name': c['name'], 'description': c.get('description'), 'note': None, 'hours': None, 'sort': sort,
                 'items': [{'id': i['id'], 'name': i['name'], 'description': i['description'], 'price_cents': i['amount'], 'image': image(i),
                            'allergens': i['allergens'], 'gluten_free': bool(i['glutenFree']), 'vegetarian': bool(i['vegetarian']),
                            'popular': bool(i['popular']), 'sort': n, 'groups': i['modifierSets']}
                           for n, i in enumerate(ITEMS[x] for x in c['items'])]})

loc = d['location']
payload = {'restaurant': {
    'slug': 'tacos-el-guero', 'name': 'Tacos El Güero', 'phone': loc['contact']['phone'], 'email': loc['contact']['email'],
    'address': '281 N Main St, Heber City, UT 84032', 'timezone': 'America/Denver', 'hours': hours(loc['hours']['store']),
    'tax_rate_bps': 865, 'guest_fee_bps': 0, 'pickup_lead_minutes': 15, 'alert_email': None, 'site_url': 'https://tacoselguerout.com'},
    'groups': groups, 'categories': cats}
json.dump(payload, open(f'{HERE}/tacos-el-guero-seed.json', 'w', encoding='utf8'), ensure_ascii=False)
print('categories', len(cats), 'items', sum(len(c['items']) for c in cats), 'groups', len(groups), 'options', sum(len(g['options']) for g in groups))
print('hours', payload['restaurant']['hours'])
