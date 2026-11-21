#!/usr/bin/env python3
"""Static site generator for lupitasvalley.com replacement. Run: python3 build.py"""
import html, json, os, re, shutil, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, 'site'); A = os.path.join(HERE, 'assets')
DOMAIN = 'https://lupitasvalley.com'
PHONE = '(435) 654-3465'; TEL = 'tel:+14356543465'; EMAIL = 'lupitasvalley2021@gmail.com'
ADDR1 = '650 W 100 S #10'; ADDR2 = 'Heber City, UT 84032'
MAPS = "https://www.google.com/maps/search/?api=1&query=Lupita%27s+Valley+650+W+100+S+Heber+City+UT+84032"
def addr(text):
    return f'<a class="addr" href="{MAPS}" rel="noopener" target="_blank">{text}<span class="sr-only"> (opens Google Maps in a new tab)</span></a>'
DIRS = "https://www.google.com/maps/dir/?api=1&destination=Lupita%27s+Valley+650+W+100+S+Heber+City+UT+84032"
HOURS = [('Monday', '10:30 AM - 9:00 PM'), ('Tuesday', '10:30 AM - 9:00 PM'), ('Wednesday', '10:30 AM - 9:00 PM'), ('Thursday', '10:30 AM - 9:00 PM'), ('Friday', '10:30 AM - 10:00 PM'), ('Saturday', '10:30 AM - 10:00 PM'), ('Sunday', 'Closed')]
NAV = [('Menu', '/menu'), ('Dine-In Menu', '/page/pdf-menus'), ('Drinks', '/page/drinks'), ('Catering', '/catering'), ('Reservations', '/reservations')]
MORE = [('Parties & Events', '/page/parties'), ('Rewards', '/rewards'), ('About Us', '/page/our-story'), ("We're Hiring", '/careers'), ('Gift Cards', '/gift-cards'), ('Questions', '/questions'), ('Leave a Review', '/review'), ('Contact Us', '/page/contact-us')]
e = html.escape
slug_map = json.load(open(os.path.join(A, 'menu_map.json'), encoding='utf8'))
ARROW = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'

SEED = os.path.join(HERE, '..', '..', 'seed', 'lupitas', 'lupitas-seed.json')
def price_text(i, groups):
    low, more = i['price_cents'], False
    for gid in i['groups']:
        g = groups[gid]
        prices = [o['price_cents'] for o in g['options']]
        if g['min'] > 0 and prices:
            low += min(prices)
            more = more or max(prices) > min(prices)
    return f"${low/100:.2f}" + ('+' if more else '')
AVAIL = {'Brunch Specials': 'Mon-Sat 10:30 AM - 4:15 PM', 'Daily Specials': 'Tuesdays and Thursdays', 'Soda Pop': 'Mon-Sat'}
def parse_menu():
    seed = json.load(open(SEED, encoding='utf8'))
    groups = {g['id']: g for g in seed['groups']}
    cats = []
    for c in seed['categories']:
        items = [{'ext': i['id'], 'name': i['name'], 'desc': i['description'] or '', 'price': price_text(i, groups), 'img': (i['image'] or '').split('/')[-1].replace('-heber-city.webp', '').replace('.webp', '') or None} for i in c['items']]
        cats.append({'name': c['name'], 'avail': c.get('note') or AVAIL.get(c['name'], ''), 'note': c.get('description') or '', 'items': items})
    return cats
CATS = parse_menu(); ITEMS = [i for c in CATS for i in c['items']]; BY = {}
for _i in ITEMS: BY.setdefault(_i['name'], _i)

_ids = {}
def cid(n): return re.sub(r'[^a-z0-9]+', '-', n.lower()).strip('-')
def btn(label, href, kind='', attrs=''):
    return f'<a class="btn {kind}" href="{e(href)}"{attrs}>{e(label)} {ARROW}</a>'
def order_btn(kind=''):
    return f'<a class="btn {kind}" href="{TEL}" data-order>Call to order {ARROW}</a>'
def img(src, alt, w=800, h=600, cls='', eager=False):
    return f'<img src="{src}" alt="{e(alt)}" width="{w}" height="{h}"' + (f' class="{cls}"' if cls else '') + (' fetchpriority="high"' if eager else ' loading="lazy" decoding="async"') + '>'

def schema():
    days = {'Friday': 1, 'Saturday': 1}
    return json.dumps({'@context': 'https://schema.org', '@type': 'Restaurant', 'name': "Lupita's Valley", 'url': DOMAIN + '/', 'telephone': '+1-435-654-3465', 'email': EMAIL,
        'image': DOMAIN + '/img/site/exterior.webp', 'logo': DOMAIN + '/img/site/logo.png', 'servesCuisine': ['Mexican', 'Tacos', 'Burritos', 'Bar', 'Brunch'], 'menu': DOMAIN + '/menu', 'hasMenu': DOMAIN + '/menu', 'acceptsReservations': True, 'priceRange': '$$$',
        'geo': {'@type': 'GeoCoordinates', 'latitude': 40.5070732, 'longitude': -111.4244214},
        'areaServed': ['Heber City', 'Midway', 'Daniel', 'Charleston', 'Interlaken', 'Jordanelle', 'Wallsburg', 'Hideout', 'Park City', 'Francis'],
        'address': {'@type': 'PostalAddress', 'streetAddress': ADDR1, 'addressLocality': 'Heber City', 'addressRegion': 'UT', 'postalCode': '84032', 'addressCountry': 'US'},
        'sameAs': ['https://instagram.com/lupitasvalley'],
        'openingHoursSpecification': [{'@type': 'OpeningHoursSpecification', 'dayOfWeek': ['Monday', 'Tuesday', 'Wednesday', 'Thursday'], 'opens': '10:30', 'closes': '21:00'}, {'@type': 'OpeningHoursSpecification', 'dayOfWeek': ['Friday', 'Saturday'], 'opens': '10:30', 'closes': '22:00'}]}, ensure_ascii=False)

def page(path, title, desc, body, active='', extra_head='', robots=''):
    nav = ''.join(f'<a href="{h}"' + (' aria-current="page"' if h == active else '') + f'>{e(n)}</a>' for n, h in NAV)
    more = ''.join(f'<a href="{h}">{e(n)}</a>' for n, h in MORE)
    foot = ''.join(f'<li><a href="{h}">{e(n)}</a></li>' for n, h in NAV + MORE)
    hours = ''.join(f'<li><span>{d}</span><span>{t}</span></li>' for d, t in HOURS)
    canon = DOMAIN + (path if path != '/' else '/')
    doc = f'''<!doctype html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
{robots}<link rel="canonical" href="{canon}">
<meta property="og:type" content="restaurant">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{canon}">
<meta property="og:image" content="{DOMAIN}/img/site/{'hero-poster.webp' if path == '/' else 'logo.png'}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/img/site/favicon.png">
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#931515"><link rel="apple-touch-icon" href="/img/app/app-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
<script type="application/ld+json">{schema()}</script>
{extra_head}<!-- ANALYTICS_HEAD: paste GA4 / Meta Pixel scripts here -->
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="hdr">
<div class="wrap hdr-in">
<a class="logo" href="/"><img src="/img/site/logo.png" alt="Lupita's Valley home" width="270" height="67"></a>
<nav class="nav" aria-label="Main">{nav}
<details class="more"><summary>More</summary><div class="more-pop">{more}</div></details></nav>
<div class="hdr-cta">{order_btn('sm')}</div>
<details class="mob"><summary aria-label="Open menu"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></summary><div class="mob-pop">{nav}{more}</div></details>
</div>
</header>
<main id="main">
{body}
</main>
<footer class="ftr">
<div class="wrap ftr-grid">
<div><img src="/img/site/logo.png" alt="Lupita's Valley" width="193" height="48" loading="lazy">
<p>{addr(ADDR1 + '<br>' + ADDR2)}</p><p><a href="{TEL}">{PHONE}</a><br><a href="mailto:{EMAIL}">{EMAIL}</a></p>
<p><a href="https://instagram.com/lupitasvalley" rel="noopener">Instagram</a></p></div>
<div><h2>Explore</h2><ul class="ftr-links">{foot}</ul></div>
<div><h2>Hours</h2><ul class="hours">{hours}</ul></div>
</div>
<div class="wrap legal"><span>© {datetime.date.today().year} Siete Cruces LLC. All rights reserved.</span><span><a href="/privacy">Privacy</a> · <a href="/terms">Terms of service</a> · <a href="/accessibility">Accessibility</a></span></div>
</footer>
<nav class="bar" aria-label="Quick actions"><a href="{TEL}" data-order-bar>Call</a><a href="/reservations">Reserve</a></nav>
<script src="/assets/config.js"></script>
<script src="/assets/site.js" defer></script>
<!-- ANALYTICS_BODY: paste body tracking scripts here -->
</body>
</html>
'''
    d = OUT + path; os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'index.html'), 'w', encoding='utf8').write(doc)

