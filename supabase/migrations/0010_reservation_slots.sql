-- Reservation calendar: time slots with seat capacity, instant confirmation, blocked times and cancel links.
-- Capacity counts seats in use at once: a party holds its seats for res_dining_minutes from its start time.

alter table public.restaurants
  add column res_slot_minutes integer not null default 30 check (res_slot_minutes in (15, 30, 60)),
  add column res_capacity integer not null default 40 check (res_capacity between 1 and 2000),
  add column res_dining_minutes integer not null default 90 check (res_dining_minutes between 15 and 360),
  add column res_max_online integer not null default 8 check (res_max_online between 1 and 100),
  add column res_days_ahead integer not null default 60 check (res_days_ahead between 1 and 365),
  add column res_lead_minutes integer not null default 120 check (res_lead_minutes between 0 and 10080),
  add column res_last_seating_minutes integer not null default 60 check (res_last_seating_minutes between 0 and 600),
  add column res_auto_confirm boolean not null default true;

alter table public.reservations
  add column guests integer check (guests between 1 and 500),
  add column start_min integer check (start_min between 0 and 1439),
  add column token text unique default encode(extensions.gen_random_bytes(16), 'hex'),
  add column large_party boolean not null default false;
update public.reservations set guests = coalesce(substring(party_size from '^\d+')::int, 2) where guests is null;

create table public.res_blocks (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  block_date date not null,
  start_min integer check (start_min between 0 and 1439),
  end_min integer check (end_min between 1 and 1440),
  reason text,
  created_at timestamptz not null default now(),
  check ((start_min is null) = (end_min is null) and (start_min is null or end_min > start_min))
);
create index on public.res_blocks (restaurant_id, block_date);
alter table public.res_blocks enable row level security;
create policy res_blocks_staff on public.res_blocks for select to authenticated using (public.is_staff(restaurant_id));
grant select on public.res_blocks to authenticated;

create function public.res_label(m integer) returns text language sql immutable as $$
  select ((m / 60 + 11) % 12 + 1)::text || ':' || lpad((m % 60)::text, 2, '0') || case when m < 720 then ' AM' else ' PM' end;
$$;

-- Open start times for one day with seats left. Empty when the day is closed, blocked, past or too far ahead.
create function public.res_day(rid uuid, d date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.restaurants;
  local_now timestamp;
  win jsonb;
  slots jsonb := '[]'::jsonb;
  t integer; first_m integer; last_m integer; worst integer; u integer; load integer;
begin
  select * into r from public.restaurants where id = rid;
  if r.id is null then return slots; end if;
  local_now := now() at time zone r.timezone;
  if d < local_now::date or d > local_now::date + r.res_days_ahead then return slots; end if;
  if exists (select 1 from public.res_blocks b where b.restaurant_id = rid and b.block_date = d and b.start_min is null) then return slots; end if;
  for win in select * from jsonb_array_elements(coalesce(r.hours -> lower(to_char(d, 'Dy')), '[]'::jsonb)) loop
    first_m := split_part(win ->> 0, ':', 1)::int * 60 + split_part(win ->> 0, ':', 2)::int;
    last_m := split_part(win ->> 1, ':', 1)::int * 60 + split_part(win ->> 1, ':', 2)::int - r.res_last_seating_minutes;
    t := ((first_m + r.res_slot_minutes - 1) / r.res_slot_minutes) * r.res_slot_minutes;
    while t <= last_m loop
      if d + make_interval(mins => t) >= local_now + make_interval(mins => r.res_lead_minutes)
         and not exists (select 1 from public.res_blocks b where b.restaurant_id = rid and b.block_date = d and t >= b.start_min and t < b.end_min) then
        -- The busiest moment while this party would be seated decides how many seats are left.
        worst := 0; u := t;
        while u < t + r.res_dining_minutes loop
          select coalesce(sum(x.guests), 0) into load from public.reservations x
           where x.restaurant_id = rid and x.res_date = d and x.status in ('requested', 'confirmed')
             and x.start_min <= u and u < x.start_min + r.res_dining_minutes;
          worst := greatest(worst, load);
          u := u + r.res_slot_minutes;
        end loop;
        slots := slots || jsonb_build_object('min', t, 'label', public.res_label(t), 'left', greatest(r.res_capacity - worst, 0));
      end if;
      t := t + r.res_slot_minutes;
    end loop;
  end loop;
  return slots;
end $$;

-- Which days in a month have a time with room for this party size.
create function public.res_month(rid uuid, month_start date, p_guests integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_char(d, 'YYYY-MM-DD') order by d), '[]'::jsonb)
  from generate_series(date_trunc('month', month_start)::date, (date_trunc('month', month_start) + interval '1 month - 1 day')::date, interval '1 day') g(d)
  where exists (
    select 1 from jsonb_array_elements(public.res_day(rid, g.d::date)) s
    where (s ->> 'left')::int >= least(p_guests, (select res_max_online from public.restaurants where id = rid)));
$$;

