-- Owner admin, Popular dishes, add-on pairings and delivery.

alter table public.restaurants
  add column delivery_enabled boolean not null default false,
  add column delivery_lead_minutes integer not null default 45 check (delivery_lead_minutes between 0 and 240),
  add column delivery_min_cents integer not null default 0 check (delivery_min_cents >= 0),
  add column delivery_test_fee_cents integer not null default 599 check (delivery_test_fee_cents >= 0),
  add column doordash_store_url text,
  add column popular_days integer not null default 30 check (popular_days between 1 and 365),
  add column popular_min_orders integer not null default 10 check (popular_min_orders >= 0),
  add column popular_count integer not null default 6 check (popular_count between 1 and 24);

alter table public.orders
  add column delivery_address jsonb,
  add column delivery_fee_cents integer not null default 0,
  add column delivery_id text,
  add column delivery_tracking_url text,
  add column delivery_status text;

-- One pairing rule per item. Lunch and dinner versions of a dish share theirs.
create table public.item_pairings (
  item_id uuid not null references public.menu_items(id) on delete cascade,
  paired_item_id uuid not null references public.menu_items(id) on delete cascade,
  sort integer not null default 0,
  primary key (item_id, paired_item_id),
  check (item_id <> paired_item_id)
);
alter table public.item_pairings enable row level security;
revoke all on public.item_pairings from anon, authenticated;
grant all on public.item_pairings to service_role;

create function public.is_manager(rid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff s where s.restaurant_id = rid and s.user_id = (select auth.uid()) and s.role = 'manager');
$$;
revoke all on function public.is_manager(uuid) from public, anon;
grant execute on function public.is_manager(uuid) to authenticated;

-- Dish names ranked by picked-up orders, or the hand-picked dishes until there is enough history.
create function public.popular_names(rid uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.restaurants; total integer; res jsonb;
begin
  select * into r from public.restaurants where id = rid;
  select count(*) into total from public.orders o
    where o.restaurant_id = rid and o.status = 'completed' and o.test_mode = r.test_mode
      and o.created_at >= now() - make_interval(days => r.popular_days);
  if total >= r.popular_min_orders and total > 0 then
    select jsonb_agg(name order by n desc, name) into res from (
      select oi.name, count(distinct o.id) n from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where o.restaurant_id = rid and o.status = 'completed' and o.test_mode = r.test_mode
        and o.created_at >= now() - make_interval(days => r.popular_days)
        and exists (select 1 from public.menu_items m where m.restaurant_id = rid and m.name = oi.name and m.available)
      group by oi.name order by n desc, oi.name limit r.popular_count) t;
  end if;
  if res is null then
    select jsonb_agg(name order by name) into res from (
      select distinct m.name from public.menu_items m where m.restaurant_id = rid and m.popular and m.available
      order by m.name limit r.popular_count) t;
  end if;
  return coalesce(res, '[]'::jsonb);
end $$;
revoke all on function public.popular_names(uuid) from public, anon, authenticated;

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
            'id', i.id, 'name', i.name, 'description', i.description, 'price_cents', i.price_cents,
            'image', i.image, 'allergens', i.allergens, 'gluten_free', i.gluten_free,
            'vegetarian', i.vegetarian, 'popular', i.popular,
            'pairs', coalesce((select jsonb_agg(p.paired_item_id order by p.sort) from public.item_pairings p where p.item_id = i.id), '[]'::jsonb),
            'groups', coalesce((
              select jsonb_agg(public.group_json(img.group_id) order by img.sort)
              from public.item_modifier_groups img where img.item_id = i.id), '[]'::jsonb)
          ) order by i.sort)
          from public.menu_items i where i.category_id = c.id and i.available), '[]'::jsonb)
      ) order by c.sort)
      from public.menu_categories c where c.restaurant_id = r.id and c.active), '[]'::jsonb)
  )
  from public.restaurants r where r.slug = p_slug and r.active;
