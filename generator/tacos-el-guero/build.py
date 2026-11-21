#!/usr/bin/env python3
"""Static site for tacoselguerout.com (replaces Owner.com). Run: python3 build.py
Content, photos and menu come from the live site, Nov 18, 2026. Every live URL is kept."""
import datetime, html, json, os, re, shutil
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, '..', '..', 'sites', 'tacos-el-guero'); A = os.path.join(HERE, 'assets')
ROOT = os.path.join(HERE, '..', '..')
NAME = 'Tacos El Güero'; DOMAIN = 'https://tacoselguerout.com'
PHONE = '(435) 654-2983'; TEL = 'tel:+14356542983'; EMAIL = 'tacoselguero2llc@gmail.com'
ADDR1 = '281 N Main St'; ADDR2 = 'Heber City, UT 84032'
LEGAL = 'Tacos El Guero 2 LLC'  # footer on the live site reads "TACOS EL GUERO 2LLc"; confirm the exact name
Q = 'Tacos+El+Guero+281+N+Main+St+Heber+City+UT+84032'
DOORDASH = 'https://www.doordash.com/store/el-guero-heber-city-2142428/'
MAPS = f'https://www.google.com/maps/search/?api=1&query={Q}'; DIRS = f'https://www.google.com/maps/dir/?api=1&destination={Q}'
HOURS = [('Monday', '9:00 AM - 9:00 PM'), ('Tuesday', '9:00 AM - 9:00 PM'), ('Wednesday', '9:00 AM - 9:00 PM'), ('Thursday', '9:00 AM - 9:00 PM'), ('Friday', '9:00 AM - 9:00 PM'), ('Saturday', '9:00 AM - 9:00 PM'), ('Sunday', '10:00 AM - 9:00 PM')]
NAV = [('Menu', '/menu'), ('Our Story', '/story'), ('Events', '/events'), ("We're Hiring", '/careers'), ('Gift Cards', '/gift-cards')]
MORE = [('Rewards', '/rewards'), ('Questions', '/questions'), ('Leave a Review', '/review')]
LOGO = '/img/site/tacos-el-guero-logo.png'
e = html.escape
ARROW = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'

# ---- menu (same data the ordering system imports)
SEED = os.path.join(ROOT, 'seed', 'tacos-el-guero', 'tacos-el-guero-seed.json')
seed = json.load(open(SEED, encoding='utf8'))
GROUPS = {g['id']: g for g in seed['groups']}
def price_text(i):
    low, more = i['price_cents'], False
    for gid in i['groups']:
        prices = [o['price_cents'] for o in GROUPS[gid]['options']]
        if GROUPS[gid]['min'] > 0 and prices:
            low += min(prices); more = more or max(prices) > min(prices)
    return f'${low / 100:.2f}' + ('+' if more else '')
CATS = [{'name': c['name'], 'items': [{'ext': i['id'], 'name': i['name'], 'desc': i['description'] or '', 'price': price_text(i), 'img': i['image']} for i in c['items']]} for c in seed['categories']]
ITEMS = [i for c in CATS for i in c['items']]; BY = {i['name']: i for i in ITEMS}

def cid(n): return re.sub(r'[^a-z0-9]+', '-', n.lower()).strip('-')
def btn(label, href, kind='', attrs=''): return f'<a class="btn {kind}" href="{e(href)}"{attrs}>{e(label)} {ARROW}</a>'
def order_btn(kind=''): return f'<a class="btn {kind}" href="{TEL}" data-order>Call to order {ARROW}</a>'
def img(src, alt, w=800, h=600, cls='', eager=False):
    return f'<img src="{src}" alt="{e(alt)}" width="{w}" height="{h}"' + (f' class="{cls}"' if cls else '') + (' fetchpriority="high"' if eager else ' loading="lazy" decoding="async"') + '>'
def addr(text): return f'<a class="addr" href="{MAPS}" rel="noopener" target="_blank">{text}<span class="sr-only"> (opens Google Maps in a new tab)</span></a>'
def ld(o): return '<script type="application/ld+json">' + json.dumps(o, ensure_ascii=False).replace('</', '<\\/') + '</script>\n'

def schema():
    return {'@context': 'https://schema.org', '@type': 'Restaurant', 'name': NAME, 'alternateName': 'Tacos El Guero #1 - Heber City', 'url': DOMAIN + '/', 'telephone': '+1-435-654-2983', 'email': EMAIL,
        'image': DOMAIN + '/img/site/tacos-el-guero-share.webp', 'logo': DOMAIN + LOGO, 'servesCuisine': ['Mexican', 'Tex-Mex', 'Tacos', 'Burritos', 'Birria', 'Breakfast', 'Seafood'], 'menu': DOMAIN + '/menu', 'hasMenu': DOMAIN + '/menu',
        'acceptsReservations': False, 'priceRange': '$', 'geo': {'@type': 'GeoCoordinates', 'latitude': 40.5114238, 'longitude': -111.4138249},
        'areaServed': ['Heber City', 'Daniel', 'Midway', 'Center Creek', 'Interlaken', 'Charleston', 'Jordanelle', 'Wallsburg', 'Timber Lakes', 'Hideout', 'Francis', 'Park City', 'Woodland'],
        'address': {'@type': 'PostalAddress', 'streetAddress': ADDR1, 'addressLocality': 'Heber City', 'addressRegion': 'UT', 'postalCode': '84032', 'addressCountry': 'US'},
        'openingHoursSpecification': [{'@type': 'OpeningHoursSpecification', 'dayOfWeek': ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], 'opens': '09:00', 'closes': '21:00'},
                                      {'@type': 'OpeningHoursSpecification', 'dayOfWeek': ['Sunday'], 'opens': '10:00', 'closes': '21:00'}]}

