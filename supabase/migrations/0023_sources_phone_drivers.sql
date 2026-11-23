-- 1. Where guests come from: the channel (Google, social, our texts…), source and campaign behind
--    every order, reservation, form and rewards sign-up. Set by the ordering function (core.js channelOf).
alter table public.orders add column channel text, add column source text, add column campaign text;
alter table public.reservations add column channel text, add column source text, add column campaign text;
alter table public.form_submissions add column channel text, add column source text, add column campaign text, add column attribution jsonb;
alter table public.rewards_accounts add column channel text, add column source text, add column campaign text;
alter table public.customers add column first_channel text, add column first_source text;
create index orders_channel on public.orders (restaurant_id, channel);

-- 2. AI phone ordering (HighLevel Voice AI custom actions). The key itself is shown once; only its hash is kept.
alter table public.restaurants add column phone_enabled boolean not null default false, add column phone_key_hash text unique;
alter table public.orders alter column email drop not null;
create table public.phone_quotes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  items jsonb not null, pickup_at timestamptz not null, total_cents int not null, readback text not null,
  used_at timestamptz, created_at timestamptz not null default now()
);
alter table public.phone_quotes enable row level security; -- server only
grant all on public.phone_quotes to service_role;

-- 3. The restaurant's own delivery drivers: delivery areas by ZIP code with a fee each, and a driver list.
alter table public.restaurants
  add column own_delivery boolean not null default false,
  add column own_delivery_zips jsonb not null default '[]',   -- [{ "zip": "84032", "fee_cents": 400 }]
  add column drivers jsonb not null default '[]';            -- [{ "name": "Ana", "phone": "+14355550100" }]
alter table public.orders add column driver_name text, add column driver_phone text, add column driver_token text unique, add column out_at timestamptz;

-- Menu JSON carries the delivery-area list (needed to say "we deliver to these ZIP codes").
do $$ declare d text := pg_get_functiondef('public.get_menu(text)'::regprocedure); begin
  if position('''catering_days_ahead'', r.catering_days_ahead)' in d) = 0 then raise exception 'get_menu changed; update this migration'; end if;
  execute replace(d, '''catering_days_ahead'', r.catering_days_ahead)',
    '''catering_days_ahead'', r.catering_days_ahead, ''own_delivery'', r.own_delivery, ''own_delivery_zips'', r.own_delivery_zips, ''phone_enabled'', r.phone_enabled)');
end $$;

-- Settings form saves them (the phone key is set by the ordering function, not here).
do $$ declare d text := pg_get_functiondef('public.admin_save_settings(uuid,jsonb)'::regprocedure); begin
  if position('else report_email end' in d) = 0 then raise exception 'admin_save_settings changed; update this migration'; end if;
  execute replace(d, 'else report_email end',
    'else report_email end,
    phone_enabled = coalesce((p->>''phone_enabled'')::boolean, phone_enabled),
    own_delivery = coalesce((p->>''own_delivery'')::boolean, own_delivery),
    own_delivery_zips = case when jsonb_typeof(p->''own_delivery_zips'') = ''array'' then (
      select coalesce(jsonb_agg(jsonb_build_object(''zip'', z->>''zip'', ''fee_cents'', greatest(0, least(10000, (z->>''fee_cents'')::int)))), ''[]'')
      from jsonb_array_elements(p->''own_delivery_zips'') z where z->>''zip'' ~ ''^\d{5}$'') else own_delivery_zips end,
    drivers = case when jsonb_typeof(p->''drivers'') = ''array'' then (
      select coalesce(jsonb_agg(jsonb_build_object(''name'', left(trim(z->>''name''), 40), ''phone'', z->>''phone'')), ''[]'')
      from jsonb_array_elements(p->''drivers'') z where trim(coalesce(z->>''name'', '''')) <> '''' and z->>''phone'' ~ ''^\+1\d{10}$'') else drivers end');
end $$;

-- Dashboard: orders, sales and new guests by channel; bookings and sign-ups too.
create function public.admin_channels(p_restaurant uuid, p_days int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 730))); t boolean;
begin
  if not public.can(p_restaurant, 'dashboard') and not public.can(p_restaurant, 'marketing') then raise exception 'not allowed' using errcode = '42501'; end if;
  select test_mode into t from public.restaurants where id = p_restaurant;
  return jsonb_build_object(
    'orders', (select coalesce(jsonb_agg(x order by x.sales_cents desc), '[]') from (
      select coalesce(o.channel, 'unknown') channel, count(*) orders, sum(o.subtotal_cents - o.discount_cents) sales_cents,
        count(*) filter (where o.customer_id is not null and not exists (select 1 from public.orders p where p.customer_id = o.customer_id
          and p.status in ('new', 'accepted', 'ready', 'completed') and p.created_at < o.created_at)) first_orders
      from public.orders o where o.restaurant_id = p_restaurant and o.status in ('new', 'accepted', 'ready', 'completed')
        and o.test_mode = t and o.created_at >= since group by 1) x),
    'campaigns', (select coalesce(jsonb_agg(x order by x.sales_cents desc), '[]') from (
      select coalesce(o.channel, 'unknown') channel, coalesce(o.source, '') source, coalesce(o.campaign, '') campaign, count(*) orders, sum(o.subtotal_cents - o.discount_cents) sales_cents
      from public.orders o where o.restaurant_id = p_restaurant and o.status in ('new', 'accepted', 'ready', 'completed')
        and o.test_mode = t and o.created_at >= since and (o.source is not null or o.campaign is not null) group by 1, 2, 3 limit 50) x),
    'reservations', (select coalesce(jsonb_object_agg(channel, n), '{}') from (select coalesce(channel, 'unknown') channel, count(*) n
      from public.reservations where restaurant_id = p_restaurant and created_at >= since and status in ('requested', 'confirmed', 'seated', 'no_show') group by 1) x),
    'signups', (select coalesce(jsonb_object_agg(channel, n), '{}') from (
      select coalesce(channel, 'unknown') channel, count(*) n from (
        select channel from public.rewards_accounts where restaurant_id = p_restaurant and created_at >= since
        union all select channel from public.form_submissions where restaurant_id = p_restaurant and created_at >= since) s group by 1) x)
  );
end $$;
revoke all on function public.admin_channels(uuid, int) from public, anon;
grant execute on function public.admin_channels(uuid, int) to authenticated, service_role;

-- Weekly report: add orders and sales by channel.
do $$ declare d text := pg_get_functiondef('public.owner_report(uuid,timestamptz,timestamptz)'::regprocedure); begin
  if position('''new_rewards'', (select count(*)' in d) = 0 then raise exception 'owner_report changed; update this migration'; end if;
  execute replace(d, '''new_rewards'', (select count(*)',
    '''by_channel'', (select coalesce(jsonb_agg(jsonb_build_object(''channel'', k, ''orders'', n, ''sales_cents'', s) order by s desc), ''[]'') from (
        select coalesce(channel, ''unknown'') k, count(*) n, sum(subtotal_cents - discount_cents) s from o group by 1) t),
    ''new_rewards'', (select count(*)');
end $$;