$$;

-- ---------- owner admin: every function checks for a manager login ----------
create function public.admin_stats(p_restaurant uuid, p_days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.restaurants; d integer := greatest(1, least(coalesce(p_days, 30), 730)); since timestamptz; prior timestamptz; result jsonb;
begin
  if not public.is_manager(p_restaurant) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into r from public.restaurants where id = p_restaurant;
  since := now() - make_interval(days => d); prior := since - make_interval(days => d);
  with paid as (
    select o.* from public.orders o where o.restaurant_id = p_restaurant and o.test_mode = r.test_mode
      and o.payment_status in ('paid', 'test_paid', 'gift_card') and o.status not in ('cancelled', 'expired', 'awaiting_payment')),
  now_o as (select * from paid where created_at >= since),
  prev as (select * from paid where created_at >= prior and created_at < since)
  select jsonb_build_object(
    'days', d, 'test_mode', r.test_mode,
    'sales_cents', coalesce((select sum(total_cents) from now_o), 0),
    'prev_sales_cents', coalesce((select sum(total_cents) from prev), 0),
    'orders', (select count(*) from now_o),
    'prev_orders', (select count(*) from prev),
    'tips_cents', coalesce((select sum(tip_cents) from now_o), 0),
    'tax_cents', coalesce((select sum(tax_cents) from now_o), 0),
    'discount_cents', coalesce((select sum(discount_cents) from now_o), 0),
    'gift_used_cents', coalesce((select sum(gift_applied_cents) from now_o), 0),
    'delivery_fee_cents', coalesce((select sum(delivery_fee_cents) from now_o), 0),
    'pickup_orders', (select count(*) from now_o where fulfillment = 'pickup'),
    'delivery_orders', (select count(*) from now_o where fulfillment = 'delivery'),
    'cancelled', (select count(*) from public.orders o where o.restaurant_id = p_restaurant and o.test_mode = r.test_mode and o.status = 'cancelled' and o.created_at >= since),
    'by_day', coalesce((select jsonb_agg(x order by x->>'day') from (
      select jsonb_build_object('day', to_char(created_at at time zone r.timezone, 'YYYY-MM-DD'), 'orders', count(*), 'sales_cents', sum(total_cents)) x
      from now_o group by to_char(created_at at time zone r.timezone, 'YYYY-MM-DD')) t), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(x order by (x->>'hour')::int) from (
      select jsonb_build_object('hour', extract(hour from pickup_at at time zone r.timezone)::int, 'orders', count(*)) x
      from now_o group by extract(hour from pickup_at at time zone r.timezone)) t), '[]'::jsonb),
    'by_weekday', coalesce((select jsonb_agg(x order by (x->>'day')::int) from (
      select jsonb_build_object('day', extract(dow from pickup_at at time zone r.timezone)::int, 'orders', count(*), 'sales_cents', sum(total_cents)) x
      from now_o group by extract(dow from pickup_at at time zone r.timezone)) t), '[]'::jsonb),
    'top_items', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('name', oi.name, 'qty', sum(oi.qty), 'orders', count(distinct oi.order_id), 'sales_cents', sum(oi.line_total_cents)) x
      from public.order_items oi join now_o o on o.id = oi.order_id group by oi.name order by sum(oi.qty) desc, oi.name limit 15) t), '[]'::jsonb),
    'rewards_members', (select count(*) from public.rewards_accounts a where a.restaurant_id = p_restaurant),
    'rewards_new', (select count(*) from public.rewards_accounts a where a.restaurant_id = p_restaurant and a.created_at >= since),
    'rewards_points', coalesce((select sum(points) from public.rewards_accounts a where a.restaurant_id = p_restaurant), 0),
    'gift_sold_cents', coalesce((select sum(initial_cents) from public.gift_cards g where g.restaurant_id = p_restaurant and g.test_mode = r.test_mode and g.status = 'active' and g.created_at >= since), 0),
    'gift_outstanding_cents', coalesce((select sum(balance_cents) from public.gift_cards g where g.restaurant_id = p_restaurant and g.test_mode = r.test_mode and g.status = 'active'), 0),
    'reservations', (select count(*) from public.reservations v where v.restaurant_id = p_restaurant and v.created_at >= since),
    'messages', (select count(*) from public.form_submissions f where f.restaurant_id = p_restaurant and f.created_at >= since)
  ) into result;
  return result;
