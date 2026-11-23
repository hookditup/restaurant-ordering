-- Left-in-cart reminder: 15 minutes.
update public.automations set wait = 15 where kind = 'cart' and wait = 30;
do $$ declare d text := pg_get_functiondef('public.seed_automations(uuid)'::regprocedure); begin
  execute replace(d, '(rid, ''cart'', false, true, true, 30,', '(rid, ''cart'', false, true, true, 15,');
end $$;

-- Table QR ordering (dine-in), catering orders, and the owner's weekly report.
alter table public.restaurants
  add column dine_in_enabled boolean not null default false,
  add column table_count int not null default 0 check (table_count between 0 and 200),
  add column catering_enabled boolean not null default false,
  add column catering_min_cents int not null default 10000 check (catering_min_cents >= 0),
  add column catering_lead_hours int not null default 24 check (catering_lead_hours between 1 and 720),
  add column catering_days_ahead int not null default 30 check (catering_days_ahead between 1 and 120),
  add column report_enabled boolean not null default true,
  add column report_email text;

alter table public.orders drop constraint orders_fulfillment_check;
alter table public.orders add constraint orders_fulfillment_check check (fulfillment in ('pickup', 'delivery', 'dine_in'));
alter table public.orders add column table_label text, add column catering boolean not null default false;

-- Menu JSON carries the new switches.
do $$ declare d text := pg_get_functiondef('public.get_menu(text)'::regprocedure); begin
  if position('''doordash_store_url'', r.doordash_store_url)' in d) = 0 then raise exception 'get_menu changed; update this migration'; end if;
  execute replace(d, '''doordash_store_url'', r.doordash_store_url)',
    '''doordash_store_url'', r.doordash_store_url, ''dine_in_enabled'', r.dine_in_enabled, ''catering_enabled'', r.catering_enabled, '
    || '''catering_min_cents'', r.catering_min_cents, ''catering_lead_hours'', r.catering_lead_hours, ''catering_days_ahead'', r.catering_days_ahead)');
end $$;

-- Settings form saves them.
do $$ declare d text := pg_get_functiondef('public.admin_save_settings(uuid,jsonb)'::regprocedure); begin
  if position('popular_count = coalesce((p->>''popular_count'')::int, popular_count)' in d) = 0 then raise exception 'admin_save_settings changed; update this migration'; end if;
  execute replace(d, 'popular_count = coalesce((p->>''popular_count'')::int, popular_count)',
    'popular_count = coalesce((p->>''popular_count'')::int, popular_count),
    dine_in_enabled = coalesce((p->>''dine_in_enabled'')::boolean, dine_in_enabled),
    table_count = coalesce((p->>''table_count'')::int, table_count),
    catering_enabled = coalesce((p->>''catering_enabled'')::boolean, catering_enabled),
    catering_min_cents = coalesce((p->>''catering_min_cents'')::int, catering_min_cents),
    catering_lead_hours = coalesce((p->>''catering_lead_hours'')::int, catering_lead_hours),
    catering_days_ahead = coalesce((p->>''catering_days_ahead'')::int, catering_days_ahead),
    report_enabled = coalesce((p->>''report_enabled'')::boolean, report_enabled),
    report_email = case when p ? ''report_email'' then nullif(trim(p->>''report_email''), '''') else report_email end');
end $$;

-- The owner's report for a period: sales, guests, top dishes, and what marketing brought back.
create function public.owner_report(rid uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  with o as (
    select * from public.orders where restaurant_id = rid and status in ('new', 'accepted', 'ready', 'completed')
      and coalesce(paid_at, created_at) >= p_from and coalesce(paid_at, created_at) < p_to
  ), prev as (
    select coalesce(sum(subtotal_cents - discount_cents), 0) s, count(*) n from public.orders where restaurant_id = rid and status in ('new', 'accepted', 'ready', 'completed')
      and coalesce(paid_at, created_at) >= p_from - (p_to - p_from) and coalesce(paid_at, created_at) < p_from
  ), firsts as (
    select o.customer_id, not exists (select 1 from public.orders x where x.customer_id = o.customer_id and x.status in ('new', 'accepted', 'ready', 'completed')
      and coalesce(x.paid_at, x.created_at) < p_from) is_new
    from (select distinct customer_id from o where customer_id is not null) o
  ), mk as (
    -- An order counts for marketing when the guest got a marketing text or email in the 3 days before it.
    select distinct on (o.id) o.id, o.subtotal_cents - o.discount_cents s, m.kind from o join public.messages m on m.customer_id = o.customer_id
      and m.marketing and m.status = 'sent' and m.sent_at between coalesce(o.paid_at, o.created_at) - interval '3 days' and coalesce(o.paid_at, o.created_at)
    order by o.id, m.sent_at desc
  )
  select jsonb_build_object(
    'orders', (select count(*) from o),
    'sales_cents', (select coalesce(sum(subtotal_cents - discount_cents), 0) from o),
    'tips_cents', (select coalesce(sum(tip_cents), 0) from o),
    'avg_cents', (select coalesce(round(avg(subtotal_cents - discount_cents)), 0) from o),
    'prev_orders', (select n from prev), 'prev_sales_cents', (select s from prev),
    'by_type', (select coalesce(jsonb_object_agg(k, n), '{}') from (select case when catering then 'catering' else fulfillment end k, count(*) n from o group by 1) t),
    'new_guests', (select count(*) from firsts where is_new), 'returning_guests', (select count(*) from firsts where not is_new),
    'top_items', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'qty', q) order by q desc), '[]') from (
        select i.name, sum(i.qty) q from public.order_items i join o on o.id = i.order_id group by i.name order by 2 desc limit 5) t),
    'marketing_orders', (select count(*) from mk), 'marketing_sales_cents', (select coalesce(sum(s), 0) from mk),
    'marketing_by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}') from (select kind, count(*) n from mk group by kind) t),
    'messages_sent', (select count(*) from public.messages where restaurant_id = rid and status = 'sent' and sent_at >= p_from and sent_at < p_to),
    'reviews_asked', (select count(*) from public.messages where restaurant_id = rid and kind = 'review' and status = 'sent' and sent_at >= p_from and sent_at < p_to),
    'reservations', (select count(*) from public.reservations where restaurant_id = rid and status in ('confirmed', 'seated') and created_at >= p_from and created_at < p_to),
    'new_accounts', (select count(*) from public.customers where restaurant_id = rid and account_at >= p_from and account_at < p_to),
    'new_rewards', (select count(*) from public.rewards_accounts where restaurant_id = rid and created_at >= p_from and created_at < p_to)
  );
$$;
revoke all on function public.owner_report(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.owner_report(uuid, timestamptz, timestamptz) to service_role;

-- Monday 7:20 AM Mountain (14:20 UTC; 13:20 in summer is fine too): email last week's report.
select cron.schedule('owner-weekly-report', '20 14 * * 1', $job$
  select net.http_post(url := 'https://khvwoynoqnatcqgvoyar.supabase.co/functions/v1/ordering?job=weekly',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-key', (select decrypted_secret from vault.decrypted_secrets where name = 'ordering_job_key')),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
$job$);