def page(path, title, desc, body, active='', extra_head='', robots='', og='tacos-el-guero-share.webp'):
    nav = ''.join(f'<a href="{h}"' + (' aria-current="page"' if h == active else '') + f'>{e(n)}</a>' for n, h in NAV)
    more = ''.join(f'<a href="{h}">{e(n)}</a>' for n, h in MORE)
    foot = ''.join(f'<li><a href="{h}">{e(n)}</a></li>' for n, h in NAV + MORE)
    hours = ''.join(f'<li><span>{d}</span><span>{t}</span></li>' for d, t in HOURS)
    canon = DOMAIN + path
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
<meta property="og:image" content="{DOMAIN}/img/site/{og}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/img/site/tacos-el-guero-favicon.png">
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#b3261e"><link rel="apple-touch-icon" href="/img/app/app-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
{ld(schema())}{extra_head}<!-- ANALYTICS_HEAD: paste GA4 / Meta Pixel scripts here -->
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="hdr">
<div class="wrap hdr-in">
<a class="logo" href="/"><img src="{LOGO}" alt="{NAME} home" width="200" height="100"></a>
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
<div><img src="{LOGO}" alt="{NAME}" width="160" height="80" loading="lazy">
<p>{addr(ADDR1 + '<br>' + ADDR2)}</p><p><a href="{TEL}">{PHONE}</a><br><a href="mailto:{EMAIL}">{EMAIL}</a></p></div>
<div><h2>Explore</h2><ul class="ftr-links">{foot}</ul></div>
<div><h2>Hours</h2><ul class="hours">{hours}</ul></div>
</div>
<div class="wrap legal"><span>© {datetime.date.today().year} {LEGAL}. All rights reserved.</span><span><a href="/privacy">Privacy</a> · <a href="/terms">Terms of service</a> · <a href="/accessibility">Accessibility</a></span></div>
</footer>
<nav class="bar" aria-label="Quick actions"><a href="{TEL}">Call</a><a href="/menu" data-order-bar>Order</a></nav>
<script src="/assets/config.js"></script>
<script src="/assets/site.js" defer></script>
<!-- ANALYTICS_BODY: paste body tracking scripts here -->
</body>
</html>
'''
    d = OUT + path; os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'index.html'), 'w', encoding='utf8').write(doc)

def card(i):
    pic = img(i['img'], i['name'], 400, 300) if i['img'] else ''
    return f'''<article class="item{'' if pic else ' noimg'}" data-item="{e(i['ext'])}"><div class="item-t"><h3>{e(i['name'])}</h3><p>{e(i['desc'])}</p><span class="price">{e(i['price'])}</span></div>{pic}</article>'''
def cat_of(i): return next(c['name'] for c in CATS if i in c['items'])
def feat(n):
    i = BY[n]
    pic = img(i['img'], '', 400, 300) if i['img'] else '<span class="feat-noimg" aria-hidden="true"></span>'  # name is shown right below
    return f'<a class="feat" href="/menu#{cid(cat_of(i))}">{pic}<span>{e(n)}</span></a>'
def location_block():
    hours = ''.join(f'<li><span>{d}</span><span>{t}</span></li>' for d, t in HOURS)
    return f'''<section class="sec"><div class="wrap loc"><div><h2>Our location</h2><h3>{NAME}</h3><p>{addr(ADDR1 + '<br>' + ADDR2)}</p>
<p><a href="{TEL}">Call {PHONE}</a><br><a href="mailto:{EMAIL}">Email {EMAIL}</a></p>
<p class="today" data-today></p><ul class="hours">{hours}</ul><div class="row">{btn('Get directions', DIRS, 'ghost', ' rel="noopener"')}{order_btn()}</div></div>
<iframe title="Map showing {NAME} on Main Street in Heber City" src="https://www.google.com/maps?q=281+N+Main+St,+Heber+City,+UT+84032&output=embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div></section>'''
def faq(pairs): return '<div class="faq">' + ''.join(f'<details><summary>{e(q)}</summary><p>{a}</p></details>' for q, a in pairs) + '</div>'
def phead(h, sub='', h1=None, vis='h2'):
    top = f'<h1 class="sr-only">{e(h1)}</h1><{vis} class="ph">{e(h)}</{vis}>' if h1 else f'<h1>{e(h)}</h1>'
    return f'<section class="phead"><div class="wrap">{top}' + (f'<p>{sub}</p>' if sub else '') + '</div></section>'
def split(title, text, image, alt, cta='', flip=False, tag='h2'):
    return f'''<section class="sec"><div class="wrap split{' flip' if flip else ''}"><div class="split-t"><{tag}>{e(title)}</{tag}><p>{text}</p>{cta}</div>{img('/img/site/' + image + '.webp', alt, 800, 600)}</div></section>'''
def gallery(title, items):
    pics = ''.join(img(f'/img/site/{s}.webp', a, 600, 450) for s, a in items)
    return f'<section class="sec alt"><div class="wrap"><h2>{e(title)}</h2><div class="scroller gal-scroll" data-scroller="40" role="group" aria-label="{e(title)}" tabindex="0"><div class="scroller-track">{pics}</div></div></div></section>'

# ---- forms
def field(name, label, typ='text', req=True, opts=None):
    r = ' required' if req else ''; star = ' <span aria-hidden="true">*</span>' if req else ''; fid = 'f-' + name
    if opts is not None: c = f'<select id="{fid}" name="{name}"{r}><option value="">Select</option>' + ''.join(f'<option>{e(o)}</option>' for o in opts) + '</select>'
    elif typ == 'textarea': c = f'<textarea id="{fid}" name="{name}" rows="4"{r}></textarea>'
    else: c = f'<input id="{fid}" name="{name}" type="{typ}" autocomplete="{ {"name": "name", "email": "email", "phone": "tel"}.get(name, "off") }"{r}>'
    return f'<div class="fld"><label for="{fid}">{e(label)}{star}</label>{c}</div>'