-- Books a table. Locks the restaurant's day so two guests can't take the same last seats.
-- Parties above res_max_online become requests for staff to approve.
create function public.res_book(rid uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.restaurants;
  d date := (p ->> 'date')::date;
  m integer := (p ->> 'start_min')::int;
  g integer := (p ->> 'guests')::int;
  slot jsonb;
  large boolean;
  rec public.reservations;
begin
  select * into r from public.restaurants where id = rid;
  perform pg_advisory_xact_lock(hashtextextended(rid::text || d::text, 0));
  select s into slot from jsonb_array_elements(public.res_day(rid, d)) s where (s ->> 'min')::int = m;
  if slot is null then return jsonb_build_object('ok', false, 'error', 'That time is no longer available. Please pick another.'); end if;
  large := g > r.res_max_online;
  if not large and (slot ->> 'left')::int < g then
    return jsonb_build_object('ok', false, 'error', 'That time just filled up. Please pick another.');
  end if;
  insert into public.reservations (restaurant_id, name, email, phone, res_date, res_time, party_size, requests, guests, start_min, large_party, status)
  values (rid, p ->> 'name', p ->> 'email', p ->> 'phone', d, public.res_label(m), g::text, nullif(p ->> 'requests', ''), g, m, large,
          case when not large and r.res_auto_confirm then 'confirmed' else 'requested' end)
  returning * into rec;
  return jsonb_build_object('ok', true, 'id', rec.id, 'token', rec.token, 'status', rec.status, 'label', rec.res_time, 'large', large);
end $$;

-- Cancels from the guest's emailed link, up to the start time.
create function public.res_cancel(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare rec public.reservations; tz text;
begin
  select x.* into rec from public.reservations x where x.token = p_token;
  if rec.id is null then return jsonb_build_object('ok', false, 'error', 'Reservation not found.'); end if;
  select timezone into tz from public.restaurants where id = rec.restaurant_id;
  if rec.status not in ('requested', 'confirmed') then return jsonb_build_object('ok', false, 'error', 'This reservation is already ' || rec.status || '.'); end if;
  if rec.res_date + make_interval(mins => coalesce(rec.start_min, 0)) < now() at time zone tz then
    return jsonb_build_object('ok', false, 'error', 'This reservation has already started. Please call us.');
  end if;
  update public.reservations set status = 'cancelled', handled_by = 'Guest' where id = rec.id;
  return jsonb_build_object('ok', true, 'restaurant_id', rec.restaurant_id, 'name', rec.name, 'email', rec.email, 'date', rec.res_date, 'label', rec.res_time, 'guests', rec.guests);
end $$;

-- Managers change the booking rules and block times from the admin.
create function public.admin_res_settings(p_restaurant uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_manager(p_restaurant) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.restaurants set
    res_slot_minutes = coalesce((p ->> 'res_slot_minutes')::int, res_slot_minutes),
    res_capacity = coalesce((p ->> 'res_capacity')::int, res_capacity),
    res_dining_minutes = coalesce((p ->> 'res_dining_minutes')::int, res_dining_minutes),
    res_max_online = coalesce((p ->> 'res_max_online')::int, res_max_online),
    res_days_ahead = coalesce((p ->> 'res_days_ahead')::int, res_days_ahead),
    res_lead_minutes = coalesce((p ->> 'res_lead_minutes')::int, res_lead_minutes),
    res_last_seating_minutes = coalesce((p ->> 'res_last_seating_minutes')::int, res_last_seating_minutes),
    res_auto_confirm = coalesce((p ->> 'res_auto_confirm')::boolean, res_auto_confirm)
  where id = p_restaurant;
end $$;

create function public.admin_res_block(p_restaurant uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if not public.is_manager(p_restaurant) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p ? 'remove' then
    delete from public.res_blocks where id = (p ->> 'remove')::uuid and restaurant_id = p_restaurant;
    return null;
  end if;
  insert into public.res_blocks (restaurant_id, block_date, start_min, end_min, reason)
  values (p_restaurant, (p ->> 'date')::date, (p ->> 'start_min')::int, (p ->> 'end_min')::int, nullif(left(p ->> 'reason', 200), ''))
  returning id into new_id;
  return new_id;
end $$;

-- Staff day view: each time slot with seats booked.
create function public.staff_res_day(p_restaurant uuid, d date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff(p_restaurant) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'slots', public.res_day(p_restaurant, d),
    'blocks', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'start_min', b.start_min, 'end_min', b.end_min, 'reason', b.reason) order by b.start_min nulls first)
                         from public.res_blocks b where b.restaurant_id = p_restaurant and b.block_date = d), '[]'::jsonb));
end $$;

revoke all on function public.res_day(uuid, date), public.res_month(uuid, date, integer), public.res_book(uuid, jsonb), public.res_cancel(text) from public, anon, authenticated;
revoke all on function public.admin_res_settings(uuid, jsonb), public.admin_res_block(uuid, jsonb), public.staff_res_day(uuid, date) from public, anon;
grant execute on function public.admin_res_settings(uuid, jsonb), public.admin_res_block(uuid, jsonb), public.staff_res_day(uuid, date) to authenticated;
