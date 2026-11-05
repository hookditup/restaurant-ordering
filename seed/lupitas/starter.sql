-- Lupita's Valley starter settings. Run after import_menu, which clears pairings.
update public.restaurants set delivery_enabled = true, doordash_store_url = 'https://www.doordash.com/store/lupitas-valley-heber-city-2161325/' where slug = 'lupitas-valley';
insert into public.item_pairings (item_id, paired_item_id, sort)
select i.id, p.id, x.ord
from public.menu_items i join public.menu_categories c on c.id = i.category_id
cross join (values ('Guacamole', 0), ('Chile con Queso', 1), ('Horchata', 2), ('Flan', 3)) x(name, ord)
join lateral (select m.id from public.menu_items m where m.restaurant_id = i.restaurant_id and m.name = x.name limit 1) p on true
where c.name in ('Traditional Dishes', 'Enchiladas', 'Specialty Dishes') and i.id <> p.id on conflict do nothing;
