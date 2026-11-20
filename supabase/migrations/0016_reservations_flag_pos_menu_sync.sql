-- 1) Reservations can be turned off per restaurant (counter-service places like Tacos El Güero).
alter table public.restaurants add column reservations_enabled boolean not null default true;
update public.restaurants set reservations_enabled = false where slug = 'tacos-el-guero';

create function public.tg_reservations_enabled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not (select reservations_enabled from public.restaurants where id = new.restaurant_id) then
    raise exception 'This restaurant does not take reservations online.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger reservations_enabled before insert on public.reservations for each row execute function public.tg_reservations_enabled();
revoke all on function public.tg_reservations_enabled() from public, anon, authenticated;

-- my_access: tell the admin which features are on. Also gives platform admins the newer
-- customers / campaigns / website tabs (they were missing from the agency list).
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('id', r.id, 'slug', r.slug, 'name', r.name, 'timezone', r.timezone, 'agency', true, 'reservations', r.reservations_enabled,
      'perms', to_jsonb(array['kitchen','dashboard','orders','reservations','messages','customers','campaigns','rewards','gift','menu','choices','pairs','website','settings','marketing','team'])) x
      from public.restaurants r where public.is_platform_admin()
    union all
    select jsonb_build_object('id', r.id, 'slug', r.slug, 'name', r.name, 'timezone', r.timezone, 'agency', false, 'reservations', r.reservations_enabled, 'perms', to_jsonb(s.permissions))
      from public.staff s join public.restaurants r on r.id = s.restaurant_id
      where s.user_id = (select auth.uid()) and not public.is_platform_admin()
  ) t;
$$;

-- 2) POS menu sync: sold-out items and choices follow the POS.
-- Links between our dishes and the POS's items. Auto-matched by name; staff can fix a link.
create table public.pos_item_links (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  item_id uuid not null references public.menu_items(id) on delete cascade,
  pos_id text,                     -- null = staff said "not on the POS"; never auto-match again
  auto boolean not null default true,
  last_pos_available boolean,      -- what the POS said last time; we only act when it changes
  primary key (connection_id, item_id)
);
alter table public.pos_item_links enable row level security;
alter table public.pos_connections add column last_sync_at timestamptz, add column sync_summary jsonb, add column pos_catalog jsonb;
-- Choices (e.g. "Asada") follow the POS by name: last state seen for each name.
alter table public.pos_connections add column option_states jsonb not null default '{}';
grant all on public.pos_item_links to service_role;

create or replace function public.admin_pos(p_restaurant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(p_restaurant, 'settings') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'connections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'provider', c.provider, 'name', c.name, 'enabled', c.enabled, 'settings', c.settings,
        'has_token', c.secret_id is not null, 'print_key', case when c.provider = 'cloudprnt' then c.print_key end,
        'last_ok_at', c.last_ok_at, 'last_error', c.last_error, 'last_seen_at', c.last_seen_at,
        'last_sync_at', c.last_sync_at, 'sync_summary', c.sync_summary,
        'catalog', (select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'name', e ->> 'name') order by e ->> 'name'), '[]') from jsonb_array_elements(coalesce(c.pos_catalog, '[]')) e),
        'links', (select coalesce(jsonb_agg(jsonb_build_object('item_id', m.id, 'item', m.name, 'pos_id', l.pos_id, 'auto', l.auto, 'linked', l.connection_id is not null) order by m.name), '[]')
           from public.menu_items m left join public.pos_item_links l on l.item_id = m.id and l.connection_id = c.id where m.restaurant_id = p_restaurant)
        ) order by c.created_at)
      from public.pos_connections c where c.restaurant_id = p_restaurant), '[]'),
    'jobs', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select j.id, j.kind, j.status, j.attempts, j.error, j.external_id, j.created_at, j.sent_at, c.name connection, c.provider, o.order_no
        from public.pos_jobs j join public.pos_connections c on c.id = j.connection_id left join public.orders o on o.id = j.order_id
        where j.restaurant_id = p_restaurant order by j.created_at desc limit 40) x), '[]'));
end $$;

-- Staff fixes a link: pos_id = a POS item id, '' = not on the POS, null = go back to automatic.
create function public.admin_pos_link(p_restaurant uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare cid uuid := (p ->> 'connection_id')::uuid; iid uuid := (p ->> 'item_id')::uuid;
begin
  if not public.can(p_restaurant, 'settings') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.pos_connections where id = cid and restaurant_id = p_restaurant)
     or not exists (select 1 from public.menu_items where id = iid and restaurant_id = p_restaurant) then raise exception 'Not found.'; end if;
  if p ? 'pos_id' and p ->> 'pos_id' is null then
    delete from public.pos_item_links where connection_id = cid and item_id = iid;
  else
    insert into public.pos_item_links (connection_id, restaurant_id, item_id, pos_id, auto, last_pos_available)
      values (cid, p_restaurant, iid, nullif(p ->> 'pos_id', ''), false, null)
      on conflict (connection_id, item_id) do update set pos_id = excluded.pos_id, auto = false, last_pos_available = null;
  end if;
end $$;
revoke all on function public.admin_pos_link(uuid, jsonb) from public, anon;
grant execute on function public.admin_pos_link(uuid, jsonb) to authenticated;

-- Check the POS every 5 minutes (Clover only sends change notices to published Clover apps).
select cron.schedule('pos-sync', '*/5 * * * *', $job$
  select net.http_post(url := 'https://khvwoynoqnatcqgvoyar.supabase.co/functions/v1/pos?job=sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-key', (select decrypted_secret from vault.decrypted_secrets where name = 'ordering_job_key')),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
$job$);