SMS = f'''<label class="chk"><input type="checkbox" name="sms_consent" value="yes"><span>I agree to receive marketing text messages from {NAME} about specials and offers. Consent is not required to order or use our services. <a href="/privacy">Privacy Policy</a> <a href="/terms">Terms and Conditions</a> Message and data rates may apply. Message frequency varies. Reply STOP to cancel, HELP for help.</span></label>'''
def form(fid, fields, submit, sms=False):
    return f'''<form class="form" data-form="{fid}" novalidate>{''.join(fields)}{SMS if sms else ''}
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<button class="btn" type="submit">{e(submit)} {ARROW}</button><p class="form-msg" role="status" aria-live="polite"></p></form>'''

# ---- content from the live site
REVIEWS = [('Craig B.', 'Amazing Mexican food restaurant in the middle of Heber City. Fast food with the quality of a sit down. There is something for everyone; I especially liked the help yourself salsa bar, a wide variety of choices on the menu with old fashioned favorites as well as unique tastes. Tacos El Guero is a great place for a quick bite or a sit down dinner.'),
 ('Savanna H.', 'tacos el guero is so good! there is a fun vibe in the restaurant and a good atmosphere. they have really good service and get food to you quickly. such a good restaurant with good food and good prices! (the horchata is the best!!)'),
 ('Doug P.', "Legit the best tacos I've ever tasted in utah. I don't even live close and I'll be back because they're worth the drive. I had beef, pastor, birria, and chorizo... Every single one was unique and had a depth of flavor most taco places won't achieve. It was amazing, seriously.")]
KNOWN = 'Chimichanga, Breakfast, Breakfast Burrito, Tacos, Tex Mex, Chicken Tenders, Churros, Ceviche, Carne Asada, Guacamole, Milanesa, Quesadilla, Tortas, Menudo, Seafood, Latin America Food, Mexican Rice, Flour Tortillas, Quesabirria Tacos, Birria Burritos, Cheeseburger, Burritos, Fast Food, Eggs, Huevos Rancheros, Fries, Carnitas, Chilaquiles, Enchiladas, Nachos, Taco Salad, Pozole, Flan, Birria, Quesabirria, Ceviche Tostada, and Tostadas'
HOME_FAQ = [('What are you known for?', f'We are known for {KNOWN}.'),
 ('What meals do you serve?', 'We serve breakfast, lunch, and dinner. Breakfast is served all day.'),
 ('Do you offer delivery or takeout?', f'Yes. <a href="/menu">Order online for pickup</a>, get delivery through <a href="{DOORDASH}" rel="noopener">DoorDash</a>, or call us at <a href="{TEL}">{PHONE}</a>.'),
 ('Where are you located?', f'We are located in Heber City, UT at {addr(ADDR1)}.'),
 ('What areas do you serve?', 'We serve the following areas: Heber City, Heber, Daniel, Midway, Center Creek, Interlaken, Charleston, Mound City, Jordanelle, Hailstone, Cranmer, Keetley, Wallsburg, Timber Lakes, Hideout, Independence, Francis, Park City, and Woodland.'),
 ('Anything else?', 'We are also known for being a family friendly restaurant.')]
FEATURED = ['Egg Platter (Mexican Style)', 'Taco', 'Chimichanga', 'Quesadilla', '(3) Quesabirria Tacos with Consome', 'Burrito']
STRIP = ['Breakfast Served All Day', 'Healthy Options', 'Easy Parking', 'Pickup or Delivery', 'Family Owned on Main Street']
FAMILY = "Jose &amp; Selena started off as a husband and wife team running a local food truck at farmer’s markets. Shortly after, they opened their first restaurant in the heart of Heber City, which outgrew itself quickly. This resulted in the purchase of a larger location where they are now located at."
GENERATIONS = "Creating a future for their family was the mission behind providing outstanding, authentic Mexican food to the Heber Valley. Jose &amp; Selena’s passion to serve their community while also providing for their family is the heart behind Tacos El Güero."
GALLERY = [('al-pastor-tacos-onion-cilantro', 'Al pastor street tacos on corn tortillas topped with diced onion and cilantro.'),
 ('enchiladas-refried-beans-cheese', 'Enchiladas topped with lettuce, tomato and shredded cheese, with refried beans.'),
 ('breakfast-platter-hash-browns', 'Scrambled eggs with ham and peppers, hash browns and English muffins on a black plate.'),
 ('grilled-chicken-street-tacos', 'Grilled chicken street tacos on corn tortillas on a green plate.'),
 ('consome-beef-broth', 'A bowl of consomé beef broth topped with onion and cilantro.')]