def card(i):
    im = i['img']
    pic = img(f"/img/menu/{im}.webp", i['name'], 400, 300) if im and os.path.exists(f'{OUT}/img/menu/{im}.webp') else ''
    return f'''<article class="item{'' if pic else ' noimg'}" data-item="{e(i['ext'])}"><div class="item-t"><h3>{e(i['name'])}</h3><p>{e(i['desc'])}</p><span class="price">{e(i['price'])}</span></div>{pic}</article>'''
def feat(n):
    i = BY[n]
    return f'<a class="feat" href="/menu#{cid(next(c["name"] for c in CATS if i in c["items"]))}">{img(f"/img/menu/{i["img"]}.webp", "", 400, 300)}<span>{e(n)}</span></a>'
def location_block():
    hours = ''.join(f'<li><span>{d}</span><span>{t}</span></li>' for d, t in HOURS)
    return f'''<section class="sec"><div class="wrap loc"><div><h2>Our location</h2><h3>Lupita's Valley</h3><p>{addr(ADDR1 + '<br>' + ADDR2)}</p>
<p><a href="{TEL}">Call {PHONE}</a><br><a href="mailto:{EMAIL}">Email {EMAIL}</a></p>
<p class="today" data-today></p><ul class="hours">{hours}</ul><div class="row">{btn('Get directions', DIRS, 'ghost', ' rel="noopener"')}{order_btn()}</div></div>
<iframe title="Map showing Lupita's Valley in Heber City" src="https://www.google.com/maps?q=650+W+100+S+%2310,+Heber+City,+UT+84032&output=embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div></section>'''
def ld(o):
    return '<script type="application/ld+json">' + json.dumps(o, ensure_ascii=False).replace('</', '<\\/') + '</script>\n'
def home_ld():
    plain = lambda t: re.sub(r'<[^>]+>', '', t)
    return ld({'@context': 'https://schema.org', '@type': 'FAQPage', 'url': DOMAIN + '/', 'inLanguage': 'en', 'mainEntity': [{'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': plain(a)}} for q, a in HOME_FAQ]}) \
        + ld({'@context': 'https://schema.org', '@type': 'WebSite', 'name': "Lupita's Valley", 'url': DOMAIN + '/'})
def tag_ld(name, items):
    rows = []
    for n in items:
        i = BY[n]; m = re.search(r'\d+\.\d\d', i['price'] or '')
        rows.append({'@type': 'MenuItem', 'name': i['name'], 'description': i['desc'], **({'offers': {'@type': 'Offer', 'price': m.group(0), 'priceCurrency': 'USD'}} if m else {})})
    return ld({'@context': 'https://schema.org', '@type': 'ItemList', 'name': f"{name} at Lupita's Valley", 'description': f"{name} dishes available at Lupita's Valley", 'numberOfItems': len(rows), 'itemListElement': rows})
def faq(pairs):
    return '<div class="faq">' + ''.join(f'<details><summary>{e(q)}</summary><p>{a.replace(ADDR1, addr(ADDR1))}</p></details>' for q, a in pairs) + '</div>'
def phead(h, sub='', h1=None, vis='h2', h2=None):
    # Live pages with a keyword H1 hide it visually, so the banner keeps its short heading.
    top = f'<h1 class="sr-only">{e(h1)}</h1><{vis} class="ph">{e(h)}</{vis}>' if h1 else f'<h1>{e(h)}</h1>'
    return f'<section class="phead"><div class="wrap">{top}' + (f'<h2 class="ph-sub">{e(h2)}</h2>' if h2 else '') + (f'<p>{sub}</p>' if sub else '') + '</div></section>'
def stacked(title, text, image, alt, cta=''):
    return f'''<section class="sec"><div class="wrap stacked">{img('/img/site/' + image + '.webp', alt, 800, 600)}<div class="split-t"><h2>{e(title)}</h2><p>{text}</p>{cta}</div></div></section>'''
def split(title, text, image, alt, cta='', flip=False, tag='h2'):
    return f'''<section class="sec"><div class="wrap split{' flip' if flip else ''}"><div class="split-t"><{tag}>{e(title)}</{tag}><p>{text}</p>{cta}</div>{img('/img/site/' + image + '.webp', alt, 800, 600)}</div></section>'''
def gallery(title, items, scroll=False):
    pics = ''.join(img(f'/img/site/{s}.webp', a, 600, 450) for s, a in items)
    if scroll:
        return f'<section class="sec alt"><div class="wrap"><h2>{e(title)}</h2><div class="scroller gal-scroll" data-scroller="40" role="group" aria-label="{e(title)}" tabindex="0"><div class="scroller-track">{pics}</div></div></div></section>'
    return f'<section class="sec alt"><div class="wrap"><h2>{e(title)}</h2><div class="gal">{pics}</div></div></section>'

# ---- forms
def field(name, label, typ='text', req=True, opts=None, ph=''):
    r = ' required' if req else ''; star = ' <span aria-hidden="true">*</span>' if req else ''
    fid = 'f-' + name
    if opts is not None:
        c = f'<select id="{fid}" name="{name}"{r}><option value="">Select</option>' + ''.join(f'<option>{e(o)}</option>' for o in opts) + '</select>'
    elif typ == 'textarea':
        c = f'<textarea id="{fid}" name="{name}" rows="4"{r}></textarea>'
    else:
        ac = {'name': 'name', 'email': 'email', 'phone': 'tel'}.get(name, 'off')
        c = f'<input id="{fid}" name="{name}" type="{typ}" autocomplete="{ac}"{r}>'
    return f'<div class="fld"><label for="{fid}">{e(label)}{star}</label>{c}</div>'
SMS = '''<label class="chk"><input type="checkbox" name="sms_consent" value="yes"><span>I agree to receive marketing text messages from Lupita's Valley Mexican Restaurant about specials, events, and other exclusive offers. My consent to receive these messages is not required to make a reservation or use the services provided. <a href="/privacy">Privacy Policy</a> <a href="/terms">Terms and Conditions</a> Message and data rates may apply. Message frequency varies. Reply STOP to cancel, HELP for help.</span></label>'''
def form(fid, fields, submit, sms=False):
    return f'''<form class="form" data-form="{fid}" novalidate>{''.join(fields)}{SMS if sms else ''}
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<button class="btn" type="submit">{e(submit)} {ARROW}</button><p class="form-msg" role="status" aria-live="polite"></p></form>'''

# ---- reviews (as displayed on the current site)
REVIEWS = [("Paige H.", "We had a great dinner here last weekend. The service was excellent and the food was great. I would definitely recommend the tacos! All the meat was so good and the salsa appetizer was fun to try all their different kinds."),
 ("Clint S.", "Really enjoyed finding this gem! First time walking in, we were sat right down and service right away. We will be going here often. The food was as authentic as being in Mexico. Guacamole was fresh, amazing taste. My meal was everything I wanted it to be!! We've already made recommendations to our friends."),
 ("Tricia S.", "We were intrigued by the interesting building/location. Glad we stopped, so delicious and great customer service. We got to enjoy the Thursday special…FRESH TAMALES! The building is old, but very clean. Highly recommend."),
 ("Jennifer M.", "Yummy food, cute location, nice atmosphere, affordable!"),
 ("Pam M.", "Food and local atmosphere make this place a true winner! Keep up the quality and we will be back!"),
 ("Kurt C.", "I’m a Baltimore native and a graduate of the Culinary Institute of America, my wife is from Southern California, together we have a great love and respect for great Mexican food. We moved to Utah 5 years ago and until dining at Lupita’s we had not found any great Mexican food in the state. The food at Lupita’s reminded me of when my cooks used to prepare staff meals at any of the restaurants I opened and ran, true honest flavors that explode on your palate. Homemade corn tortillas? Yes please!"),
 ("James E.", "Absolutely amazing Food!. Perfectly cooked means to be stuffed into a Burrito and Enchiladas. Perfectly flavored rice. Chile Verde was perfect! This is our new favorite! Worth the drive for this great spot. Not overpriced like others say... want cheap good, go elsewhere. Want GOOD Mexican? This ID the Spot!")]
