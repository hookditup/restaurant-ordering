#!/usr/bin/env python3
"""Turn the Owner.com menu export into the import_menu() payload for Lupita's Valley.

The export was taken at night, so Enchiladas and Traditional Dishes hold the dinner
versions. lunch.json holds the daytime prices and text seen on the live page.
Lunch option groups match the Nov 4, 2026 daytime check of the live menu.
"""
import json, os, re, sys, urllib.request

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
    h = int(h) % 12 + (12 if ap == 'PM' else 0)
    return f'{h:02d}:{mi}'


def hours(raw, store):
    out = {}
    for name, short in DAY.items():
        v = raw.get(name) or {}
        if not v.get('open'):
            continue
        spans = [[t24(x['start']), t24(x['end'])] for x in v.get('hours', [])]
        out[short] = spans or store.get(short, [])
    return out


store = hours(d['location']['hours']['store'], {})
slug = lambda s: re.sub(r'-+', '-', ''.join(c if c.isalnum() else '-' for c in s.lower().replace('ñ', 'n').replace('é', 'e').replace('í', 'i'))).strip('-')


def image(i):
    s = slug(i['name'])
    if SITE_IMG and i.get('image'):
        path = f'{SITE_IMG}/{s}.webp'
        if not os.path.exists(path):
            try:
                from PIL import Image
                import io
                raw = urllib.request.urlopen(i['image'].replace('\\', ''), timeout=30).read()
                im = Image.open(io.BytesIO(raw)).convert('RGB')
                im.thumbnail((800, 800))
                im.save(path, quality=80, method=6)
            except Exception as e:
                print('no image for', i['name'], e)
                return None
    return f'/img/menu/{s}-heber-city.webp' if i.get('image') else None


used, queue = [], [x for i in m['items'] for x in i['modifierSets']]
while queue:
    g = queue.pop()
    if g in used:
        continue
    used.append(g)
    for o in SETS[g]['modifiers']:
        queue += MODS[o]['modifierSets']

groups = []
for g in used:
    s = SETS[g]
    groups.append({'id': s['id'], 'name': s['name'], 'min': s['min'], 'max': s['max'], 'options': [
        {'id': o, 'name': MODS[o]['name'], 'price_cents': MODS[o]['amount'], 'sort': n, 'groups': MODS[o]['modifierSets']}
        for n, o in enumerate(s['modifiers'])]})


def item(i, n, **over):
    out = {'id': i['id'], 'name': i['name'], 'description': i['description'], 'price_cents': i['amount'], 'image': image(i),
           'allergens': i['allergens'], 'gluten_free': bool(i['glutenFree']), 'vegetarian': bool(i['vegetarian']),
           'popular': bool(i['popular']), 'sort': n, 'groups': i['modifierSets']}
    out.update(over)
    return out


lunch = json.load(open(f'{HERE}/lunch.json', encoding='utf8'))
cats, sort = [], 0
for c in m['categories']:
    h = hours(c['hours'], store)
    daypart = c['name'] in lunch
    # A category open every day with no times follows the restaurant's own hours.
    custom = c['name'] == 'Daily Specials' or daypart or c['name'] == 'Brunch Specials'
    if daypart:
        rows = []
        for n, x in enumerate(c['items']):
            i = ITEMS[x]
            l = lunch[c['name']]['items'].get(i['name'], {})
            over = {'id': i['id'] + ':lunch', 'description': l.get('description', i['description'])}
            if 'price_cents' in l:
                over['price_cents'] = l['price_cents']
            if 'drop_groups' in l:
                over['groups'] = [g for g in i['modifierSets'] if not re.search(l['drop_groups'], SETS[g]['name'], re.I)]
            rows.append(item(i, n, **over))
        cats.append({'id': c['id'] + ':lunch', 'name': c['name'], 'description': c['description'], 'note': 'Lunch: Mon-Sat 10:30 AM - 4 PM',
                     'hours': lunch[c['name']]['hours'], 'sort': sort, 'items': rows})
        sort += 1
    cats.append({'id': c['id'], 'name': c['name'], 'description': c['description'],
                 'note': ('Dinner: Mon-Sat after 4 PM' if daypart else None), 'hours': h if custom else None, 'sort': sort,
                 'items': [item(ITEMS[x], n) for n, x in enumerate(c['items'])]})
    sort += 1

payload = {'restaurant': {
    'slug': 'lupitas-valley', 'name': "Lupita's Valley", 'phone': '+14356543465', 'email': 'lupitasvalley2021@gmail.com',
    'address': '650 W 100 S #10, Heber City, UT 84032', 'timezone': 'America/Denver', 'hours': store,
    'tax_rate_bps': 865, 'guest_fee_bps': 0, 'pickup_lead_minutes': 20, 'alert_email': None, 'site_url': 'https://lupitasvalley.com'},
    'groups': groups, 'categories': cats}
json.dump(payload, open(f'{HERE}/lupitas-seed.json', 'w', encoding='utf8'), ensure_ascii=False)
print('categories', len(cats), 'items', sum(len(c['items']) for c in cats), 'groups', len(groups), 'options', sum(len(g['options']) for g in groups))
print('store', store)
for c in cats:
    print(' ', c['sort'], c['name'], len(c['items']), c['hours'] and list(c['hours'].items())[:1])