def home():
    reviews = ''.join(f'<figure class="rev"><div class="stars" aria-label="5 out of 5 stars">★★★★★</div><blockquote>{e(t)}</blockquote><figcaption>{e(n)}</figcaption></figure>' for n, t in REVIEWS)
    body = f'''<section class="hero"><div class="hero-scrim"></div><div class="wrap hero-t"><h1>Best Mexican Food in Heber City</h1><p class="hero-h">Unveiling the Finest Mexican Flavors</p><div class="row">{order_btn()}{btn('View menu', '/menu', 'light')}</div></div></section>
<section class="sec specials-sec" data-specials hidden><div class="wrap"><h2>Specials</h2><div class="specials-list"></div></div></section>
<section class="sec"><div class="wrap"><div class="head-row"><h2>Featured</h2>{btn('View menu', '/menu', 'ghost')}</div><div class="feats">{''.join(feat(n) for n in FEATURED)}</div></div></section>
<div class="strip"><ul class="wrap">{''.join(f'<li>{e(s)}</li>' for s in STRIP)}</ul></div>
{gallery('Food that Brings Happiness!', GALLERY)}
{split('Fiery Flavor Fusion', 'Immerse yourself in the tender embrace of our seasoned and grilled Asada, delivering an explosion of savory goodness in every bite. Prepared with care and precision, our Asada will transport your taste buds to a realm of culinary delight. For those who crave a little heat, our nachos come with a kick! Jalapeños and our signature spicy salsa add just the right amount of fiery excitement to tantalize your taste buds.', 'carne-asada-super-nachos', 'Super nachos piled with carne asada, pico de gallo, guacamole and sour cream.')}
{split('What sets our Tacos Al Pastor apart?', "Our Tacos Al Pastor feature thinly sliced, marinated pork that's been expertly seasoned with a blend of traditional spices, including achiote, garlic, and pineapple. The result? An explosion of flavors in every juicy bite! The sweet, caramelized goodness of pineapple that's grilled to perfection, adding a delightful contrast to the savory pork. It's a fiesta for your taste buds!", 'carne-asada-street-tacos', 'Street tacos piled with grilled meat, diced onion and cilantro.', flip=True)}
{split('Crispy, Flavorful, and Unforgettable.', "We believe in quality ingredients. Our Chimichangas are made with the freshest produce, premium meats, and authentic spices, providing a wholesome and delicious dining experience. Whether you're a meat lover, vegetarian, or somewhere in between, our diverse Chimichanga menu has something for everyone.", 'smothered-burrito-green-sauce', 'A burrito smothered in green sauce and cheese with lettuce, guacamole and sour cream.')}
{split('Sizzling Sensation!', "Succulent, seasoned beef or lamb, slow-cooked to perfection until it's fall-apart tender. The result? A taco experience that's not just a meal but a culinary journey. The crispy edges, the juicy center, and the tantalizing aroma will transport you straight to the heart of Mexico.", 'quesabirria-tacos-consome', 'Crispy quesabirria tacos stuffed with shredded beef, with a cup of consomé.', flip=True)}
{split('Order From Our Website', 'Order directly from our website to save money in fees, get faster service, earn free food via our rewards program, and support local business.', 'birria-tacos-rice-beans-plate', 'A plate of birria tacos with Mexican rice, refried beans and consomé.', order_btn())}
<section class="sec alt"><div class="wrap welcome"><h2>Welcome to Tacos El Güero!</h2><p>We pride ourselves with the ability to offer our customers delicious and authentic Mexican food, created at the highest standards.</p><ul aria-label="We offer"><li>Breakfast</li><li>Lunch</li><li>Dinner</li></ul><p>Come and experience the authentic Mexican taste!</p></div></section>
{split("It's All About Family", FAMILY, 'jose-and-selena-owners-tacos-el-guero', 'Jose and Selena, the husband and wife who own Tacos El Güero.', btn('Our story', '/story', 'ghost'))}
{split('Generations in The Making', GENERATIONS, 'tacos-el-guero-main-street-building', 'The Tacos El Güero building on Main Street in Heber City, with its tall oval sign by the road.', flip=True)}
<section class="sec alt"><div class="wrap"><h2>What guests are saying</h2><div class="scroller revs-scroll" data-scroller="28" role="group" aria-label="Guest reviews" tabindex="0"><div class="scroller-track">{reviews}</div></div><p class="center">{btn('Leave us a review', '/review', 'ghost')}</p></div></section>
<section class="sec"><div class="wrap cards3">
<article class="cta-card">{img('/img/site/chips-and-salsa.webp', 'Tortilla chips with a cup of red salsa', 600, 400)}<h2>Tacos El Guero's Rewards</h2><p>Join our rewards program to earn points, get free items, and stay up to date with us.</p>{btn('Join rewards', '/rewards')}</article>
<article class="cta-card">{img('/img/site/al-pastor-street-tacos-heber-city.webp', 'Al pastor street tacos with onion and cilantro', 600, 400)}<h2>Gift Cards</h2><p>Give the gift of a delicious meal. Send a gift card by email in minutes.</p>{btn('Buy a gift card', '/gift-cards')}</article>
<article class="cta-card">{img('/img/site/tacos-el-guero-main-street-building.webp', 'The Tacos El Güero building and sign on Main Street', 600, 400)}<h2>We're Hiring</h2><p>We are always hiring A players who work hard, love helping others, and do great work.</p>{btn('Apply today', '/careers')}</article>
</div></section>
<section class="sec alt"><div class="wrap narrow"><h2>Frequently asked questions</h2>{faq(HOME_FAQ)}<p class="center">{btn('Ask us a question', '/questions', 'ghost')}</p></div></section>
{location_block()}'''
    plain = lambda t: re.sub(r'<[^>]+>', '', t)
    extra = ('<link rel="preload" as="image" href="/img/site/al-pastor-street-tacos-heber-city-800.webp" media="(max-width: 800px)" fetchpriority="high">\n'
             '<link rel="preload" as="image" href="/img/site/al-pastor-street-tacos-heber-city.webp" media="(min-width: 801px)" fetchpriority="high">\n') + ld({'@context': 'https://schema.org', '@type': 'FAQPage', 'url': DOMAIN + '/', 'mainEntity': [{'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': plain(a)}} for q, a in HOME_FAQ]}) + ld({'@context': 'https://schema.org', '@type': 'WebSite', 'name': NAME, 'url': DOMAIN + '/'})
    page('/', 'Best Mexican Food in Heber City, UT | Tacos El Guero #1 - Heber City | Mexican Food near me', 'Tacos El Guero #1 - Heber City: the best Mexican Food in Heber City, UT. Order directly online today for takeout or delivery. Save money, support local business!', body, extra_head=extra)