HOME_FAQ = [("What are you known for?", "We are known for Camarones A La Diabla, Burritos, Brunch, Quesadillas, Huevos Rancheros, Carnitas, Rice Bowl, Pozole, Nachos, Quesabirria, Bar Food, Grilled Chicken, Tacos, Ceviche, Chilaquiles, Enchiladas, Mole, Omelette, Soup, Tostadas, Tostadas De Tinga, Guacamole, and Fajitas."),
 ("What meals do you serve?", "We serve Breakfast, Brunch, Lunch, and Dinner."),
 ("Do you offer takeout?", f'Yes. <a href="/menu">Order online for pickup</a> or call us at <a href="{TEL}">{PHONE}</a>.'),
 ("Are reservations needed?", 'We highly recommend making a reservation for groups over 6 people. <a href="/reservations">Book a table online</a>.'),
 ("Where are you located?", f"We are located in Old Town Square in Heber City, UT at {ADDR1}."),
 ("What areas do you serve?", "We serve the following areas: Heber City, Heber, Midway, Daniel, Charleston, Interlaken, Mound City, Center Creek, Jordanelle, Hailstone, Cranmer, Wallsburg, Keetley, Timber Lakes, Independence, Hideout, Park City, and Francis.")]
FEATURED = ['Camarones a la Diabla', 'Mole Micha-Poblano', 'Chiles Rellenos', 'Enchiladas Catalinas', 'Enchiladas Suizas', 'Sopes']
STRIP = ['Mole Micha-Poblano', 'Fresh-Squeezed Margaritas', 'Handmade Tortillas Daily', 'Sopes, Enchiladas, Tostadas', 'Mother-Daughter Kitchen Since 2021']

def home():
    reviews = ''.join(f'<figure class="rev"><div class="stars" aria-label="5 out of 5 stars">★★★★★</div><blockquote>{e(t)}</blockquote><figcaption>{e(n)}</figcaption></figure>' for n, t in REVIEWS)
    body = f'''<section class="hero"><video autoplay muted loop playsinline preload="metadata" poster="/img/site/hero-poster.webp" aria-hidden="true"><source src="/video/hero.mp4" type="video/mp4"></video>
<div class="hero-scrim"></div><div class="wrap hero-t"><h1>Best Mexican Food in Heber City</h1><p class="hero-h">From Michoacan to Your Table, Made with Love</p><div class="row">{order_btn()}{btn('Reserve a table', '/reservations', 'light')}</div></div></section>
<section class="sec specials-sec" data-specials hidden><div class="wrap"><h2>Specials</h2><div class="specials-list"></div></div></section>
<section class="sec"><div class="wrap"><div class="head-row"><h2>Featured</h2>{btn('View menu', '/menu', 'ghost')}</div><div class="feats">{''.join(feat(n) for n in FEATURED)}</div></div></section>
<div class="strip"><ul class="wrap">{''.join(f'<li>{e(s)}</li>' for s in STRIP)}</ul></div>
{stacked('The Mole Micha-Poblano', "Our family has roots in both Michoacán and Puebla, and our signature Mole Micha-Poblano is a love letter to both. 'Micha' — short for Michoacán and a nod to the Spanish word for half and half — captures exactly what this sauce is: a perfect balance of bold spice and gentle sweetness, one hundred percent ours. Served with Mexican rice, sautéed vegetables, and hand-pressed corn tortillas, or glazed over our enchiladas and burritos.", 'mole', 'The Mole Micha-Poblano', btn('Explore the Full Menu', '/page/pdf-menus', 'ghost'))}
{gallery('From Our Kitchen', [('gal-salsas', 'A basket of tortilla chips with five small bowls of various salsas and dips on a wooden table.'), ('gal-enchiladas', 'A plate of enchiladas covered in mole sauce and melted cheese, with rice, refried beans, and salad.'), ('gal-ceviche', 'Shrimp ceviche with diced mango, red onion, and a swirl of avocado, served with tortilla chips.'), ('gal-mole', 'Enchiladas with rich mole sauce and melted cheese, served with rice and refried beans.'), ('margaritas', 'Three colorful margaritas with lime garnishes on a rustic wooden table in a vibrant Mexican restaurant.'), ('gal-ceviche2', 'Ceviche with avocado, lime, and tortilla chips on a rustic wooden table.')], scroll=True)}
{stacked('Birthdays, Quinceañeras, and Everything Between', 'We love a reason to celebrate. Our dining room is made for big tables, big meals, and the kind of night people talk about for years.', 'interior-1', 'Birthdays, Quinceañeras, and Everything Between: a warmly lit dining room with wooden tables and Southwestern decor', btn('Plan Your Event', '/page/parties'))}
<section class="sec alt"><div class="wrap"><h2>What guests are saying</h2><div class="scroller revs-scroll" data-scroller="28" role="group" aria-label="Guest reviews" tabindex="0"><div class="scroller-track">{reviews}</div></div><p class="center">{btn('Leave us a review', '/review', 'ghost')}</p></div></section>
<section class="sec"><div class="wrap cards3">
<article class="cta-card">{img('/img/site/rewards.webp', "Lupita's Valley Rewards", 600, 400)}<h2>Lupita's Valley Rewards</h2><p>Join our rewards program, earn points, and redeem your points for free food!</p>{btn("Join Lupita's Valley Rewards", '/rewards')}</article>
<article class="cta-card">{img('/img/site/reservations.webp', 'Are reservations needed? A table set at Lupita\'s Valley', 600, 400)}<h2>Reservations</h2><p>We are happy to accept reservations through our website. We highly recommend a reservation for groups over 6 people.</p>{btn('Reservations', '/reservations')}</article>
<article class="cta-card">{img('/img/site/gal-salsas.webp', 'Chips and house-made salsas', 600, 400)}<h2>Catering</h2><p>Let us cater your next event. Click below to get started.</p>{btn('Request catering', '/catering')}</article>
</div></section>
{split('A Family Kitchen in Old Town Square', "A mother who cooks from memory and a daughter who writes it all down — together they've built something truly special in the heart of Old Town Heber.", 'exterior', "A Family Kitchen in Old Town Square: Lupita's Mexican Restaurant exterior at dusk, adorned with string lights and a wooden boardwalk", btn('See Our Menu', '/menu', 'ghost'), flip=True)}
<section class="sec alt"><div class="wrap narrow"><h2>Frequently Asked Questions</h2>{faq(HOME_FAQ)}<p class="center">{btn('Ask us a question', '/questions', 'ghost')}</p></div></section>
{location_block()}'''
    page('/', "Best Mexican Food in Heber City, UT | Lupita's Valley | Mexican Food near me", "Lupita's Valley: the best Mexican Food in Heber City, UT. Order directly online today for takeout or delivery. Save money, support local business!", body, extra_head='<link rel="preload" as="image" href="/img/site/hero-poster.webp">\n' + home_ld())