end $$;

create function public.admin_menu(p_restaurant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_manager(p_restaurant) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'lunch', c.external_id like '%:lunch',
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'description', i.description, 'price_cents', i.price_cents, 'image', i.image,
        'available', i.available, 'popular', i.popular, 'gluten_free', i.gluten_free, 'vegetarian', i.vegetarian,
        'pairs', coalesce((select jsonb_agg(p.paired_item_id order by p.sort) from public.item_pairings p where p.item_id = i.id), '[]'::jsonb)) order by i.sort)
        from public.menu_items i where i.category_id = c.id), '[]'::jsonb)) order by c.sort)
      from public.menu_categories c where c.restaurant_id = p_restaurant), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name,
      'options', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'price_cents', o.price_cents, 'available', o.available) order by o.sort)
        from public.modifier_options o where o.group_id = g.id), '[]'::jsonb)) order by g.name)
      from public.modifier_groups g where g.restaurant_id = p_restaurant), '[]'::jsonb));
end $$;

create function public.admin_save_item(p_item uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.menu_items;
begin
  select * into i from public.menu_items where id = p_item;
  if i.id is null or not public.is_manager(i.restaurant_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if (p->>'price_cents')::int < 0 or length(coalesce(p->>'name', i.name)) = 0 then raise exception 'check the item'; end if;
  -- Price and text belong to this version. Sold-out and featured follow the dish at lunch and dinner.
  update public.menu_items set name = coalesce(p->>'name', name), description = coalesce(p->>'description', description),
    price_cents = coalesce((p->>'price_cents')::int, price_cents), image = case when p ? 'image' then p->>'image' else image end,
    gluten_free = coalesce((p->>'gluten_free')::boolean, gluten_free), vegetarian = coalesce((p->>'vegetarian')::boolean, vegetarian)
    where id = p_item;
  update public.menu_items set available = coalesce((p->>'available')::boolean, available), popular = coalesce((p->>'popular')::boolean, popular)
    where restaurant_id = i.restaurant_id and name = i.name;
end $$;

create function public.admin_new_item(p_category uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.menu_categories; nid uuid;
begin
  select * into c from public.menu_categories where id = p_category;
  if c.id is null or not public.is_manager(c.restaurant_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(coalesce(trim(p->>'name'), '')) = 0 or coalesce((p->>'price_cents')::int, -1) < 0 then raise exception 'check the item'; end if;
  insert into public.menu_items (restaurant_id, category_id, name, description, price_cents, sort)
  values (c.restaurant_id, c.id, trim(p->>'name'), coalesce(p->>'description', ''), (p->>'price_cents')::int,
    coalesce((select max(sort) + 1 from public.menu_items where category_id = c.id), 0)) returning id into nid;
  return nid;
end $$;

create function public.admin_save_option(p_option uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.modifier_options;
begin
  select * into o from public.modifier_options where id = p_option;
  if o.id is null or not public.is_manager(o.restaurant_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if (p->>'price_cents')::int < 0 then raise exception 'check the price'; end if;
  update public.modifier_options set price_cents = coalesce((p->>'price_cents')::int, price_cents), available = coalesce((p->>'available')::boolean, available) where id = p_option;
end $$;

create function public.admin_set_pairs(p_item uuid, p_pairs uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.menu_items; v uuid; pid uuid; n integer;
begin
  select * into i from public.menu_items where id = p_item;
  if i.id is null or not public.is_manager(i.restaurant_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(array_length(p_pairs, 1), 0) > 6 then raise exception 'six pairings at most'; end if;
  for v in select id from public.menu_items where restaurant_id = i.restaurant_id and name = i.name loop
    delete from public.item_pairings where item_id = v;
    n := 0;
    foreach pid in array coalesce(p_pairs, '{}') loop
      if pid <> v and exists (select 1 from public.menu_items m where m.id = pid and m.restaurant_id = i.restaurant_id) then
        insert into public.item_pairings (item_id, paired_item_id, sort) values (v, pid, n) on conflict do nothing;
        n := n + 1;
      end if;
    end loop;
  end loop;
end $$;

-- Dishes guests already order together, to guide pairing choices.
create function public.admin_pair_ideas(p_restaurant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.restaurants; res jsonb;
begin
  if not public.is_manager(p_restaurant) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into r from public.restaurants where id = p_restaurant;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into res from (
    select jsonb_build_object('a', a.name, 'b', b.name, 'orders', count(distinct a.order_id)) x
    from public.order_items a join public.order_items b on a.order_id = b.order_id and a.name < b.name
    join public.orders o on o.id = a.order_id
    where o.restaurant_id = p_restaurant and o.status = 'completed' and o.test_mode = r.test_mode
    group by a.name, b.name order by count(distinct a.order_id) desc, a.name limit 15) t;
  return res;
end $$;

create function public.admin_save_settings(p_restaurant uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_manager(p_restaurant) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.restaurants set
    hours = coalesce(p->'hours', hours),
    pickup_lead_minutes = coalesce((p->>'pickup_lead_minutes')::int, pickup_lead_minutes),
    alert_email = case when p ? 'alert_email' then nullif(trim(p->>'alert_email'), '') else alert_email end,
    forms_email = case when p ? 'forms_email' then nullif(trim(p->>'forms_email'), '') else forms_email end,
    rewards_points_per_dollar = coalesce((p->>'rewards_points_per_dollar')::int, rewards_points_per_dollar),
    rewards_redeem_points = coalesce((p->>'rewards_redeem_points')::int, rewards_redeem_points),
    rewards_redeem_cents = coalesce((p->>'rewards_redeem_cents')::int, rewards_redeem_cents),
    gift_min_cents = coalesce((p->>'gift_min_cents')::int, gift_min_cents),
    gift_max_cents = coalesce((p->>'gift_max_cents')::int, gift_max_cents),
    delivery_enabled = coalesce((p->>'delivery_enabled')::boolean, delivery_enabled),
    delivery_lead_minutes = coalesce((p->>'delivery_lead_minutes')::int, delivery_lead_minutes),
    delivery_min_cents = coalesce((p->>'delivery_min_cents')::int, delivery_min_cents),
    doordash_store_url = case when p ? 'doordash_store_url' then nullif(trim(p->>'doordash_store_url'), '') else doordash_store_url end,
    popular_days = coalesce((p->>'popular_days')::int, popular_days),
    popular_min_orders = coalesce((p->>'popular_min_orders')::int, popular_min_orders),
    popular_count = coalesce((p->>'popular_count')::int, popular_count)
  where id = p_restaurant;
end $$;

do $$ declare f text; begin
  foreach f in array array['admin_stats(uuid, integer)', 'admin_menu(uuid)', 'admin_save_item(uuid, jsonb)', 'admin_new_item(uuid, jsonb)',
    'admin_save_option(uuid, jsonb)', 'admin_set_pairs(uuid, uuid[])', 'admin_pair_ideas(uuid)', 'admin_save_settings(uuid, jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Menu photos uploaded in the admin. The folder name is the restaurant id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy menu_images_manager_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-images' and public.is_manager(((storage.foldername(name))[1])::uuid));
create policy menu_images_manager_update on storage.objects for update to authenticated
  using (bucket_id = 'menu-images' and public.is_manager(((storage.foldername(name))[1])::uuid));