def menu():
    pop = ''.join(card(BY[n]) for n in FEATURED)
    secs = ''.join(f'<section class="cat" id="{cid(c["name"])}"><h2>{e(c["name"])}</h2><div class="items">{"".join(card(i) for i in c["items"])}</div></section>' for c in CATS)
    menu_ld = ld({'@context': 'https://schema.org', '@type': 'Menu', 'name': f'{NAME} Menu', 'url': DOMAIN + '/menu', 'hasMenuSection': [{'@type': 'MenuSection', 'name': c['name'], 'hasMenuItem': [{'@type': 'MenuItem', 'name': i['name'], 'description': i['desc'], 'offers': {'@type': 'Offer', 'price': i['price'].strip('$+'), 'priceCurrency': 'USD'}} for i in c['items']]} for c in CATS]})
    body = f'''<section class="phead"><div class="wrap"><h1>Tacos El Güero Menu</h1><p>{addr(ADDR1 + ', Heber City, UT')} · <span data-today></span></p><div class="row" style="justify-content:center">{order_btn()}</div></div></section>
<div class="wrap menu"><div id="ro-menu"><section class="cat"><h2>Popular</h2><div class="items">{pop}</div></section>{secs}</div></div>
<script src="/assets/ordering/ordering.js" defer></script>'''
    page('/menu', 'Tacos El Guero #1 - Heber City Online Menu | Best Mexican Food in Heber City', 'Tacos El Guero #1 - Heber City Online Menu. Save Money Ordering Directly Here. Healthy Options. Fast Service. Friendly Team. Top Rated.', body, '/menu', '<link rel="stylesheet" href="/assets/ordering/ordering.css">\n' + menu_ld)

# ---- tag SEO pages: same URL, title, description and headings as the live site; items picked from the real menu
TAGS = json.load(open(os.path.join(HERE, 'tags.json'), encoding='utf8'))
def match(*pats, cats=()):
    out = [i['name'] for c in CATS for i in c['items'] if c['name'] in cats or any(re.search(p, i['name'] + ' ' + i['desc'], re.I) for p in pats)]
    return list(dict.fromkeys(out))
def catn(*names): return [i['name'] for c in CATS if c['name'] in names for i in c['items']]
TAG_ITEMS = {
 'birria-burritos': match(r'birria burrito', r'calibirria'), 'birria': match(r'birria'), 'breakfast-burrito': ['Breakfast Burrito'], 'breakfast': catn('Breakfast (Served All Day)'),
 'burritos': match(r'burrito'), 'carne-asada': match(r'carne asada', r'\basada\b'), 'carnitas': match(r'carnitas'), 'ceviche-tostada': ['Ceviche Tostada'], 'ceviche': match(r'ceviche'),
 'cheeseburger': match(r'burger'), 'chicken-tenders': ['Kids Chicken Tenders'], 'chilaquiles': match(r'chilaquiles'), 'chimichanga': ['Chimichanga'], 'churros': ['Churros (3)'],
 'delivery': FEATURED, 'dinner': catn('El Guero Favorite Plates'), 'eggs': match(r'\beggs?\b', r'huevos'), 'enchiladas': match(r'enchilada'), 'family-friendly-restaurant': catn('Kids'),
 'fast-food': catn('El Guero Favorites')[:12], 'flan': ['Flan'], 'flour-tortillas': ['Harina (Flour) Tortillas (4)', 'Burrito', 'Quesadilla'], 'fries': match(r'fries'), 'guacamole': match(r'guacamole')[:12],
 'huevos-rancheros': ['Huevos Rancheros'], 'latin-america-food': catn('El Guero Favorite Plates')[:10], 'lunch': catn('El Guero Favorites')[:12], 'menudo': ['Menudo'], 'mexican-rice': ['Mexican Rice'] + match(r'\brice\b')[:8],
 'milanesa': match(r'milanesa'), 'nachos': match(r'nacho'), 'pozole': ['Pozole'], 'quesabirria-tacos': ['(3) Quesabirria Tacos with Consome', 'Tacos Birria (3) with Ramen'], 'quesabirria': match(r'quesa ?birria', r'quesa tostada'),
 'quesadilla': match(r'quesadilla'), 'seafood': catn('Mariscos (Seafood)'), 'taco-salad': ['Taco Salad'], 'tacos': match(r'\btacos?\b')[:14], 'takeout': FEATURED, 'tex-mex': ['Super Nachos', 'Super Fries', 'Chimichanga', '#4 Fajitas', 'Taco Salad', 'Smothered Burrito'],
 'tortas': match(r'\btorta\b', r'torta '), 'tostadas': match(r'tostada')}