def menu():
    jump = ''.join(f'<a href="#{cid(c["name"])}">{e(c["name"])}</a>' for c in CATS)
    pop = ''.join(card(BY[n]) for n in FEATURED)
    secs = ''
    for c in CATS:
        sub = ''.join(f'<p class="cat-note">{e(x)}</p>' for x in (c['avail'], c['note']) if x)
        anchor = cid(c["name"]) + ('-dinner' if 'Dinner' in (c['avail'] or '') else '')
        secs += f'<section class="cat" id="{anchor}"><h2>{e(c["name"])}</h2>{sub}<div class="items">{"".join(card(i) for i in c["items"])}</div></section>'
    menu_ld = json.dumps({'@context': 'https://schema.org', '@type': 'Menu', 'name': "Lupita's Valley Menu", 'url': DOMAIN + '/menu', 'hasMenuSection': [{'@type': 'MenuSection', 'name': c['name'], 'hasMenuItem': [{'@type': 'MenuItem', 'name': i['name'], 'description': i['desc'], 'offers': {'@type': 'Offer', 'price': i['price'].strip('$+'), 'priceCurrency': 'USD'}} for i in c['items']]} for c in CATS]}, ensure_ascii=False)
    body = f'''<section class="phead"><div class="wrap"><h1>Lupita's Valley Menu</h1><p>{addr(ADDR1 + ', Heber City, UT')} · <span data-today></span></p><div class="row" style="justify-content:center">{order_btn()}{btn('Dine-In Menu', '/page/pdf-menus', 'ghost')}</div></div></section>
<div class="wrap menu"><div id="ro-menu"><section class="cat"><h2>Popular</h2><div class="items">{pop}</div></section>{secs}</div></div>
<script src="/assets/ordering/ordering.js" defer></script>'''
    page('/menu', "Lupita's Valley Online Menu | Best Mexican Food in Heber City", "Lupita's Valley Online Menu. Save Money Ordering Directly Here. Healthy Options. Fast Service. Friendly Team. Top Rated.", body, '/menu', f'<link rel="stylesheet" href="/assets/ordering/ordering.css">\n<script type="application/ld+json">{menu_ld}</script>\n')

def pdfs():
    L = [('Dinner', 'dinner'), ('Brunch', 'brunch'), ('Kids Menu', 'kids'), ('Appetizers', 'appetizers'), ('Desserts', 'desserts'), ('Soft Drinks', 'soft-drinks'), ('Spirits and Cocktails', 'spirits-cocktails')]
    ROW = ('appetizers', 'desserts', 'soft-drinks')  # small card menus sit side by side
    jump = ''.join(f'<a href="#{s}">{n}</a>' for n, s in L)
    import glob
    secs = ''
    for n, s in L:
        pages = sorted(glob.glob(f'{OUT}/menus/img/{s}-*.webp'))
        from PIL import Image
        imgs = ''
        for k, p in enumerate(pages, 1):
            w, h = Image.open(p).size  # rendered at 2x by pdfpages.py, so show at half size
            src = f'/menus/img/{os.path.basename(p)}'
            imgs += f'<a class="pdf-zoom" href="{src}"><img class="pdf-page" src="{src}" alt="{e(n)} menu, page {k} of {len(pages)}. Opens full size for zooming." width="{w // 2}" height="{h // 2}" loading="lazy" decoding="async"></a>'
        sec = f'''<section class="pdf" id="{s}"><div class="head-row"><h2>{n}</h2>{btn('Download', f'/menus/{s}.pdf', 'ghost')}</div>{imgs}</section>'''
        if s == ROW[0]: secs += '<div class="pdf-row">' + sec
        elif s == ROW[-1]: secs += sec + '</div>'
        else: secs += sec
    return phead("Menus", h1="Menus | Lupita's Valley", vis='p') + f'<nav class="jump" aria-label="Menus"><div class="wrap">{jump}</div></nav><div class="wrap"><p class="pdf-tip">Tap or click any menu page to open it full size.</p>{secs}</div>'

