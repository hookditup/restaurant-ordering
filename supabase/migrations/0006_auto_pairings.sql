-- Pairings learned from orders. Hand-picked pairs come first, and order data fills the open spots, up to six.

alter table public.restaurants
  add column pairs_auto boolean not null default true,
  add column pairs_days integer not null default 90 check (pairs_days between 1 and 365),
  add column pairs_min_orders integer not null default 5 check (pairs_min_orders between 1 and 1000);

-- Item name -> paired item ids, best first. Names are used because lunch and dinner versions share pairings.
-- A pair needs enough shared orders, and must appear together more often than chance (lift over 1.2),
-- so something on nearly every order does not pair with everything.
create function public.auto_pairs(rid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with r as (select * from public.restaurants where id = rid and pairs_auto),
  o as (
    select o.id from public.orders o join r on o.restaurant_id = r.id
    where o.status = 'completed' and o.test_mode = r.test_mode
      and o.created_at >= now() - make_interval(days => r.pairs_days)),
  l as (select distinct oi.order_id, oi.name from public.order_items oi join o on o.id = oi.order_id),
  total as (select count(*)::numeric n from o),
  each_item as (select name, count(*)::numeric n from l group by name),
  together as (
    select a.name a, b.name b, count(*)::numeric n
    from l a join l b on a.order_id = b.order_id and a.name <> b.name group by a.name, b.name),
  menu as (
    select distinct on (name) name, id from public.menu_items
    where restaurant_id = rid and available order by name, sort),
  ranked as (
    select p.a, m.id, row_number() over (
      partition by p.a order by p.n * t.n / (ca.n * cb.n) desc, p.n desc, p.b) rn
    from together p
    join each_item ca on ca.name = p.a
    join each_item cb on cb.name = p.b
    join menu m on m.name = p.b
    cross join total t cross join r
    where p.n >= r.pairs_min_orders and p.n * t.n / (ca.n * cb.n) > 1.2)
  select coalesce(jsonb_object_agg(a, ids), '{}'::jsonb)
  from (select a, jsonb_agg(id order by rn) ids from ranked where rn <= 12 group by a) x;
$$;

-- One item's pairs: hand-picked first, then learned, one per dish name, six at most.
create function public.menu_pairs(p_item uuid, p_name text, p_auto jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(id order by ord), '[]'::jsonb) from (
    select id, ord from (
      select distinct on (m.name) m.id, x.ord
      from (
        select p.paired_item_id id, p.sort::bigint ord from public.item_pairings p where p.item_id = p_item
        union all
        select e.value::uuid, 1000 + e.ordinality
        from jsonb_array_elements_text(coalesce(p_auto -> p_name, '[]'::jsonb)) with ordinality e
      ) x
      join public.menu_items m on m.id = x.id
      where m.available and m.name <> p_name
      order by m.name, x.ord) d
    order by ord limit 6) y;
$$;

revoke all on function public.auto_pairs(uuid) from public, anon, authenticated;
revoke all on function public.menu_pairs(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.get_menu(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', r.id, 'slug', r.slug, 'name', r.name, 'phone', r.phone, 'address', r.address,
      'timezone', r.timezone, 'hours', r.hours, 'tax_rate_bps', r.tax_rate_bps,
      'guest_fee_bps', r.guest_fee_bps, 'pickup_lead_minutes', r.pickup_lead_minutes,
      'last_order_minutes_before_close', r.last_order_minutes_before_close,
      'accepting_orders', r.accepting_orders, 'test_mode', r.test_mode,
      'delivery_enabled', r.delivery_enabled, 'delivery_lead_minutes', r.delivery_lead_minutes,
      'delivery_min_cents', r.delivery_min_cents, 'doordash_store_url', r.doordash_store_url),
    'popular', public.popular_names(r.id),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'description', c.description, 'note', c.note, 'hours', c.hours,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', i.id, 'ext', i.external_id, 'name', i.name, 'description', i.description, 'price_cents', i.price_cents,
            'image', i.image, 'allergens', i.allergens, 'gluten_free', i.gluten_free,
            'vegetarian', i.vegetarian, 'popular', i.popular,
            'pairs', public.menu_pairs(i.id, i.name, learned.pairs),
            'groups', coalesce((
              select jsonb_agg(public.group_json(img.group_id) order by img.sort)
              from public.item_modifier_groups img where img.item_id = i.id), '[]'::jsonb)
          ) order by i.sort)
          from public.menu_items i where i.category_id = c.id and i.available), '[]'::jsonb)
      ) order by c.sort)
      from public.menu_categories c where c.restaurant_id = r.id and c.active), '[]'::jsonb)
  )
  from public.restaurants r
  cross join lateral (select public.auto_pairs(r.id) pairs) learned
  where r.slug = p_slug and r.active;
$$;

create function public.admin_save_pair_rules(p_restaurant uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_manager(p_restaurant) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.restaurants set
    pairs_auto = coalesce((p->>'pairs_auto')::boolean, pairs_auto),
    pairs_days = coalesce((p->>'pairs_days')::int, pairs_days),
    pairs_min_orders = coalesce((p->>'pairs_min_orders')::int, pairs_min_orders)
  where id = p_restaurant;
end $$;
revoke all on function public.admin_save_pair_rules(uuid, jsonb) from public, anon;
grant execute on function public.admin_save_pair_rules(uuid, jsonb) to authenticated;