def tags():
    for k, t in TAGS.items():
        its = [n for n in TAG_ITEMS[k] if n in BY] or FEATURED
        h1, h2 = t['heads'][0], t['heads'][2] if len(t['heads']) > 2 else 'Menu favorites'
        dh = t['heads'][3] if len(t['heads']) > 3 else 'Convenient Delivery and Pickup'
        rows = [{'@type': 'MenuItem', 'name': n, 'description': BY[n]['desc'], 'offers': {'@type': 'Offer', 'price': BY[n]['price'].strip('$+'), 'priceCurrency': 'USD'}} for n in its]
        body = phead(h1) + f'<section class="sec"><div class="wrap"><div class="head-row"><h2>Featured</h2>{btn("View menu", "/menu", "ghost")}</div><div class="feats">{"".join(feat(n) for n in FEATURED)}</div></div></section>' \
            + f'<section class="sec"><div class="wrap menu"><h2>{e(h2)}</h2><div class="items">{"".join(card(BY[n]) for n in its)}</div><div class="row" style="margin-top:2rem">{btn("View full menu", "/menu", "ghost")}{order_btn()}</div></div></section>' \
            + f'<section class="sec alt"><div class="wrap narrow center-t"><h2>{e(dh)}</h2><p>Order online for pickup in Heber City, or get delivery through DoorDash.</p><div class="row" style="justify-content:center">{order_btn()}{btn("Delivery on DoorDash", DOORDASH, "ghost", " rel=\"noopener\"")}</div></div></section>' + location_block()
        page('/tags/' + k, t['title'], t['desc'], body, extra_head=ld({'@context': 'https://schema.org', '@type': 'ItemList', 'name': f"{k.replace('-', ' ').title()} at {NAME}", 'numberOfItems': len(rows), 'itemListElement': rows}))

