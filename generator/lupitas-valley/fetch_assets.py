import json, os, subprocess, sys
root = sys.argv[1]
os.makedirs(root + '/img/menu', exist_ok=True); os.makedirs(root + '/img/site', exist_ok=True)
os.makedirs(root + '/menus', exist_ok=True); os.makedirs(root + '/video', exist_ok=True)
B = 'https://lupitasvalley.com'
MENU = """Chiles Rellenos=932d6412-9aea-415a-8bc0-13ac3227f4dc;Enchiladas Catalinas=072fe0d4-4333-42cf-a186-7a57f4f5f46d;Mole Micha-Poblano=881e8e0b-2dba-43da-a5be-8533c3792992;Sopes=8a4d21a3-137d-44e1-b8fd-91d3d583f63f;Enchiladas Suizas=04c925b5-3c5e-43b7-b9ae-b4abf844beda;Camarones a la Diabla=34dc1ccc-10e8-4082-8498-7dbfa01bcaf7;Berry French Toast=44f4f225-3f7a-4002-bed6-c38c65bde6e5;Sunrise Omelette=ef467ae8-33ec-4237-b5df-c0d2d1db14d0;Sol y Salud=91935c92-2dec-4c85-a212-be995a65e43a;Chilaquiles=0bf14f8e-1afc-4238-a857-7541c3861e53;Rice Bowl=8e1b2455-a7f6-4885-9e87-b1b9ad23e209;Guacamole=8e8e97ea-abeb-488b-8f32-61bf38a29b6b;Chile con Queso=337bf1f2-f565-40a6-bbab-8c92ad4e53f6;Shrimp & Mango Ceviche=54d5f101-b89f-4e09-a7da-a7599869f0f7;Nachos=db32f673-09b4-44ea-b71b-273656193f6d;House Corn Chips=b1d6a735-9023-44fe-88ba-87206c1fe7d4;Pico de Gallo=7ec4ecd7-1fc6-4046-a7c6-d259ddcdb697;Piña Mango=4accb639-a6e5-4372-bf48-a91bca1eb7a2;Crema Cilantro=7f1a3c84-3882-4a60-919b-67f099c51954;Honey Chipotle=27d8cb4f-60ad-4326-bf3f-61e1259e27b9;Crema Chipotle=91fcb8ec-6cf0-485b-93a1-5affb00dfe56;Molcajete=ecd75ad6-ad16-40a2-80fa-3f23f990bc4a;Guacamole Jalapeño=a1e3ccad-8775-446f-be68-64021f76038e;Tomatillo Jalapeño=5f5a799b-915c-4f0e-bbc0-ac675bdfac47;Habanero Asado=af738792-38d9-4197-9e10-706787307f56;Salsa Arbol=34038532-b886-41ac-918d-ff8a685d9fa7;Pozole Verde=d1eb9205-a9eb-444a-a8d4-f2db43b3fd43;Pozole Rojo=16dc4a12-06bd-4dff-82b4-b7efcd106e22;Mango, Avocado &..=3c7b9333-c7f6-488f-b0bb-25ec82e99f33;Ranchero=43df23fc-98bc-4d57-be53-2e4faa99d0ab;Caesar=8588a2bd-4ed7-421b-85ac-a835cc6c2cf8;Plato De Carnitas=778a069a-690b-42d8-9563-fd71b10b03e5;Plato De Asada=33933045-2eab-4e65-a8bd-dd62a6ac70c2;Puerco Con Chile Verde=30787957-a308-41f5-9a27-a66f1098bfa6;Enchiladas Rojas=8654ec40-b608-4178-86b9-1956045ef67e;Enchiladas Verdes=3ff410d7-ee5b-4219-865a-7d0ebb5ce611;Enchiladas De Mole=3db13231-b480-42fb-9941-d952e49e7b14;Tacos=0a2f2361-4be2-419f-b615-fe25b70c2f89;Burrito=7a31ce1a-c1e2-4438-9b2b-a4ed41d028aa;Fajitas=e777f474-fafa-4bdb-9c8a-f885ea3418bd;Lupita's Quesadilla=8aa2a6ba-0c95-46ff-900e-3ba9ecf35d76;House Quesadilla=1a546111-b402-4a6c-8725-46976e0560be;Quesabirria=3efaad38-1d72-4374-a87f-1d4abace8b78;Tostadas de Tinga=fe87a3c0-4f38-4bcf-8b78-57fb1db32055;Guacamole Tostadas=cd36e1bb-bb2c-4aa1-aed2-c38c0061b5e8;Tostadas de Ceviche=bac298b7-c41a-4a55-a932-d12ea7d9deb6;Lupita's Strawberry Tres Leches=bb43db9d-0358-4b55-9b4b-3dc44315823e;Flan=8662d451-9eff-43a3-96fa-b7d357876a48;Pumpkin Flan=394f44bf-f8d7-4827-b8fa-95c6724d8b27;Nani's Nachos=11851c3b-fe59-4b49-8019-02fa23e8e70f;Enzo's Tacos=f968e531-2373-4ea4-9d6a-02ef61e25cc7;Johnny's Tenders=6c4ab35d-14ef-4a48-8ad8-f0aa86bc27b0;Miguelito's Burger=6d2bf027-4162-4506-b910-e406e1d6b136;Shirley Temple=f2eba46d-4f81-4f9b-9773-907564a259a6.jpg;Mango Mule=1c63c9c9-2812-435e-b765-95f007f1475d;Kid's Honest Juice=923bf9a6-fbdd-4159-80dd-2a00bfa70781.png;Blackberry Mojito=dc7601c7-70cb-4b85-a769-052a277a2b9b.jpg;Horizon Milk=ce84495d-17a8-4625-a38d-a56273551ee2.png;Horchata=e71d7fbe-f3f4-4d8a-b3ca-a3a323efae1d.jpg;Jamaica=407562d1-401f-4fa6-ac69-f6542722d284.jpg;Mango Pineapple=15b51aca-a00e-4f3d-83c2-f07f34aec8ce;Tejava Iced Tea=3a0d919d-0523-488a-bec1-43a1f0be3e59;Boylan Bottling=83f7777e-9d76-4f7e-8590-6d018b0fefa4;Jarritos=961dc725-60ba-48f2-b48d-81f7f39e85b0;Coca-Cola=a156a985-902d-4ca1-be29-cd89d8f1be6a;Diet | Zero Coke=92fa5d23-352d-4a9f-a2ac-2d09ea3ad7f1"""
SITE = {
 'logo': '/pluto-images/672c4c47-d85e-4cc5-ba32-27aac005446e.png', 'hero-poster': '/pluto-videos/fJe1vDu9JPP0/78d86d3528dc9849a38c/poster.jpg',
 'mole': '/pluto-images/62e31ed6-2e42-4349-aa42-7892d7159597.jpg', 'gal-salsas': '/pluto-images/external-images/M08B4kSlHLS1-4cHDgX24wenz.jpg',
 'gal-enchiladas': '/pluto-images/external-images/MFx4QkkipmzA-DS7ytW32pI2V.jpg', 'gal-ceviche': '/pluto-images/external-images/9mmjHKBXCXwA-SoFAODHMB1OQ.jpg',
 'gal-mole': '/pluto-images/external-images/VPvnrAbCH8Oz-JZSOMX7LiQNo.jpg', 'margaritas': '/pluto-images/external-images/7rvnfJAoE9ig-j3C8I5yPjNvM.jpg',
 'gal-ceviche2': '/pluto-images/external-images/GGw8hLzrzRjG-otrxHGzfYR7e.jpg', 'interior-1': '/pluto-images/external-images/BbTGOZGBIIWv-13ABbRH3oELK.jpg',
 'rewards': '/pluto-images/69e72156-d19d-4572-8f2a-ff866bc3f4a1.jpg', 'reservations': '/pluto-images/605931ec-8a0e-4ed3-a51b-2eb393c6213a.jpg',
 'exterior': '/pluto-images/external-images/LvFKhXuBnmAM-xUHzsHcXSaB3.jpg', 'cocktails': '/pluto-images/external-images/HjSMAQAwmVph-2K7ZqsYvlMyu.jpg',
 'softdrinks': '/pluto-images/external-images/VkGqvTGkFeeL-JYQChDEIArmU.jpg', 'parties-hero': '/pluto-images/external-images/fBoPzUS810oT-A8ONVe42B2az.jpg',
 'parties-groups': '/pluto-images/external-images/HFCpNHoI5372-4GsFpm4klcCL.jpg', 'interior-2': '/pluto-images/external-images/bOorXGMYTKou-RQr8RjFkK2pA.jpg',
 'interior-3': '/pluto-images/external-images/sjj18NaXI7Uz-UxB6Q4BjTCkW.jpg', 'interior-4': '/pluto-images/02a4e334-12d3-411d-a513-3ed5871f451c.jpg',
 'register': '/pluto-images/46eb63b4-f057-452d-ad38-15c91fea98f1.jpg', 'parties-form': '/pluto-images/external-images/ttfTyoyk2JRX-0yccNYCBb2S0.jpg',
 'rellenos': '/pluto-images/external-images/1YAhU9WA4mn3-xrDVeN5hG1H2.jpg', 'exterior-2': '/pluto-images/external-images/DeGhPB5JFQDH-miB4KM8gm3JG.jpg',
 'decor': '/pluto-images/external-images/svmg9FLLYDn2-BCdGaTSAAkkM.jpg', 'contact': '/pluto-images/1efd2852-4bd9-4fc6-a51f-e26a314d9dfe.jpg',
}
SCOUT = {'d-orange': 'mi_NtFw17LPYxwsP7ZY', 'd-mango': 'mi_HnxtKYbjoj3ulPYK', 'd-berry': 'mi_8qFL6gC24csbAIru', 'd-berry2': 'mi_yL82wRN67F4M8jzL', 'd-horchata': 'mi_obqtR6Vh7ztvA8Dq', 'd-jarritos': 'mi_OoXkiZnumQwGCfa1'}
PDF = {'dinner': '20cc3451-a674-4fe9-828f-771f54a1d4f9', 'brunch': 'a5b2dff1-28a9-4111-9cd3-4088dfaab11a', 'appetizers': 'b28e7989-462b-43b6-96cb-619eb51afacd', 'kids': '0f05f29b-c772-489f-bfc6-e2316a2a6093', 'desserts': '305f850e-e3ef-43fc-a6ae-834235c1b8c3', 'soft-drinks': 'a82ce564-3578-465e-b104-c36ccf998987', 'spirits-cocktails': '43fc094d-07d0-44ac-80c5-ee7856b9d5eb'}
def slug(s):
    t = s.lower().replace('ñ', 'n').replace('é', 'e').replace('í', 'i')
    return ''.join(c if c.isalnum() else '-' for c in t).strip('-').replace('--', '-').replace('--', '-')
jobs = []; menu_map = {}
for pair in MENU.split(';'):
    n, i = pair.rsplit('=', 1); menu_map[n] = slug(n); jobs.append((B + '/pluto-images/funnel/images/' + i, root + '/img/menu/raw-' + slug(n)))
for k, v in SITE.items(): jobs.append((B + v, root + '/img/site/raw-' + k))
for k, v in SCOUT.items(): jobs.append(('https://scout.owner.sh/media/' + v, root + '/img/site/raw-' + k))
for k, v in PDF.items(): jobs.append(('https://static-content.owner.com/document/' + v + '.pdf', root + '/menus/' + k + '.pdf'))
jobs.append((B + '/pluto-videos/fJe1vDu9JPP0/78d86d3528dc9849a38c/hero.mp4', root + '/video/hero.mp4'))
open(root + '/menu_map.json', 'w').write(json.dumps(menu_map, ensure_ascii=False))
bad = 0
for u, p in jobs:
    r = subprocess.run(['curl', '-s', '-m', '60', '-o', p, '-w', '%{http_code}', u], capture_output=True, text=True).stdout
    if r != '200': bad += 1; print('FAIL', r, u); os.path.exists(p) and os.remove(p)
print('jobs', len(jobs), 'failed', bad)