def build():
    for sub in ('assets',): os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    home(); menu()
    page('/page/pdf-menus', "Menus | Lupita's Valley", "Find out more about Menus at Lupita's Valley", pdfs(), '/page/pdf-menus')
    # drinks
    body = phead('Drinks', h1="Drinks | Lupita's Valley", vis='p') + split('Margaritas Made From Scratch', 'Every margarita is built with fresh-squeezed lime and organic agave nectar. Choose your rim — salt, raw sugar, or tajín.', 'margaritas', 'Margaritas Made From Scratch: three colorful margaritas with lime garnishes', btn('See the Full Drink Menu', '/page/pdf-menus#spirits-cocktails')) \
        + split('Specialty Cocktails', 'From the Tamarindo Loco to our Mexican Mojito, we craft each cocktail with fresh citrus, quality spirits, and a little Michoacán spirit.', 'cocktails', 'Specialty Cocktails at Lupita\'s Valley', flip=True) \
        + split('Soft Drinks', 'Wind down with homemade aguas frescas, mocktails, or cane sugar sodas. We also carry hot Tazo Teas, Chocolate de Abuelita and a specialty Coconut Horchata Latte.', 'softdrinks', 'Soft Drinks at Lupita\'s Valley') \
        + gallery('Something for Everyone', [('d-orange', 'A vibrant orange cocktail with a chili-salt rim, lime slice, and cinnamon sticks on a wooden table.'), ('d-mango', 'Mango smoothie in a mason jar with a chili-lime rim and mango chunks on a wooden table.'), ('d-berry', 'A red berry drink in a mason jar with a lime wedge and straw on a wooden table.'), ('d-berry2', 'Close-up of a vibrant red berry cocktail in a mason jar, garnished with a lime wedge.'), ('d-horchata', 'Horchata in a mason jar with ice and a sprinkle of cinnamon on a wooden table.'), ('d-jarritos', 'Two Jarritos soda bottles, Tamarind and Lime flavors, on a rustic wooden table.')])
    page('/page/drinks', "Drinks | Lupita's Valley", "Find out more about Drinks at Lupita's Valley", body, '/page/drinks')
    # catering
    f = form('catering', [field('name', 'Name'), field('email', 'Email', 'email'), field('phone', 'Phone Number', 'tel'), field('event_date', 'Event Date', 'datetime-local'), field('guests', 'Number of Guests', opts=['1-10', '10-20', '20-30', '30-40', '40-50', '50+']), field('details', 'Questions or Details', 'textarea', False)], 'Submit Catering Request')
    body = phead("Lupita's Valley Catering in Heber City, UT", h2="Planning an Event? Let's Make It Easy.", sub="Fill out the form below and our team will get back to you shortly.") + f'<section class="sec"><div class="wrap narrow">{f}</div></section><section class="sec alt"><div class="wrap narrow"><h2>Frequently Asked Questions</h2>' + faq([('How much advance notice is required?', 'We require 24 hours of notice for catering orders.'), ('Can you accommodate dietary restrictions (gluten-free, vegan, allergies)?', 'We will do our best to accommodate dietary restrictions whenever possible. Please call us directly before ordering to discuss your specific needs.'), ('Do you provide plates, napkins, and cutlery?', 'Plates, napkins, and cutlery are not provided with your catering order. Please call us directly for any specific requests.')]) + '</div></section>' + location_block()
    page('/catering', "Lupita's Valley Catering in Heber City, UT", "Order catering from Lupita's Valley. Freshly prepared, professionally delivered catering for corporate events, private parties, weddings, and more.", body, '/catering')
    # reservations
    body = phead('Book a Table', 'Pick your party size, day and time. Most tables are confirmed instantly. For groups over 8, we confirm by phone or email.', h1="Lupita's Valley | Lupita's Valley Reservations") + f'<div class="ro-page"><div id="ro-reserve" aria-live="polite"><noscript><p>Please call <a href="{TEL}">{PHONE}</a> to book a table.</p></noscript></div></div><script src="/assets/ordering/reserve.js" defer></script>'
    page('/unsubscribe', "Email preferences | Lupita's Valley", "Manage marketing emails from Lupita's Valley.", '<section class="phead"><div class="wrap"><h1>Email preferences</h1></div></section><section class="sec"><div class="wrap narrow" id="ro-unsub" aria-live="polite"><noscript><p>Please call us to unsubscribe.</p></noscript></div></section><script src="/assets/ordering/unsubscribe.js" defer></script>', robots='<meta name="robots" content="noindex">\n')
    page('/reservations', "Lupita's Valley | Lupita's Valley Reservations", "Book a table at Lupita's Valley in Heber City. Pick a day and time and get confirmed instantly.", body, '/reservations', '<link rel="stylesheet" href="/assets/ordering/ordering.css">\n')
    # parties
    f = form('party', [field('name', 'Name'), field('phone', 'Phone', 'tel'), field('email', 'Email', 'email'), field('company', 'Company', req=False), field('people', 'Number of People', 'number'), field('event_at', 'Date and time of the event', 'datetime-local'), field('occasion', 'Select Occasion', opts=['Birthday', 'Quinceañera', 'Graduation', 'Baby Shower', 'Family Reunion', 'Office Function', 'Rehearsal Party', 'Other']), field('budget', 'Budget per Person', req=False), field('details', 'Description / Requests', 'textarea', False), field('heard', 'How did you hear about us?', req=False)], 'Submit', sms=True)
    body = phead('Celebrate With Us', 'Birthdays, quinceañeras, graduations, baby showers — we make room for the moments that matter.', h1="Parties & Events | Lupita's Valley") + split('Groups of 6 to 50', 'We host groups for any occasion — family reunions, office dinners, rehearsal parties — with homestyle Michoacán cooking everyone will remember.', 'parties-groups', 'Groups of 6 to 50: a group table at Lupita\'s Valley') \
        + gallery('A Space Worth Gathering In', [('interior-1', 'Warmly lit restaurant interior with wooden tables, chairs, and Southwestern decor, including a large potted plant.'), ('interior-2', 'Warm, rustic restaurant interior with wooden tables, red wainscoting, and barn doors leading to another dining area.'), ('interior-3', 'Restaurant interior with booth seating, hanging lights, and colorful artwork on cream-colored walls.'), ('exterior', "Lupita's Mexican Restaurant exterior at dusk, adorned with string lights and a wooden boardwalk."), ('interior-4', 'Cozy restaurant interior with wooden tables and chairs, yellow walls, and red wainscoting.'), ('register', 'Vintage wooden cash register and stacks of plates on a rustic wooden counter with red wainscoting.')]) \
        + f'''<section class="sec"><div class="wrap narrow"><div class="intro center-t"><h2>Reserve Your Party Date</h2><p class="lead-p">Tell us your date, party size, and occasion. We'll take care of the rest.</p></div><div class="form-card"><h2>Group Reservations and Private Parties</h2><p>Whether it's a bday party, baby shower, office function or any other special event, please fill out the form below and we'll do our best to accommodate your desired date and any requests you may have to make your party/celebration memorable.</p>{f}</div></div></section>'''
    page('/page/parties', "Parties & Events | Lupita's Valley", "Find out more about Parties & Events at Lupita's Valley", body, '/page/parties')
    # story
    body = phead('A Mother-Daughter Kitchen', h1="About Us | Lupita's Valley") + split('A Mother-Daughter Kitchen', "We're Lupita and Carla Cruz-Calderón. In 2021, we closed our previous restaurant, Tarahumara, and reopened as Lupita's Valley — a chance to dig deeper into the flavors and traditions that define our family's roots.", 'exterior', "A Mother-Daughter Kitchen: Lupita's Valley at dusk", btn('Read Our Story in the Park Record', 'https://www.parkrecord.com/2025/12/26/lupitas-valley-reinvents-itself-once-again/', 'ghost', ' rel="noopener"')).replace('<h2>A Mother-Daughter Kitchen</h2>', '<h2>Our Story</h2>') \
        + split('Recipes Rebuilt From Memory', 'Our menu is rooted in Michoacán. The Enchiladas Catalinas are named after a woman from Lupita\'s hometown. The mole micha-poblano bridges two regional traditions in one deeply layered sauce.', 'gal-mole', 'Recipes Rebuilt From Memory: enchiladas with mole sauce', btn('Explore Our Menus', '/page/pdf-menus', 'ghost'), flip=True) \
        + split('Old Town Square, Heart and Soul', "The walls of our dining room feature original paintings by Neyda de la Peña — each one available for purchase. It's a gathering place as much as a restaurant.", 'interior-3', 'Old Town Square, Heart and Soul: dining room with booths and colorful artwork') \
        + gallery("Inside Lupita's Valley", [('interior-2', 'Warm, rustic restaurant interior with wooden tables, red wainscoting, and barn doors leading to another dining area.'), ('interior-1', 'Cozy restaurant interior with wooden tables and chairs, yellow walls, and Southwestern decor.'), ('rellenos', 'Chiles Rellenos in a blue dish with a side of tortillas and a terracotta tortilla warmer.'), ('gal-enchiladas', 'A plate of enchiladas covered in mole sauce and melted cheese, with rice, refried beans, and salad.'), ('exterior-2', "Lupita's Mexican Restaurant, a rustic building with string lights and outdoor picnic tables at dusk."), ('decor', 'A large, textured, bronze-colored hanging pot with green tassels, next to a frog figurine.')])
    page('/page/our-story', "About Us | Lupita's Valley", "Find out more about About Us at Lupita's Valley", body)
    # contact
    f = form('contact', [field('name', 'Name'), field('email', 'Email', 'email'), field('phone', 'Phone', 'tel'), field('message', 'Message', 'textarea')], 'Send')
    body = phead('Get In Touch With Us', "Get in touch with Lupita's Valley Mexican Restaurant for authentic Mexican flavors, fresh ingredients, and a welcoming dining experience in Heber City.", h1="Contact Us | Lupita's Valley") + f'''<section class="sec"><div class="wrap split"><div class="split-t"><h2>Contact Us</h2><p><strong>Address:</strong> {addr(ADDR1 + ', ' + ADDR2)}<br><strong>Phone:</strong> <a href="{TEL}">{PHONE}</a></p><p><strong>Hours:</strong><br>Monday–Thursday: 10:30 AM–9 PM<br>Friday–Saturday: 10:30 AM–10 PM<br>Sunday: Closed</p>{btn('Get Directions', DIRS, 'ghost', ' rel="noopener"')}</div><div><p>Please complete the form below and we'll get back to you as soon as we can.</p>{f}</div></div></section>'''
    page('/page/contact-us', "Contact Us | Lupita's Valley", "Find out more about Contact Us at Lupita's Valley", body)
    # careers
    f = form('careers', [field('name', 'Full name'), field('email', 'Email', 'email'), field('phone', 'Phone number', 'tel'), field('comment', 'A few sentences about yourself', 'textarea')], 'Submit')
    body = phead('Join a growing team with a love for food', 'Fill out this quick form with a few sentences about yourself.') + f'<section class="sec"><div class="wrap narrow"><h2>Apply today</h2><p><strong>Location:</strong> {addr('Heber City, ' + ADDR1)}</p>{f}<p class="small">Have a resume? Email it to <a href="mailto:{EMAIL}">{EMAIL}</a>.</p></div></section>'
    page('/careers', "We're Hiring at Lupita's Valley", 'Join our team and grow with us', body)
    # gift cards
    body = phead('Give the perfect gift for any occasion', "Give the gift of a delicious meal with our restaurant gift cards!") + f'<div class="ro-page"><div id="ro-gift"><p>Loading…</p></div></div><script src="/assets/ordering/guest-tools.js" defer></script>'
    page('/gift-cards', "Lupita's Valley Gift Cards", "Buy Lupita's Valley gift cards online. The perfect gift for any occasion. Send a gift card instantly to family or friends.", body, extra_head='<link rel="stylesheet" href="/assets/ordering/ordering.css">\n')
    # NEW: rewards
    months = ''.join(f'<option value="{i + 1}">{m}</option>' for i, m in enumerate(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']))
    bday = f'<fieldset class="fld bday-set"><legend>Birthday (optional, for a birthday treat)</legend><div class="bday"><div class="fld"><label for="f-birth_month">Month</label><select id="f-birth_month" name="birth_month"><option value="">Select</option>{months}</select></div><div class="fld"><label for="f-birth_day">Day</label><input id="f-birth_day" name="birth_day" type="number" min="1" max="31" inputmode="numeric" autocomplete="off"></div></div></fieldset>'
    f = form('rewards', [field('name', 'Name'), field('phone', 'Mobile phone', 'tel'), field('email', 'Email', 'email', False), bday], "Join Lupita's Valley Rewards", sms=True)
    body = phead("Lupita's Valley Rewards", 'Join our rewards program, earn points, and redeem your points for free food!') + f'<section class="sec"><div class="wrap split"><div>{f}</div>{img("/img/site/rewards.webp", "Lupita\'s Valley Rewards", 800, 600)}</div></section><section class="sec"><div class="ro-page"><div id="ro-rewards"></div></div></section><script src="/assets/ordering/guest-tools.js" defer></script>'
    page('/rewards', "Rewards | Lupita's Valley", "Join Lupita's Valley Rewards in Heber City and redeem your points for free food.", body, extra_head='<link rel="stylesheet" href="/assets/ordering/ordering.css">\n')
    # NEW: questions
    f = form('question', [field('name', 'Name'), field('phone', 'Phone', 'tel', False), field('email', 'Email', 'email'), field('message', 'Your question', 'textarea')], 'Send my question')
    body = phead('Have a question?', "Check the answers below, or send us your question and we'll get back to you as soon as we can.") + f'<section class="sec"><div class="wrap split top"><div><h2>Common questions</h2>{faq(HOME_FAQ)}</div><div><h2>Ask us</h2>{f}</div></div></section>'
    page('/questions', "Questions | Lupita's Valley", "Answers to common questions about Lupita's Valley, or send the restaurant your question.", body)
    # NEW: review
    body = f'''<section class="review"><div class="wrap narrow center-t"><img src="/img/site/logo.png" alt="Lupita's Valley" width="257" height="64"><h1>How was your visit?</h1><p>Thank you for dining with us. A quick Google review helps a family restaurant more than you know.</p>{btn('Leave a Google review', MAPS, '', ' data-review rel="noopener"')}<p class="small"><a href="/questions">Need to reach us directly? Send us a message.</a></p></div></section>'''
    page('/review', "Leave a Review | Lupita's Valley", "Leave a review for Lupita's Valley in Heber City, UT.", body, robots='<meta name="robots" content="noindex">\n')
    # order tracking + kitchen
    page('/order', "Your Order | Lupita's Valley", "Track your Lupita's Valley order.", '<div class="ro-page"><div id="ro-status" aria-live="polite"><p>Loading your order…</p></div></div><script src="/assets/ordering/order-status.js" defer></script>', extra_head='<link rel="stylesheet" href="/assets/ordering/ordering.css">\n', robots='<meta name="robots" content="noindex">\n')
    os.makedirs(OUT + '/kitchen', exist_ok=True)
    open(OUT + '/kitchen/index.html', 'w', encoding='utf8').write('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Kitchen | Lupita\'s Valley</title><link rel="stylesheet" href="/assets/ordering/kitchen.css"></head><body><main id="ro-kitchen"></main><script src="/assets/config.js"></script><script src="/assets/ordering/kitchen.js" defer></script></body></html>')
    os.makedirs(OUT + '/admin', exist_ok=True)
    open(OUT + '/admin/index.html', 'w', encoding='utf8').write('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Admin | Lupita\'s Valley</title><link rel="stylesheet" href="/assets/ordering/admin.css"></head><body><main id="ro-admin"></main><script src="/assets/config.js"></script><script src="/assets/ordering/admin.js" defer></script></body></html>')
    # legal
    legal = lambda t, b: phead(t) + f'<section class="sec"><div class="wrap narrow prose">{b}</div></section>'
    page('/privacy', "Privacy Policy | Lupita's Valley", "Lupita's Valley privacy policy.", legal('Privacy Policy', f'''<p>Siete Cruces LLC, doing business as Lupita's Valley, operates this website.</p><h2>What we collect</h2><p>We collect the information you enter into our forms, such as your name, email, phone number, and details about your reservation, event, question, or application. We also collect basic site usage data.</p><h2>How we use it</h2><p>We use it to respond to you, manage reservations, events, and rewards, and improve our services. If you opt in, we send marketing text messages. Mobile opt-in data and consent are not shared with third parties for their marketing.</p><h2>Text messages</h2><p>Reply STOP to cancel or HELP for help. Message and data rates may apply. Message frequency varies.</p><h2>Contact</h2><p>Questions? Email <a href="mailto:{EMAIL}">{EMAIL}</a> or call <a href="{TEL}">{PHONE}</a>.</p>'''))
    page('/terms', "Terms and Policies - Lupita's Valley", "Lupita's Valley website terms.", legal('Terms and Policies', f'''<h2>Lupita's Valley Terms</h2><p>This website is operated by Siete Cruces LLC, doing business as Lupita's Valley. By using it, you agree to these terms.</p><p>Menu items, prices, and hours can change without notice. Reservation and event requests are not confirmed until we contact you. Text message terms: reply STOP to cancel or HELP for help; message and data rates may apply.</p><p>Questions? Email <a href="mailto:{EMAIL}">{EMAIL}</a>.</p>'''))
    page('/accessibility', "Accessibility - Lupita's Valley", "Lupita's Valley accessibility statement.", legal('Accessibility', f'''<p>We want everyone to be able to use this website. We work to meet the Web Content Accessibility Guidelines (WCAG) 2.2, Level AA.</p><h2>How we support access</h2><ul><li>Every page works with a keyboard and has a skip link.</li><li>Photos have text descriptions.</li><li>Forms have clear labels and error messages.</li><li>Moving photos and video have a Pause button, and they stay still if your device is set to reduce motion.</li></ul><h2>Third-party content</h2><p>Our map comes from Google, and our printable menus are PDF files. The <a href="/menu">online menu</a> has the same dishes as text. If a PDF or the map does not work for you, contact us and we will help.</p><h2>Need help or have feedback?</h2><p>Call <a href="{TEL}">{PHONE}</a> or email <a href="mailto:{EMAIL}">{EMAIL}</a> and we will help.</p>'''))
    tags()
    extras()

# tag SEO pages: same URL/title/meta/H1 as the current site, body built from real menu items
T = 'Best {} in Heber City, UT | Lupita\'s Valley'; D = 'Find out what makes the {} special at Lupita\'s Valley.'
def cat(n): return list(dict.fromkeys(i['name'] for c in CATS if c['name'] == n for i in c['items']))
TAGS = {
 'camarones-a-la-diabla': ('Camarones a la diabla', 'Best Camarones A La Diabla in Heber City, UT.', 'Camarones A La Diabla Delights', ['Camarones a la Diabla']),
 'burritos': ('Burritos', 'Best burritos in Heber City, UT.', 'Indulge in Our Burritos', ['Burrito', "Angelo's Burrito"]),
 'quesadillas': ('Quesadillas', 'Best quesadillas in Heber City, UT.', 'Savor Our Quesadillas', cat('Quesadillas') + ["Zalí's Quesadilla"]),
 'huevos-rancheros': ('Huevos rancheros', 'Best huevos rancheros in Heber City, UT.', 'Delicious Huevos Rancheros Awaits', ['Huevos Rancheros']),
 'carnitas': ('Carnitas', 'Best carnitas in Heber City, UT.', 'Delicious Carnitas Await You', ['Plato De Carnitas', 'Tacos', 'Sopes', 'Rice Bowl']),
 'rice-bowl': ('Rice bowl', 'Best rice bowl in Heber City, UT.', 'Savor Our Rice Bowl', ['Rice Bowl']),
 'pozole': ('Pozole', 'Best Pozole in Heber City, UT.', 'Delicious Pozole Made Fresh', ['Pozole Verde', 'Pozole Rojo']),
 'nachos': ('Nachos', 'Best nachos in Heber City, UT.', 'Savor Our Nachos', ['Nachos', "Nani's Nachos"]),
 'quesabirria': ('Quesabirria', 'Best quesabirria in Heber City, UT.', 'Delicious Quesabirria Awaits You', ['Quesabirria']),
 'bar-food': ('Bar food', 'Best bar food in Heber City, UT.', 'Savor Our Bar Food', ['Nachos', 'Chile con Queso', 'Guacamole', 'Shrimp & Mango Ceviche', 'Salsa Flights']),
 'grilled-chicken': ('Grilled chicken', 'Best grilled chicken in Heber City, UT.', 'Grilled Chicken Delights', ['Plato De Asada', 'Sol y Salud', 'Mole Micha-Poblano', 'Tacos']),
 'tacos': ('Tacos', 'Best tacos in Heber City, UT.', 'Tacos That Delight Your Taste Buds', ['Tacos', "Enzo's Tacos"]),
 'ceviche': ('Ceviche', 'Best ceviche in Heber City, UT.', 'Discover Our Ceviche Delights', ['Shrimp & Mango Ceviche', 'Tostadas de Ceviche']),
 'chilaquiles': ('Chilaquiles', 'Best chilaquiles in Heber City, UT.', 'Delicious Chilaquiles Await You', ['Chilaquiles']),
 'enchiladas': ('Enchiladas', 'Best enchiladas in Heber City, UT.', 'Delicious Enchiladas Await You', cat('Enchiladas')),
 'mole': ('Mole', 'Best mole in Heber City, UT.', 'Discover Our Mole Sauce', ['Mole Micha-Poblano', 'Enchiladas De Mole']),
 'omelette': ('Omelette', 'Best omelette in Heber City, UT.', 'Omelette Selection at Our Restaurant', ['Sunrise Omelette']),
 'soup': ('Soup', 'Best soup in Heber City, UT.', 'Savor Our Flavorful Soups', cat('Soups')),
 'tostadas': ('Tostadas', 'Best tostadas in Heber City, UT.', 'Savor Our Tostadas', cat('Tostadas')),
 'tostadas-de-tinga': ('Tostadas de tinga', 'Best tostadas de tinga in Heber City, UT.', 'Delicious Tostadas de Tinga', ['Tostadas de Tinga']),
 'guacamole': ('Guacamole', 'Best guacamole in Heber City, UT.', 'Delicious Guacamole Made Fresh', ['Guacamole', 'Guacamole Tostadas', 'Guacamole Jalapeño']),
 'fajitas': ('Fajitas', 'Best Fajitas in Heber City, UT.', 'Delicious Fajitas Made Fresh', ['Fajitas']),
}
TAGS2 = {
 'brunch': ("Brunch in Heber City, UT | Lupita's Valley", "Find out why you should eat Brunch at Lupita's Valley.", 'Best brunch in Heber City, UT.', 'Brunch at Our Mexican Restaurant', cat('Brunch Specials')),
 'breakfast': ("Breakfast in Heber City, UT | Lupita's Valley", "Find out why you should eat Breakfast at Lupita's Valley.", 'Best breakfast in Heber City, UT.', 'Savor Our Breakfast Delights', cat('Brunch Specials')),
 'lunch': ("Lunch in Heber City, UT | Lupita's Valley", "Find out why you should eat Lunch at Lupita's Valley.", 'Best lunch in Heber City, UT.', 'Satisfying Lunch Choices', cat('Traditional Dishes') + cat('Quesadillas')),
 'dinner': ("Dinner in Heber City, UT | Lupita's Valley", "Find out why you should eat Dinner at Lupita's Valley.", 'Best dinner in Heber City, UT.', 'Savor Your Dinner with Us', cat('Specialty Dishes')),
 'delivery': ("Lupita's Valley offers Delivery in Heber City, UT", "Order Delivery from Lupita's Valley today.", 'Best delivery in Heber City, UT.', 'Tasty Delivery Options for You', FEATURED),
 'takeout': ("Lupita's Valley offers Takeout in Heber City, UT", "Order Takeout from Lupita's Valley today.", 'Best takeout in Heber City, UT.', 'Savor Our Takeout Delights', FEATURED),
}
REDIRECTS = [('/tags/blt', '/menu'), ('/heber-city', '/'), ('/gift-cards/check', '/gift-cards'), ('/contact', '/page/contact-us'), ('/login', '/rewards'), ('/account', '/rewards')]
LIVE_H2 = {'burritos': 'Irresistible Burritos Await You', 'omelette': 'Omelette Delights', 'quesadillas': 'Delicious Quesadillas Await You', 'huevos-rancheros': 'Huevos Rancheros Delight', 'carnitas': 'Carnitas That Melt in Your Mouth', 'rice-bowl': 'Delicious Rice Bowl Options', 'nachos': 'Savor Our Nachos Today', 'bar-food': 'Savor Our Bar Food', 'brunch': 'Brunch Delights at Our Restaurant', 'chilaquiles': 'Savor Our Chilaquiles', 'mole': 'Discover Our Mole Dishes', 'camarones-a-la-diabla': 'Camarones A La Diabla Delight', 'takeout': 'Satisfy Your Cravings with Takeout', 'grilled-chicken': 'Delicious Grilled Chicken Options', 'ceviche': 'Discover Our Ceviche', 'lunch': 'Satisfy Your Lunch Cravings', 'dinner': 'Savor Our Dinner Offerings'}
DELIVERY_H2 = {k: 'Convenient Delivery and Pickup Options' for k in ('burritos', 'quesadillas', 'carnitas', 'tacos', 'brunch', 'quesabirria', 'pozole', 'enchiladas', 'guacamole', 'fajitas')}
DELIVERY_H2['delivery'] = 'Convenient Delivery and Pickup Choices'
def tags():
    all_t = {k: (T.format(v[0]), D.format(v[0]), v[1], v[2], v[3]) for k, v in TAGS.items()}; all_t.update(TAGS2)
    for k, (ti, de, h1, h2, its) in all_t.items():
        h2 = LIVE_H2.get(k, h2)
        featured = f'<section class="sec"><div class="wrap"><div class="head-row"><h2>Featured</h2>{btn("View menu", "/menu", "ghost")}</div><div class="feats">{"".join(feat(n) for n in FEATURED)}</div></div></section>'
        body = phead(h1) + featured + f'<section class="sec"><div class="wrap menu"><h2>{e(h2)}</h2><div class="items">{"".join(card(BY[n]) for n in its)}</div><div class="row" style="margin-top:2rem">{btn("View full menu", "/menu", "ghost")}{order_btn()}{btn("Reserve a table", "/reservations", "ghost")}</div></div></section>' + location_block()
        body = body.replace('</main>', '') + f'<section class="sec alt"><div class="wrap narrow center-t"><h2>{e(DELIVERY_H2.get(k, "Convenient Delivery and Pickup"))}</h2><p>Order online for delivery or pickup in Heber City.</p>{order_btn()}</div></section>'
        page('/tags/' + k, ti, de, body, extra_head=tag_ld(k.replace('-', ' '), its))
    return all_t
def extras():
    ps = ['/', '/menu', '/catering', '/rewards', '/questions', '/page/parties', '/page/drinks', '/page/our-story', '/gift-cards', '/careers', '/reservations', '/page/pdf-menus', '/page/contact-us', '/privacy', '/terms', '/accessibility'] + ['/tags/' + k for k in list(TAGS) + list(TAGS2)]
    today = datetime.date.today().isoformat()
    sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + ''.join(f'<url><loc>{DOMAIN}{p}</loc><lastmod>{today}</lastmod></url>\n' for p in ps) + '</urlset>\n'
    open(OUT + '/sitemap.xml', 'w').write(sm)
    open(OUT + '/robots.txt', 'w').write(f'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /kitchen\nSitemap: {DOMAIN}/sitemap.xml\n')
    open(OUT + '/robots.live.txt', 'w').write(f'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /kitchen\nSitemap: {DOMAIN}/sitemap.xml\n')  # launch: copy over robots.txt
    open(OUT + '/llms.txt', 'w', encoding='utf8').write(f"# Lupita's Valley | Mexican restaurant in Heber City, UT\n\nAddress: {ADDR1}, {ADDR2}\nPhone: +14356543465\nHours: Mon-Thu 10:30 AM-9 PM; Fri-Sat 10:30 AM-10 PM; Sun closed\n\n- [Full Menu]({DOMAIN}/menu)\n- [Reservations]({DOMAIN}/reservations)\n- [Catering]({DOMAIN}/catering)\n- [Contact]({DOMAIN}/page/contact-us)\n")
    open(OUT + '/_redirects', 'w').write(''.join(f'{a} {b} 301\n' for a, b in REDIRECTS))
    json.dump({'cleanUrls': False, 'trailingSlash': False, 'redirects': [{'source': a, 'destination': b, 'permanent': True} for a, b in REDIRECTS]}, open(OUT + '/vercel.json', 'w'), indent=2)
    nf = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found | Lupita\'s Valley</title><link rel="stylesheet" href="/assets/site.css"></head><body><main><section class="review"><div class="wrap narrow center-t"><img src="/img/site/logo.png" alt="Lupita\'s Valley" width="257" height="64"><h1>We can\'t find that page</h1><p><a class="btn" href="/">Back to home</a> <a class="btn ghost" href="/menu">View menu</a></p></div></section></main></body></html>'
    open(OUT + '/404.html', 'w', encoding='utf8').write(nf)
    for d in ('menus', 'video'):
        os.makedirs(f'{OUT}/{d}', exist_ok=True)
        for fn in os.listdir(f'{A}/{d}'): shutil.copy(f'{A}/{d}/{fn}', f'{OUT}/{d}/{fn}')
    os.makedirs(OUT + '/assets/ordering', exist_ok=True)
    shutil.copytree(os.path.join(HERE, '..', '..', 'web', 'onboarding'), OUT + '/onboarding', dirs_exist_ok=True)
    for fn in ('ordering.js', 'ordering.css', 'order-status.js', 'guest-tools.js', 'reserve.js', 'unsubscribe.js', 'kitchen.js', 'kitchen.css', 'admin.js', 'admin.css'):
        shutil.copy(os.path.join(HERE, '..', '..', 'web', fn), OUT + '/assets/ordering/' + fn)
    os.makedirs(OUT + '/img/app', exist_ok=True)
    for n in (192, 512): shutil.copy(HERE + f'/src/app-{n}.png', OUT + f'/img/app/app-{n}.png')
    shutil.copy(HERE + '/src/sw.js', OUT + '/sw.js')
    open(OUT + '/manifest.webmanifest', 'w', encoding='utf8').write(json.dumps({'name': "Lupita's Valley", 'short_name': "Lupita's", 'start_url': '/?app=1', 'scope': '/', 'display': 'standalone',
        'background_color': '#f7f1e3', 'theme_color': '#931515', 'description': 'Order online, book a table and check your rewards.',
        'icons': [{'src': '/img/app/app-192.png', 'sizes': '192x192', 'type': 'image/png'}, {'src': '/img/app/app-512.png', 'sizes': '512x512', 'type': 'image/png'}, {'src': '/img/app/app-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'}],
        'shortcuts': [{'name': 'Order online', 'url': '/menu'}, {'name': 'Book a table', 'url': '/reservations'}, {'name': 'Rewards', 'url': '/rewards'}]}, indent=1))
    open(OUT + '/offline.html', 'w', encoding='utf8').write('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline | Lupita\'s Valley</title><style>body{margin:0;font:1rem/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f7f1e3;color:#0d0d0d;display:grid;place-items:center;min-height:100vh;text-align:center;padding:1rem}a{color:#931515}</style></head><body><main><h1>You\'re offline</h1><p>Reconnect to order or book a table, or call us at <a href="' + TEL + '">' + PHONE + '</a>.</p></main></body></html>')
    shutil.copy(HERE + '/src/site.css', OUT + '/assets/site.css'); shutil.copy(HERE + '/src/site.js', OUT + '/assets/site.js'); shutil.copy(HERE + '/src/config.js', OUT + '/assets/config.js')
# Live image names are random IDs, so the files get descriptive names here.
IMG_NAMES = {'cocktails.webp': 'specialty-cocktails-lupitas-valley.webp', 'contact.webp': 'contact-lupitas-valley-heber-city.webp', 'd-berry.webp': 'berry-drink-mason-jar.webp', 'd-berry2.webp': 'red-berry-cocktail-lime.webp', 'd-horchata.webp': 'horchata-mason-jar.webp', 'd-jarritos.webp': 'jarritos-tamarind-lime-soda.webp', 'd-mango.webp': 'mango-smoothie-chili-lime-rim.webp', 'd-orange.webp': 'orange-cocktail-chili-salt-rim.webp', 'decor.webp': 'hanging-pot-restaurant-decor.webp', 'exterior-2.webp': 'lupitas-valley-exterior-string-lights.webp', 'exterior.webp': 'lupitas-valley-mexican-restaurant-heber-city.webp', 'gal-ceviche.webp': 'shrimp-mango-ceviche.webp', 'gal-ceviche2.webp': 'ceviche-avocado-lime-tortilla-chips.webp', 'gal-enchiladas.webp': 'enchiladas-mole-rice-beans.webp', 'gal-mole.webp': 'enchiladas-mole-sauce-melted-cheese.webp', 'gal-salsas.webp': 'chips-and-salsa-heber-city.webp', 'hero-poster.webp': 'best-mexican-food-heber-city.webp', 'interior-1.webp': 'lupitas-valley-dining-room.webp', 'interior-2.webp': 'lupitas-valley-rustic-dining-room.webp', 'interior-3.webp': 'lupitas-valley-booths-artwork.webp', 'interior-4.webp': 'lupitas-valley-dining-tables.webp', 'logo.png': 'lupitas-valley-logo.png', 'margaritas.webp': 'fresh-margaritas-heber-city.webp', 'mole.webp': 'mole-micha-poblano-plate.webp', 'parties-form.webp': 'lupitas-valley-party-reservations.webp', 'parties-groups.webp': 'lupitas-valley-group-dining.webp', 'parties-hero.webp': 'lupitas-valley-parties-events.webp', 'register.webp': 'vintage-cash-register-lupitas-valley.webp', 'rellenos.webp': 'chiles-rellenos-plate.webp', 'reservations.webp': 'lupitas-valley-reservations.webp', 'rewards.webp': 'lupitas-valley-rewards-chips-salsa.webp', 'softdrinks.webp': 'aguas-frescas-soft-drinks.webp'}
def heber(name):
    stem, ext = name.rsplit('.', 1)
    return name if 'heber-city' in stem else f'{stem}-heber-city.{ext}'
def rename_images():
    pairs = []
    for folder, table in (('img/site', {**IMG_NAMES, 'favicon.png': 'lupitas-valley-favicon.png'}), ('img/menu', {}), ('menus/img', {}), ('menus', {}), ('qr', {}), ('video', {'hero.mp4': 'mexican-restaurant.mp4'})):
        for fn in sorted(os.listdir(f'{OUT}/{folder}')):
            if not os.path.isfile(f'{OUT}/{folder}/{fn}'): continue
            base = table.get(fn, fn)
            if folder == 'menus': base = base.replace('.pdf', '-menu.pdf')
            if folder == 'qr': base = base.replace('.', '-qr-code.', 1)
            new = heber(base)
            os.replace(f'{OUT}/{folder}/{fn}', f'{OUT}/{folder}/{new}')
            pairs.append((f'/{folder}/{fn}', f'/{folder}/{new}'))
    for root, _, files in os.walk(OUT):
        for fn in files:
            if fn.rsplit('.', 1)[-1] not in ('html', 'css', 'js', 'txt', 'json'): continue
            f = os.path.join(root, fn); t = open(f, encoding='utf8').read(); n = t
            if '/img/' in t or '/menus/' in t or '/video/' in t or '/qr/' in t:
                for a, b in pairs: n = n.replace(a, b)
            if n != t: open(f, 'w', encoding='utf8').write(n)
# build() expects the original names, so a rebuild puts them back first.
def undo_rename():
    site = {heber(b): a for a, b in {**IMG_NAMES, 'favicon.png': 'lupitas-valley-favicon.png'}.items()}
    for folder in ('img/site', 'img/menu', 'menus/img', 'menus', 'qr', 'video'):
        d = f'{OUT}/{folder}'
        if not os.path.isdir(d): continue
        for fn in sorted(os.listdir(d)):
            if not os.path.isfile(f'{d}/{fn}') or 'heber-city' not in fn: continue
            old = site.get(fn) if folder == 'img/site' else fn.replace('-heber-city', '')
            if folder == 'menus': old = old.replace('-menu.pdf', '.pdf')
            if folder == 'qr': old = old.replace('-qr-code.', '.')
            if folder == 'video': old = 'hero.mp4'
            if old: os.replace(f'{d}/{fn}', f'{d}/{old}')
def shade_sections():
    import glob
    # Stack sections in white, cream and sand so no two neighbors match.
    for f in glob.glob(f'{OUT}/**/*.html', recursive=True):
        html = open(f, encoding='utf-8').read()
        n = [-1]
        def shade(_):
            n[0] += 1
            return f'class="sec s{n[0] % 3}"'
        new = re.sub(r'class="sec(?: alt)?"', shade, html)
        if new != html: open(f, 'w', encoding='utf-8').write(new)

def check_links():
    bad = set()
    for root, _, files in os.walk(OUT):
        for fn in files:
            if not fn.endswith(('.html', '.css')): continue
            t = open(os.path.join(root, fn), encoding='utf8').read()
            for u in re.findall(r'(?:src|poster|href|content)="(/(?:img|menus|video|qr|assets)/[^"#?]+)"', t) + re.findall(r'url\((/[^)]+)\)', t):
                if not os.path.isfile(OUT + u): bad.add(u)
    if bad: raise SystemExit(f'Broken file links: {sorted(bad)[:10]}')
if __name__ == '__main__':
    undo_rename(); build(); rename_images(); shade_sections(); check_links(); print('items', len(ITEMS), 'cats', len(CATS))