REDIRECTS = [('/login', '/rewards'), ('/account', '/rewards'), ('/download-app', '/'), ('/heber-city', '/'), ('/gift-cards/check', '/gift-cards'), ('/contact', '/questions')]
def build():
    if os.path.isdir(OUT): shutil.rmtree(OUT)
    os.makedirs(OUT + '/assets/ordering', exist_ok=True)
    shutil.copytree(A + '/img', OUT + '/img')
    home(); menu(); tags()
    page('/story', 'Tacos El Guero #1 - Heber City | Our Story', 'Tacos El Guero #1 - Heber City Official Website. Save Money Ordering Directly Here. Healthy Options. Fast Service. Friendly Team. Top Rated.',
        phead('Our Story') + split("It's All About Family", FAMILY, 'jose-and-selena-owners-tacos-el-guero', 'Jose and Selena, the husband and wife who own Tacos El Güero.')
        + split('Generations in The Making', GENERATIONS, 'tacos-el-guero-main-street-building', 'The Tacos El Güero building on Main Street in Heber City, with its tall oval sign by the road.', btn('See our menu', '/menu', 'ghost'), flip=True)
        + gallery('From Our Kitchen', GALLERY) + location_block(), '/story')
    page('/events', 'Events at Tacos El Guero #1 - Heber City', 'Tacos El Guero #1 - Heber City Official Website. Save Money Ordering Directly Here. Healthy Options. Fast Service. Friendly Team. Top Rated.',
        phead('Events') + f'<section class="sec"><div class="wrap narrow events-empty"><h2>There are no events right now</h2><p>Check back later to see if we\'ve added any.</p>{btn("Ask us a question", "/questions", "ghost")}</div></section>' + location_block(), '/events')
    f = form('careers', [field('name', 'Full name'), field('email', 'Email', 'email'), field('phone', 'Phone number', 'tel'), field('comment', 'A few sentences about yourself', 'textarea')], 'Submit')
    page('/careers', 'Careers at Tacos El Guero #1 - Heber City', 'Tacos El Guero #1 - Heber City Official Website. Save Money Ordering Directly Here. Healthy Options. Fast Service. Friendly Team. Top Rated.',
        phead("We're Hiring", 'We are always hiring A players who work hard, love helping others, and do great work. Fill out the 2 minute form below with a few sentences about you.', h1='Careers at Tacos El Güero')
        + f'<section class="sec"><div class="wrap narrow"><h2>Why work with us?</h2><p><strong>Location:</strong> {NAME}, {addr(ADDR1 + ", Heber City")}</p>{f}<p class="small">Have a resume? Email it to <a href="mailto:{EMAIL}">{EMAIL}</a>.</p></div></section>', '/careers')
    page('/gift-cards', 'Tacos El Guero #1 - Heber City Gift Cards', 'Buy Tacos El Guero #1 - Heber City gift cards online. The perfect gift for any occasion. Send a gift card instantly to family or friends.',
        phead('Give the perfect gift for any occasion', 'Give the gift of a delicious meal with our restaurant gift cards!') + '<div class="ro-page"><div id="ro-gift"><p>Loading…</p></div></div><script src="/assets/ordering/guest-tools.js" defer></script>', '/gift-cards', '<link rel="stylesheet" href="/assets/ordering/ordering.css">\n')
    months = ''.join(f'<option value="{i + 1}">{m}</option>' for i, m in enumerate(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']))
    bday = f'<fieldset class="fld bday-set"><legend>Birthday (optional, for a birthday treat)</legend><div class="bday"><div class="fld"><label for="f-birth_month">Month</label><select id="f-birth_month" name="birth_month"><option value="">Select</option>{months}</select></div><div class="fld"><label for="f-birth_day">Day</label><input id="f-birth_day" name="birth_day" type="number" min="1" max="31" inputmode="numeric" autocomplete="off"></div></div></fieldset>'
    f = form('rewards', [field('name', 'Name'), field('phone', 'Mobile phone', 'tel'), field('email', 'Email', 'email', False), bday], 'Join rewards', sms=True)
    page('/rewards', "Rewards | Tacos El Güero", 'Join Tacos El Güero rewards in Heber City. Earn points on every order and redeem them for free food.',
        phead("Tacos El Guero's Rewards", 'Join our rewards program to earn points, get free items, and stay up to date with us.') + f'<section class="sec"><div class="wrap split"><div>{f}</div>{img("/img/site/chips-and-salsa.webp", "Tortilla chips with a cup of red salsa", 800, 600)}</div></section><section class="sec"><div class="ro-page"><div id="ro-rewards"></div></div></section><script src="/assets/ordering/guest-tools.js" defer></script>', extra_head='<link rel="stylesheet" href="/assets/ordering/ordering.css">\n')
    f = form('question', [field('name', 'Name'), field('phone', 'Phone', 'tel', False), field('email', 'Email', 'email'), field('message', 'Your question', 'textarea')], 'Send my question')
    page('/questions', 'Questions | Tacos El Güero', 'Answers to common questions about Tacos El Güero in Heber City, or send us your question.',
        phead('Have a question?', "Check the answers below, or send us your question and we'll get back to you as soon as we can.") + f'<section class="sec"><div class="wrap split top"><div><h2>Common questions</h2>{faq(HOME_FAQ)}</div><div><h2>Ask us</h2>{f}</div></div></section>')
    page('/review', 'Leave a Review | Tacos El Güero', 'Leave a review for Tacos El Güero in Heber City, UT.',
        f'<section class="review"><div class="wrap narrow center-t"><img src="{LOGO}" alt="{NAME}" width="200" height="100"><h1>How was your visit?</h1><p>Thank you for eating with us. A quick Google review helps a family restaurant more than you know.</p>{btn("Leave a Google review", MAPS, "", " data-review rel=\"noopener\"")}<p class="small"><a href="/questions">Need to reach us directly? Send us a message.</a></p></div></section>', robots='<meta name="robots" content="noindex">\n')
    page('/order', f'Your Order | {NAME}', f'Track your {NAME} order.', '<div class="ro-page"><div id="ro-status" aria-live="polite"><p>Loading your order…</p></div></div><script src="/assets/ordering/order-status.js" defer></script>', extra_head='<link rel="stylesheet" href="/assets/ordering/ordering.css">\n', robots='<meta name="robots" content="noindex">\n')
    page('/unsubscribe', f'Email preferences | {NAME}', f'Manage marketing emails from {NAME}.', '<section class="phead"><div class="wrap"><h1>Email preferences</h1></div></section><section class="sec"><div class="wrap narrow" id="ro-unsub" aria-live="polite"><noscript><p>Please call us to unsubscribe.</p></noscript></div></section><script src="/assets/ordering/unsubscribe.js" defer></script>', robots='<meta name="robots" content="noindex">\n')
    for d, css, js, t in (('kitchen', 'kitchen.css', 'kitchen.js', 'Kitchen'), ('admin', 'admin.css', 'admin.js', 'Admin')):
        os.makedirs(f'{OUT}/{d}', exist_ok=True)
        open(f'{OUT}/{d}/index.html', 'w', encoding='utf8').write(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>{t} | {NAME}</title><link rel="stylesheet" href="/assets/ordering/{css}"></head><body><main id="ro-{d}"></main><script src="/assets/config.js"></script><script src="/assets/ordering/{js}" defer></script></body></html>')
    legal = lambda t, b: phead(t) + f'<section class="sec"><div class="wrap narrow prose">{b}</div></section>'
    contact = f'<h2>Contact</h2><p>Questions? Email <a href="mailto:{EMAIL}">{EMAIL}</a> or call <a href="{TEL}">{PHONE}</a>.</p>'
    page('/privacy', f'Privacy Policy | {NAME}', f'{NAME} privacy policy.', legal('Privacy Policy', f'<p>{LEGAL}, doing business as {NAME}, operates this website.</p><h2>What we collect</h2><p>We collect what you enter on our site, such as your name, email, phone number, order details and job applications, and basic site usage data. Card payments are processed by our payment provider; we do not store card numbers.</p><h2>How we use it</h2><p>To prepare your order, contact you about it, run our rewards and gift cards, answer questions and improve our service. If you opt in, we send marketing texts or emails. Mobile opt-in data and consent are not shared with third parties for their marketing.</p><h2>Text messages and email</h2><p>Reply STOP to cancel texts or HELP for help. Message and data rates may apply. Message frequency varies. Every marketing email has an unsubscribe link.</p>' + contact))
    page('/terms', f'Terms and Policies - {NAME}', f'{NAME} website terms.', legal('Terms and Policies', f'<p>This website is operated by {LEGAL}, doing business as {NAME}. By using it, you agree to these terms.</p><p>Menu items, prices and hours can change without notice. Online orders are confirmed when you receive a confirmation. Gift cards and rewards points have no cash value except where the law requires it. Text message terms: reply STOP to cancel or HELP for help; message and data rates may apply.</p>' + contact))
    page('/accessibility', f'Accessibility - {NAME}', f'{NAME} accessibility statement.', legal('Accessibility', f'<p>We want everyone to be able to use this website. We work to meet the Web Content Accessibility Guidelines (WCAG) 2.2, Level AA.</p><h2>How we support access</h2><ul><li>Every page works with a keyboard and has a skip link.</li><li>Photos have text descriptions.</li><li>Forms have clear labels and error messages.</li><li>Moving photos have a Pause button and stay still if your device is set to reduce motion.</li></ul><h2>Need help or have feedback?</h2><p>Call <a href="{TEL}">{PHONE}</a> or email <a href="mailto:{EMAIL}">{EMAIL}</a> and we will help.</p>'))
    extras()

# Vercel (production): photos cached a week, CSS/JS an hour (file names don't change on edit).
VERCEL_HEADERS = [{'source': '/img/(.*)', 'headers': [{'key': 'Cache-Control', 'value': 'public, max-age=604800, stale-while-revalidate=86400'}]},
        {'source': '/assets/(.*)', 'headers': [{'key': 'Cache-Control', 'value': 'public, max-age=3600, stale-while-revalidate=86400'}]},
        {'source': '/(.*)', 'headers': [{'key': 'X-Content-Type-Options', 'value': 'nosniff'}, {'key': 'Referrer-Policy', 'value': 'strict-origin-when-cross-origin'}]}]

def extras():
    ps = ['/', '/menu', '/story', '/events', '/careers', '/gift-cards', '/rewards', '/questions', '/privacy', '/terms', '/accessibility'] + ['/tags/' + k for k in TAGS]
    today = datetime.date.today().isoformat()
    open(OUT + '/sitemap.xml', 'w').write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + ''.join(f'<url><loc>{DOMAIN}{p}</loc><lastmod>{today}</lastmod></url>\n' for p in ps) + '</urlset>\n')
    # Test site stays out of search engines; launch swaps in robots.live.txt.
    open(OUT + '/robots.live.txt', 'w').write(f'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /kitchen\nSitemap: {DOMAIN}/sitemap.xml\n')
    open(OUT + '/robots.txt', 'w').write('User-agent: *\nDisallow: /\n')
    open(OUT + '/llms.txt', 'w', encoding='utf8').write(f'# {NAME} | Mexican restaurant in Heber City, UT\n\nAddress: {ADDR1}, {ADDR2}\nPhone: +14356542983\nHours: Mon-Sat 9 AM-9 PM; Sun 10 AM-9 PM. Breakfast served all day.\n\n- [Menu and online ordering]({DOMAIN}/menu)\n- [Our story]({DOMAIN}/story)\n- [Gift cards]({DOMAIN}/gift-cards)\n- [Rewards]({DOMAIN}/rewards)\n- [Questions]({DOMAIN}/questions)\n')
    open(OUT + '/_redirects', 'w').write(''.join(f'{a} {b} 301\n' for a, b in REDIRECTS))
    json.dump({'cleanUrls': False, 'trailingSlash': False, 'headers': VERCEL_HEADERS, 'redirects': [{'source': a, 'destination': b, 'permanent': True} for a, b in REDIRECTS]}, open(OUT + '/vercel.json', 'w'), indent=2)
    open(OUT + '/404.html', 'w', encoding='utf8').write(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found | {NAME}</title><link rel="stylesheet" href="/assets/site.css"></head><body><main><section class="review"><div class="wrap narrow center-t"><img src="{LOGO}" alt="{NAME}" width="200" height="100"><h1>We can\'t find that page</h1><p><a class="btn" href="/">Back to home</a> <a class="btn ghost" href="/menu">View menu</a></p></div></section></main></body></html>')
    shutil.copytree(os.path.join(ROOT, 'web', 'onboarding'), OUT + '/onboarding', dirs_exist_ok=True)
    for fn in ('ordering.js', 'ordering.css', 'order-status.js', 'guest-tools.js', 'reserve.js', 'unsubscribe.js', 'kitchen.js', 'kitchen.css', 'admin.js', 'admin.css'):
        shutil.copy(os.path.join(ROOT, 'web', fn), OUT + '/assets/ordering/' + fn)
    os.makedirs(OUT + '/img/app', exist_ok=True)
    for n in (192, 512): shutil.copy(HERE + f'/src/app-{n}.png', OUT + f'/img/app/app-{n}.png')
    for fn, dest in (('sw.js', 'sw.js'), ('site.css', 'assets/site.css'), ('site.js', 'assets/site.js'), ('config.js', 'assets/config.js')): shutil.copy(HERE + '/src/' + fn, OUT + '/' + dest)
    open(OUT + '/manifest.webmanifest', 'w', encoding='utf8').write(json.dumps({'name': NAME, 'short_name': 'El Güero', 'start_url': '/?app=1', 'scope': '/', 'display': 'standalone', 'background_color': '#fff6e3', 'theme_color': '#b3261e',
        'description': 'Order online, check your rewards and buy gift cards.', 'icons': [{'src': '/img/app/app-192.png', 'sizes': '192x192', 'type': 'image/png'}, {'src': '/img/app/app-512.png', 'sizes': '512x512', 'type': 'image/png'}, {'src': '/img/app/app-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'}],
        'shortcuts': [{'name': 'Order online', 'url': '/menu'}, {'name': 'Rewards', 'url': '/rewards'}]}, indent=1, ensure_ascii=False))
    open(OUT + '/offline.html', 'w', encoding='utf8').write(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline | {NAME}</title><style>body{{margin:0;font:1rem/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff6e3;color:#0d0d0d;display:grid;place-items:center;min-height:100vh;text-align:center;padding:1rem}}a{{color:#b3261e}}</style></head><body><main><h1>You\'re offline</h1><p>Reconnect to order, or call us at <a href="{TEL}">{PHONE}</a>.</p></main></body></html>')
    shutil.copy(SEED, OUT + '/assets/menu-seed.json')

def shade_sections():
    import glob
    for f in glob.glob(f'{OUT}/**/*.html', recursive=True):
        t = open(f, encoding='utf-8').read(); n = [-1]
        def shade(_):
            n[0] += 1; return f'class="sec s{n[0] % 3}"'
        new = re.sub(r'class="sec(?: alt)?"', shade, t)
        if new != t: open(f, 'w', encoding='utf-8').write(new)
def check_links():
    bad = set()
    for root, _, files in os.walk(OUT):
        for fn in files:
            if not fn.endswith(('.html', '.css')): continue
            t = open(os.path.join(root, fn), encoding='utf8').read()
            for u in re.findall(r'(?:src|href|content)="(/(?:img|assets)/[^"#?]+)"', t) + re.findall(r'url\((/[^)]+)\)', t):
                if not os.path.isfile(OUT + u): bad.add(u)
    if bad: raise SystemExit(f'Broken file links: {sorted(bad)[:10]}')
if __name__ == '__main__':
    build(); shade_sections(); check_links(); print('items', len(ITEMS), 'cats', len(CATS), 'tags', len(TAGS))
