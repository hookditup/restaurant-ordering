-- POS connections: send paid online orders to the restaurant's POS or a cloud kitchen printer.
-- One row per connection; a restaurant can have several (e.g. Clover plus a bar printer).
-- The `pos` edge function does the sending; tokens live in Vault.
create table public.pos_connections (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  provider text not null check (provider in ('clover', 'square', 'cloudprnt')),
  name text not null default '',
  enabled boolean not null default true,
  settings jsonb not null default '{}',     -- clover: merchant_id, env, order_type_id; square: location_id, env; cloudprnt: width, copies
  secret_id uuid,                            -- API token in Vault (Clover, Square)
  print_key text unique default encode(extensions.gen_random_bytes(18), 'hex'),  -- CloudPRNT server URL key
  last_ok_at timestamptz, last_error text, last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.pos_connections enable row level security; -- server only; staff use the admin_* functions

create table public.pos_jobs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  order_id uuid references public.orders(id) on delete cascade,
  kind text not null default 'order' check (kind in ('order', 'test')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts int not null default 0, next_try_at timestamptz not null default now(),
  external_id text, error text,
  created_at timestamptz not null default now(), sent_at timestamptz
);
create unique index pos_jobs_once on public.pos_jobs (connection_id, order_id) where kind = 'order';
create index pos_jobs_due on public.pos_jobs (status, next_try_at) where status in ('pending', 'sending');
alter table public.pos_jobs enable row level security;

create function public.pos_secret(cid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from public.pos_connections c join vault.decrypted_secrets s on s.id = c.secret_id where c.id = cid;
$$;

-- A paid order goes to every enabled connection, then the pos function is poked to send it now.
create function public.tg_order_pos() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'new' and old.status is distinct from 'new' then
    insert into public.pos_jobs (restaurant_id, connection_id, order_id)
      select new.restaurant_id, c.id, new.id from public.pos_connections c where c.restaurant_id = new.restaurant_id and c.enabled
      on conflict do nothing;
    if found then
      perform net.http_post(url := 'https://khvwoynoqnatcqgvoyar.supabase.co/functions/v1/pos?job=send',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-key', (select decrypted_secret from vault.decrypted_secrets where name = 'ordering_job_key')),
        body := '{}'::jsonb, timeout_milliseconds := 30000);
    end if;
  end if;
  return null;
end $$;
create trigger orders_pos after update of status on public.orders for each row execute function public.tg_order_pos();

-- Admin (Settings permission).
create function public.admin_pos(p_restaurant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(p_restaurant, 'settings') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'connections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'provider', c.provider, 'name', c.name, 'enabled', c.enabled, 'settings', c.settings,
        'has_token', c.secret_id is not null, 'print_key', case when c.provider = 'cloudprnt' then c.print_key end,
        'last_ok_at', c.last_ok_at, 'last_error', c.last_error, 'last_seen_at', c.last_seen_at) order by c.created_at)
      from public.pos_connections c where c.restaurant_id = p_restaurant), '[]'),
    'jobs', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select j.id, j.kind, j.status, j.attempts, j.error, j.external_id, j.created_at, j.sent_at, c.name connection, c.provider, o.order_no
        from public.pos_jobs j join public.pos_connections c on c.id = j.connection_id left join public.orders o on o.id = j.order_id
        where j.restaurant_id = p_restaurant order by j.created_at desc limit 40) x), '[]'));
end $$;

create function public.admin_save_pos(p_restaurant uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cid uuid := nullif(p ->> 'id', '')::uuid; sid uuid; tok text := nullif(trim(p ->> 'token'), '');
begin
  if not public.can(p_restaurant, 'settings') then raise exception 'not allowed' using errcode = '42501'; end if;
  if cid is null then
    insert into public.pos_connections (restaurant_id, provider, name, enabled, settings)
      values (p_restaurant, p ->> 'provider', left(coalesce(p ->> 'name', ''), 60), coalesce((p ->> 'enabled')::boolean, true), coalesce(p -> 'settings', '{}'))
      returning id into cid;
  else
    update public.pos_connections set name = left(coalesce(p ->> 'name', name), 60), enabled = coalesce((p ->> 'enabled')::boolean, enabled), settings = coalesce(p -> 'settings', settings)
      where id = cid and restaurant_id = p_restaurant;
    if not found then raise exception 'Connection not found.'; end if;
  end if;
  if tok is not null then
    select secret_id into sid from public.pos_connections where id = cid;
    if sid is null then
      update public.pos_connections set secret_id = vault.create_secret(tok, 'pos_token_' || cid::text) where id = cid;
    else
      perform vault.update_secret(sid, tok);
    end if;
  end if;
  return cid;
end $$;

create function public.admin_pos_job(p_restaurant uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can(p_restaurant, 'settings') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p ->> 'move' = 'retry' then
    update public.pos_jobs set status = 'pending', next_try_at = now(), error = null where id = (p ->> 'id')::uuid and restaurant_id = p_restaurant and status in ('failed', 'cancelled', 'sending');
  elsif p ->> 'move' = 'cancel' then
    update public.pos_jobs set status = 'cancelled' where id = (p ->> 'id')::uuid and restaurant_id = p_restaurant and status in ('pending', 'failed', 'sending');
  elsif p ->> 'move' = 'test' then
    insert into public.pos_jobs (restaurant_id, connection_id, kind) select p_restaurant, id, 'test' from public.pos_connections where id = (p ->> 'connection_id')::uuid and restaurant_id = p_restaurant;
  end if;
end $$;

revoke all on function public.pos_secret(uuid), public.tg_order_pos() from public, anon, authenticated;
grant execute on function public.pos_secret(uuid) to service_role;
revoke all on function public.admin_pos(uuid), public.admin_save_pos(uuid, jsonb), public.admin_pos_job(uuid, jsonb) from public, anon;
grant execute on function public.admin_pos(uuid), public.admin_save_pos(uuid, jsonb), public.admin_pos_job(uuid, jsonb) to authenticated;
grant all on public.pos_connections, public.pos_jobs to service_role;

-- Retries and anything the instant poke missed.
select cron.schedule('pos-send', '* * * * *', $job$
  select net.http_post(url := 'https://khvwoynoqnatcqgvoyar.supabase.co/functions/v1/pos?job=send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-key', (select decrypted_secret from vault.decrypted_secrets where name = 'ordering_job_key')),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
$job$);
