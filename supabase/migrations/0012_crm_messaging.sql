-- Customer database, consent, texting/email automations, campaigns, promo codes,
-- site notices, special hours, partial refunds, reservation no-shows.

-- ---------- customers ----------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  phone text, email text, first_name text, last_name text,
  birth_month int check (birth_month between 1 and 12),
  birth_day int check (birth_day between 1 and 31),
  notes text, tags text[] not null default '{}',
  sms_updates boolean not null default false,          -- order and reservation texts
  sms_marketing boolean not null default false,        -- deals and reminders by text (explicit opt-in)
  sms_marketing_at timestamptz, sms_stopped_at timestamptz,
  email_marketing boolean not null default true,       -- every email carries an unsubscribe link
  email_unsub_at timestamptz,
  source text,
  unsub_token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  order_count int not null default 0, spent_cents bigint not null default 0,
  first_order_at timestamptz, last_order_at timestamptz,
  reservation_count int not null default 0, no_shows int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index customers_phone_key on public.customers (restaurant_id, phone) where phone is not null;
create unique index customers_email_only_key on public.customers (restaurant_id, email) where phone is null and email is not null;
create index customers_email_idx on public.customers (restaurant_id, email);
create index customers_last_order_idx on public.customers (restaurant_id, last_order_at);
alter table public.customers enable row level security;
create policy customers_staff_read on public.customers for select to authenticated using (public.can(restaurant_id, 'customers'));

alter table public.orders add column customer_id uuid references public.customers(id) on delete set null;
alter table public.reservations add column customer_id uuid references public.customers(id) on delete set null;
alter table public.rewards_accounts add column customer_id uuid references public.customers(id) on delete set null;
create index orders_customer_idx on public.orders (customer_id);
create index reservations_customer_idx on public.reservations (customer_id);

-- Find or create the customer for a phone/email. Never removes consent; only adds it,
-- except email_marketing=false, which is an explicit choice to stop marketing email.
create function public.upsert_customer(rid uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ph text := nullif(trim(p ->> 'phone'), '');
  em text := lower(nullif(trim(p ->> 'email'), ''));
  cid uuid; other_phone text;
begin
  if ph is null and em is null then return null; end if;
  if ph is not null then select id into cid from public.customers where restaurant_id = rid and phone = ph; end if;
  if cid is null and em is not null then
    select id, phone into cid, other_phone from public.customers where restaurant_id = rid and email = em
      order by (phone is null) desc, created_at limit 1;
    if cid is not null and ph is not null and other_phone is not null and other_phone <> ph then cid := null; end if;
  end if;
  if cid is null then
    insert into public.customers (restaurant_id, phone, email, first_name, last_name, source, birth_month, birth_day)
      values (rid, ph, em,
        nullif(trim(p ->> 'first_name'), ''), nullif(trim(p ->> 'last_name'), ''), coalesce(p ->> 'source', 'website'),
        (p ->> 'birth_month')::int, (p ->> 'birth_day')::int)
      on conflict do nothing returning id into cid;
    if cid is null then -- created by a parallel request
      select id into cid from public.customers where restaurant_id = rid and (phone = ph or (ph is null and email = em)) limit 1;
    end if;
  else
    update public.customers c set
      phone = coalesce(c.phone, ph),
      email = coalesce(c.email, em),
      first_name = coalesce(nullif(trim(p ->> 'first_name'), ''), c.first_name),
      last_name = coalesce(nullif(trim(p ->> 'last_name'), ''), c.last_name),
      birth_month = coalesce((p ->> 'birth_month')::int, c.birth_month),
      birth_day = coalesce((p ->> 'birth_day')::int, c.birth_day),
      updated_at = now()
    where c.id = cid;
  end if;
  update public.customers c set
    sms_updates = c.sms_updates or coalesce((p ->> 'sms_updates')::boolean, false),
    sms_marketing = c.sms_marketing or coalesce((p ->> 'sms_marketing')::boolean, false),
    sms_marketing_at = case when coalesce((p ->> 'sms_marketing')::boolean, false) and not c.sms_marketing then now() else c.sms_marketing_at end,
    sms_stopped_at = case when coalesce((p ->> 'sms_marketing')::boolean, false) or coalesce((p ->> 'sms_updates')::boolean, false) then null else c.sms_stopped_at end,
    email_marketing = case when p ? 'email_marketing' and not (p ->> 'email_marketing')::boolean then false
                           when (p ->> 'email_marketing')::boolean and c.email_unsub_at is null then true else c.email_marketing end,
    email_unsub_at = case when p ? 'email_marketing' and not (p ->> 'email_marketing')::boolean then coalesce(c.email_unsub_at, now()) else c.email_unsub_at end
  where c.id = cid;
  return cid;
end $$;

create function public.refresh_customer(cid uuid) returns void
language sql security definer set search_path = '' as $$
  update public.customers c set
    order_count = s.n, spent_cents = s.spent, first_order_at = s.first_at, last_order_at = s.last_at,
    reservation_count = v.n, no_shows = v.ns
  from (select count(*) n, coalesce(sum(total_cents - tip_cents), 0) spent, min(created_at) first_at, max(created_at) last_at
          from public.orders where customer_id = cid and status in ('new', 'accepted', 'ready', 'completed')) s,
       (select count(*) filter (where status in ('confirmed', 'seated')) n, count(*) filter (where status = 'no_show') ns
          from public.reservations where customer_id = cid) v
  where c.id = cid;
$$;

create function public.tg_order_customer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.customer_id is null then
    new.customer_id := public.upsert_customer(new.restaurant_id, jsonb_build_object('phone', new.phone, 'email', new.email,
      'first_name', new.first_name, 'last_name', new.last_name, 'source', 'online order'));
  end if;
  return new;
end $$;
create function public.tg_reservation_customer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.customer_id is null then
    new.customer_id := public.upsert_customer(new.restaurant_id, jsonb_build_object('phone', new.phone, 'email', new.email,
      'first_name', split_part(new.name, ' ', 1), 'last_name', nullif(regexp_replace(new.name, '^\S+\s*', ''), ''), 'source', 'reservation'));
  end if;
  return new;
end $$;
create function public.tg_rewards_customer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id is null then
    new.customer_id := public.upsert_customer(new.restaurant_id, jsonb_build_object('phone', new.phone, 'email', new.email,
      'first_name', split_part(new.name, ' ', 1), 'last_name', nullif(regexp_replace(new.name, '^\S+\s*', ''), ''),
      'sms_marketing', new.sms_consent, 'source', 'rewards'));
  elsif new.sms_consent and not coalesce(old.sms_consent, false) then
    perform public.upsert_customer(new.restaurant_id, jsonb_build_object('phone', new.phone, 'sms_marketing', true));
  end if;
  return new;
end $$;
create function public.tg_refresh_customer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id is not null then perform public.refresh_customer(new.customer_id); end if;
  return null;
end $$;
create trigger orders_customer before insert on public.orders for each row execute function public.tg_order_customer();
create trigger orders_customer_stats after insert or update of status on public.orders for each row execute function public.tg_refresh_customer();
create trigger reservations_customer before insert on public.reservations for each row execute function public.tg_reservation_customer();
create trigger reservations_customer_stats after insert or update of status on public.reservations for each row execute function public.tg_refresh_customer();
create trigger rewards_customer before insert or update of sms_consent on public.rewards_accounts for each row execute function public.tg_rewards_customer();

-- Reservations: seated and no-show.
alter table public.reservations add column sms_updates boolean not null default false, add column reminded_at timestamptz;


-- ---------- messaging ----------
create table public.messaging_settings (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  twilio_sid text, sms_from text,           -- a +1 number or a Messaging Service SID (MG...)
  twilio_secret_id uuid,                    -- auth token, kept in Vault
  email_from text, email_reply_to text,
  review_url text,
  quiet_start_min int not null default 540, quiet_end_min int not null default 1200,  -- texts only 9am-8pm local
  updated_at timestamptz not null default now()
);
alter table public.messaging_settings enable row level security; -- server only

create table public.automations (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  kind text not null check (kind in ('order_ready', 'reservation_reminder', 'welcome', 'winback', 'birthday', 'review', 'points')),
  enabled boolean not null default false,
  sms boolean not null default true, email boolean not null default true,
  wait int not null,                        -- hours or days, depending on kind (see admin)
  subject text not null default '', body text not null, sms_body text not null default '',
  promo_code text,
  updated_at timestamptz not null default now(),
  primary key (restaurant_id, kind)
);
alter table public.automations enable row level security;
create policy automations_staff_read on public.automations for select to authenticated using (public.can(restaurant_id, 'campaigns'));

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null, channel text not null check (channel in ('sms', 'email', 'both')),
  subject text not null default '', body text not null, sms_body text not null default '',
  segment jsonb not null default '{"kind":"all"}',
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  send_at timestamptz, queued int not null default 0,
  created_by text, created_at timestamptz not null default now(), sent_at timestamptz
);
alter table public.campaigns enable row level security;
create policy campaigns_staff_read on public.campaigns for select to authenticated using (public.can(restaurant_id, 'campaigns'));

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  channel text not null check (channel in ('sms', 'email')),
  kind text not null,                       -- automation kind, 'campaign', or 'staff'
  campaign_id uuid references public.campaigns(id) on delete set null,
  to_addr text not null, subject text, body text not null,
  marketing boolean not null default true,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  error text, provider_id text, dedupe text,
  send_after timestamptz not null default now(), created_at timestamptz not null default now(), sent_at timestamptz,
  unique (restaurant_id, dedupe)
);
create index messages_queue_idx on public.messages (status, send_after) where status = 'queued';
create index messages_customer_idx on public.messages (customer_id, created_at desc);
alter table public.messages enable row level security;
create policy messages_staff_read on public.messages for select to authenticated
  using (public.can(restaurant_id, 'campaigns') or public.can(restaurant_id, 'customers'));

-- Default automations. Order and reservation texts are on; marketing waits for the owner.
create function public.seed_automations(rid uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.automations (restaurant_id, kind, enabled, sms, email, wait, subject, body, sms_body) values
  (rid, 'order_ready', true, true, false, 0, '', 'Your order is ready.', '{restaurant}: Hi {first_name}, order {order_no} is ready for pickup!'),
  (rid, 'reservation_reminder', true, true, true, 3, 'See you soon at {restaurant}',
    'Hi {first_name}, this is a reminder of your reservation today at {time} for {guests}. Need to cancel? {cancel_link}',
    '{restaurant}: Reminder, your table for {guests} is today at {time}. Need to cancel? {cancel_link}'),
  (rid, 'welcome', false, true, true, 0, 'Welcome to {restaurant} Rewards',
    'Thanks for joining, {first_name}! You earn points on every online order. Your rewards code is {code}.',
    '{restaurant}: Welcome to Rewards, {first_name}! Your code is {code}. Order: {link}'),
  (rid, 'winback', false, true, true, 45, 'We miss you at {restaurant}',
    E'Hi {first_name}, it''s been a while! Come back and see us this week.{promo_line}\n\nOrder online: {link}',
    '{restaurant}: We miss you, {first_name}!{promo_line} Order: {link}'),
  (rid, 'birthday', false, true, true, 3, 'Happy birthday from {restaurant}!',
    E'Happy birthday, {first_name}! Celebrate with us this week.{promo_line}\n\n{link}',
    '{restaurant}: Happy birthday, {first_name}!{promo_line} {link}'),
  (rid, 'review', false, false, true, 2, 'How was your {restaurant} order?',
    'Thanks for ordering, {first_name}! If you enjoyed it, a quick review helps our family business a lot: {review_link}',
    '{restaurant}: Thanks for your order, {first_name}! Mind leaving a quick review? {review_link}'),
  (rid, 'points', false, true, true, 21, 'You have a reward waiting at {restaurant}',
    'Hi {first_name}, you have {points} points, enough for a reward on your next order. Use code {code} at checkout: {link}',
    '{restaurant}: You have {points} points, enough for a reward! Use code {code}: {link}')
  on conflict do nothing;
$$;
select public.seed_automations(id) from public.restaurants;

-- Merge fields for one customer.
create function public.render_msg(t text, r public.restaurants, c public.customers, extra jsonb default '{}') returns text
language plpgsql stable set search_path = '' as $$
declare k text; v text; out text := coalesce(t, '');
begin
  out := replace(out, '{first_name}', coalesce(nullif(c.first_name, ''), 'friend'));
  out := replace(out, '{restaurant}', r.name);
  out := replace(out, '{link}', r.site_url || '/menu');
  out := replace(out, '{phone}', coalesce(r.phone, ''));
  for k, v in select * from jsonb_each_text(extra) loop out := replace(out, '{' || k || '}', coalesce(v, '')); end loop;
  return regexp_replace(out, '\{[a-z_]+\}', '', 'g');
end $$;

-- Who a segment reaches. Consent is applied later, per channel.
create function public.segment_customers(rid uuid, seg jsonb) returns setof public.customers
language sql stable security definer set search_path = '' as $$
  select c.* from public.customers c
  where c.restaurant_id = rid and case coalesce(seg ->> 'kind', 'all')
    when 'all' then true
    when 'lapsed' then c.last_order_at < now() - make_interval(days => coalesce((seg ->> 'days')::int, 45))
    when 'recent' then c.last_order_at >= now() - make_interval(days => coalesce((seg ->> 'days')::int, 30))
    when 'regulars' then c.order_count >= coalesce((seg ->> 'min_orders')::int, 3)
    when 'never_ordered' then c.order_count = 0
    when 'rewards' then exists (select 1 from public.rewards_accounts a where a.customer_id = c.id)
    when 'birthday_month' then c.birth_month = coalesce((seg ->> 'month')::int, extract(month from now())::int)
    when 'tag' then (seg ->> 'tag') = any (c.tags)
    else false end;
$$;

-- Put a campaign's messages in the send queue.
create function public.campaign_queue(cid uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare cp public.campaigns; r public.restaurants; n int := 0; k int;
begin
  update public.campaigns set status = 'sending' where id = cid and status = 'scheduled' and coalesce(send_at, now()) <= now() returning * into cp;
  if cp.id is null then return 0; end if;
  select * into r from public.restaurants where id = cp.restaurant_id;
  if cp.channel in ('sms', 'both') then
    insert into public.messages (restaurant_id, customer_id, channel, kind, campaign_id, to_addr, body, dedupe)
      select r.id, c.id, 'sms', 'campaign', cp.id, c.phone, public.render_msg(cp.sms_body, r, c), 'c:' || cp.id || ':s:' || c.id
      from public.segment_customers(r.id, cp.segment) c where c.sms_marketing and c.phone is not null
      on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end if;
  if cp.channel in ('email', 'both') then
    insert into public.messages (restaurant_id, customer_id, channel, kind, campaign_id, to_addr, subject, body, dedupe)
      select r.id, c.id, 'email', 'campaign', cp.id, c.email, public.render_msg(cp.subject, r, c), public.render_msg(cp.body, r, c), 'c:' || cp.id || ':e:' || c.id
      from public.segment_customers(r.id, cp.segment) c where c.email_marketing and c.email is not null
      on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end if;
  update public.campaigns set status = 'sent', queued = n, sent_at = now() where id = cp.id;
  return n;
end $$;

-- Queue automation messages that are due. Each customer gets each message at most once per window.
create function public.automations_tick(rid uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare r public.restaurants; a public.automations; n int := 0; k int; promo text; ms public.messaging_settings; today date;
begin
  select * into r from public.restaurants where id = rid and active;
  if r.id is null then return 0; end if;
  select * into ms from public.messaging_settings where restaurant_id = rid;
  today := (now() at time zone r.timezone)::date;
  create temp table if not exists _due (cid uuid, extra jsonb, dk text, mk boolean) on commit drop;
  for a in select * from public.automations where restaurant_id = rid and enabled and kind in ('winback', 'birthday', 'review', 'points', 'reservation_reminder') loop
    promo := case when a.promo_code is not null and a.promo_code <> '' then ' Use code ' || a.promo_code || ' for a treat.' else '' end;
    if a.kind = 'winback' then
      -- Only guests who just crossed the line, so turning this on never blasts the whole list.
      truncate _due;
      insert into _due select c.id, jsonb_build_object('promo_line', promo), 'w:' || c.id || ':' || to_char(today, 'YYYY-MM'), true
        from public.customers c where c.restaurant_id = rid
          and c.last_order_at between now() - make_interval(days => a.wait + 7) and now() - make_interval(days => a.wait)
          and not exists (select 1 from public.messages m where m.customer_id = c.id and m.kind = 'winback' and m.created_at > now() - interval '60 days');
    elsif a.kind = 'birthday' then
      truncate _due;
      insert into _due select c.id, jsonb_build_object('promo_line', promo), 'b:' || c.id || ':' || extract(year from today), true
        from public.customers c where c.restaurant_id = rid and c.birth_month is not null and c.birth_day is not null
          and c.birth_month = extract(month from today + a.wait)::int and c.birth_day = extract(day from today + a.wait)::int;
    elsif a.kind = 'review' then
      truncate _due;
      insert into _due select distinct on (o.customer_id) o.customer_id, jsonb_build_object('review_link', coalesce(nullif(ms.review_url, ''), r.site_url || '/review')), 'r:' || o.id, true
        from public.orders o where o.restaurant_id = rid and o.customer_id is not null and o.status = 'completed'
          and o.completed_at between now() - make_interval(hours => a.wait + 24) and now() - make_interval(hours => a.wait)
          and not exists (select 1 from public.messages m where m.customer_id = o.customer_id and m.kind = 'review' and m.created_at > now() - interval '30 days')
        order by o.customer_id, o.completed_at desc;
    elsif a.kind = 'points' then
      truncate _due;
      insert into _due select c.id, jsonb_build_object('points', ra.points::text, 'code', ra.code), 'p:' || c.id || ':' || to_char(today, 'YYYY-MM'), true
        from public.customers c join public.rewards_accounts ra on ra.customer_id = c.id
        where c.restaurant_id = rid and ra.points >= r.rewards_redeem_points
          and coalesce(c.last_order_at, c.created_at) < now() - make_interval(days => a.wait)
          and not exists (select 1 from public.messages m where m.customer_id = c.id and m.kind = 'points' and m.created_at > now() - interval '30 days');
    else -- reservation_reminder: confirmed tables starting within the next a.wait hours, today
      truncate _due;
      insert into _due select v.customer_id, jsonb_build_object('time', v.res_time, 'guests', v.guests::text || case when v.guests = 1 then ' guest' else ' guests' end,
          'cancel_link', r.site_url || '/reservations/?cancel=' || v.token, 'sms_ok', v.sms_updates::text), 'rr:' || v.id, false
        from public.reservations v where v.restaurant_id = rid and v.status = 'confirmed' and v.res_date = today and v.customer_id is not null
          and v.start_min is not null
          and (v.start_min - (extract(hour from now() at time zone r.timezone) * 60 + extract(minute from now() at time zone r.timezone))) between 30 and a.wait * 60;
    end if;
    if a.sms then
      insert into public.messages (restaurant_id, customer_id, channel, kind, to_addr, body, marketing, dedupe)
        select rid, c.id, 'sms', a.kind, c.phone, public.render_msg(a.sms_body, r, c, d.extra), d.mk, d.dk || ':s'
        from _due d join public.customers c on c.id = d.cid
        where c.phone is not null and c.sms_stopped_at is null
          and case when d.mk then c.sms_marketing else (c.sms_updates or coalesce((d.extra ->> 'sms_ok')::boolean, false)) end
        on conflict do nothing;
      get diagnostics k = row_count; n := n + k;
    end if;
    if a.email then
      insert into public.messages (restaurant_id, customer_id, channel, kind, to_addr, subject, body, marketing, dedupe)
        select rid, c.id, 'email', a.kind, c.email, public.render_msg(a.subject, r, c, d.extra), public.render_msg(a.body, r, c, d.extra), d.mk, d.dk || ':e'
        from _due d join public.customers c on c.id = d.cid
        where c.email is not null and (not d.mk or c.email_marketing)
        on conflict do nothing;
      get diagnostics k = row_count; n := n + k;
    end if;
    if a.kind = 'reservation_reminder' then
      update public.reservations v set reminded_at = now() from _due d where 'rr:' || v.id = d.dk and v.reminded_at is null;
    end if;
  end loop;
  -- Scheduled campaigns that are due.
  perform public.campaign_queue(id) from public.campaigns where restaurant_id = rid and status = 'scheduled' and send_at <= now();
  return n;
end $$;

-- Twilio auth token in Vault; only the server reads it.
create function public.messaging_secret(rid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from public.messaging_settings m join vault.decrypted_secrets s on s.id = m.twilio_secret_id where m.restaurant_id = rid;
$$;
create function public.set_messaging_secret(rid uuid, token text) returns void
language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  insert into public.messaging_settings (restaurant_id) values (rid) on conflict do nothing;
  select twilio_secret_id into sid from public.messaging_settings where restaurant_id = rid;
  if sid is null then
    sid := vault.create_secret(token, 'twilio_token_' || rid::text);
    update public.messaging_settings set twilio_secret_id = sid, updated_at = now() where restaurant_id = rid;
  else
    perform vault.update_secret(sid, token);
  end if;
end $$;

-- ---------- promo codes ----------
create table public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  code text not null, kind text not null check (kind in ('percent', 'amount')),
  value int not null check (value > 0),            -- percent (1-100) or cents
  min_subtotal_cents int not null default 0,
  max_uses int, once_per_guest boolean not null default true,
  starts_at timestamptz, ends_at timestamptz,
  active boolean not null default true, note text,
  created_at timestamptz not null default now(),
  unique (restaurant_id, code)
);
alter table public.promo_codes enable row level security;
create policy promo_staff_read on public.promo_codes for select to authenticated using (public.can(restaurant_id, 'campaigns'));
alter table public.orders add column promo_code_id uuid references public.promo_codes(id), add column promo_cents int not null default 0;

-- ---------- website notices, specials and special hours ----------
create table public.site_notices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  kind text not null check (kind in ('banner', 'special')),
  title text not null, body text not null default '', link_text text, link_url text,
  starts_on date, ends_on date, active boolean not null default true, sort int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.site_notices enable row level security;
create policy notices_public_read on public.site_notices for select to anon, authenticated using (active);

create table public.hours_exceptions (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  day date not null, closed boolean not null default true,
  ranges jsonb not null default '[]',     -- [["11:00","15:00"]] when open special hours
  note text,
  primary key (restaurant_id, day)
);
alter table public.hours_exceptions enable row level security;
create policy hours_ex_public_read on public.hours_exceptions for select to anon, authenticated using (true);

-- ---------- refunds and per-item exports ----------
alter table public.orders add column refunded_cents int not null default 0, add column sms_updates boolean not null default false;
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  cents int not null check (cents > 0), reason text, by_name text, stripe_refund_id text,
  created_at timestamptz not null default now()
);
alter table public.refunds enable row level security;
alter table public.order_items add column option_ids uuid[];

-- ---------- staff functions ----------

create function public.admin_customers(p_restaurant uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(nullif(trim(p ->> 'q'), '')); lim int := least(coalesce((p ->> 'limit')::int, 50), 5000); off int := coalesce((p ->> 'offset')::int, 0);
  sort text := coalesce(p ->> 'sort', 'last_order'); rows jsonb; total int;
begin
  if not public.can(p_restaurant, 'customers') then raise exception 'not allowed' using errcode = '42501'; end if;
  with base as (
    select c.*, ra.points, ra.code from public.segment_customers(p_restaurant, coalesce(p -> 'segment', '{"kind":"all"}')) c
      left join public.rewards_accounts ra on ra.customer_id = c.id
    where q is null or lower(concat_ws(' ', c.first_name, c.last_name, c.email, c.phone)) like '%' || q || '%'
      or regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || regexp_replace(q, '\D', '', 'g') || '%' and length(regexp_replace(q, '\D', '', 'g')) >= 4
  )
  select (select count(*) from base), coalesce(jsonb_agg(to_jsonb(b) - 'unsub_token' order by
      case when sort = 'spent' then -b.spent_cents end, case when sort = 'orders' then -b.order_count end,
      case when sort = 'name' then lower(coalesce(b.first_name, '') || ' ' || coalesce(b.last_name, '')) end,
      case when sort = 'new' then b.created_at end desc,
      b.last_order_at desc nulls last, b.created_at desc), '[]')
    into total, rows from (select * from base order by
      case when sort = 'spent' then -spent_cents end, case when sort = 'orders' then -order_count end,
      case when sort = 'name' then lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) end,
      case when sort = 'new' then created_at end desc,
      last_order_at desc nulls last, created_at desc limit lim offset off) b;
  return jsonb_build_object('total', total, 'rows', rows);
end $$;

create function public.admin_customer(p_restaurant uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare out jsonb;
begin
  if not public.can(p_restaurant, 'customers') then raise exception 'not allowed' using errcode = '42501'; end if;
  select jsonb_build_object(
    'customer', to_jsonb(c) - 'unsub_token',
    'rewards', (select jsonb_build_object('points', points, 'code', code) from public.rewards_accounts where customer_id = c.id limit 1),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('order_no', o.order_no, 'created_at', o.created_at, 'status', o.status, 'total_cents', o.total_cents, 'fulfillment', o.fulfillment,
        'items', (select string_agg(i.qty || '× ' || i.name, ', ') from public.order_items i where i.order_id = o.id)) order by o.created_at desc)
      from (select * from public.orders where customer_id = c.id order by created_at desc limit 25) o), '[]'),
    'reservations', coalesce((select jsonb_agg(jsonb_build_object('res_date', v.res_date, 'res_time', v.res_time, 'guests', coalesce(v.guests::text, v.party_size), 'status', v.status) order by v.res_date desc)
      from (select * from public.reservations where customer_id = c.id order by res_date desc limit 25) v), '[]'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('channel', m.channel, 'kind', m.kind, 'status', m.status, 'created_at', m.created_at, 'subject', m.subject, 'body', left(m.body, 300), 'error', m.error) order by m.created_at desc)
      from (select * from public.messages where customer_id = c.id order by created_at desc limit 25) m), '[]'))
  into out from public.customers c where c.id = p_id and c.restaurant_id = p_restaurant;
  return out;
end $$;

create function public.admin_save_customer(p_restaurant uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cid uuid := nullif(p ->> 'id', '')::uuid;
begin
  if not public.can(p_restaurant, 'customers') then raise exception 'not allowed' using errcode = '42501'; end if;
  if cid is null then
    cid := public.upsert_customer(p_restaurant, (p - 'id') || jsonb_build_object('source', 'added by staff'));
    if cid is null then raise exception 'Enter a phone number or email.'; end if;
  end if;
  update public.customers c set
    first_name = coalesce(nullif(trim(p ->> 'first_name'), ''), c.first_name),
    last_name = case when p ? 'last_name' then nullif(trim(p ->> 'last_name'), '') else c.last_name end,
    email = case when p ? 'email' then lower(nullif(trim(p ->> 'email'), '')) else c.email end,
    birth_month = case when p ? 'birth_month' then nullif(p ->> 'birth_month', '')::int else c.birth_month end,
    birth_day = case when p ? 'birth_day' then nullif(p ->> 'birth_day', '')::int else c.birth_day end,
    notes = case when p ? 'notes' then left(p ->> 'notes', 2000) else c.notes end,
    tags = case when p ? 'tags' then array(select distinct left(trim(t), 30) from jsonb_array_elements_text(p -> 'tags') t where trim(t) <> '') else c.tags end,
    -- Staff can turn marketing off at a guest's request; turning texts on needs the guest's own opt-in.
    sms_marketing = case when (p ->> 'sms_marketing') = 'false' then false when (p ->> 'sms_marketing') = 'true' and (p ->> 'consent_confirmed') = 'true' then true else c.sms_marketing end,
    sms_marketing_at = case when (p ->> 'sms_marketing') = 'true' and (p ->> 'consent_confirmed') = 'true' and not c.sms_marketing then now() else c.sms_marketing_at end,
    sms_stopped_at = case when (p ->> 'sms_marketing') = 'true' and (p ->> 'consent_confirmed') = 'true' then null else c.sms_stopped_at end,
    email_marketing = case when (p ->> 'email_marketing') = 'false' then false when (p ->> 'email_marketing') = 'true' then true else c.email_marketing end,
    email_unsub_at = case when (p ->> 'email_marketing') = 'false' then coalesce(c.email_unsub_at, now()) when (p ->> 'email_marketing') = 'true' then null else c.email_unsub_at end,
    updated_at = now()
  where c.id = cid and c.restaurant_id = p_restaurant;
  return cid;
end $$;

create function public.admin_marketing(p_restaurant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(p_restaurant, 'campaigns') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'automations', coalesce((select jsonb_agg(to_jsonb(a) order by array_position(array['order_ready', 'reservation_reminder', 'welcome', 'winback', 'birthday', 'review', 'points'], a.kind)) from public.automations a where a.restaurant_id = p_restaurant), '[]'),
    'campaigns', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc) from (select * from public.campaigns where restaurant_id = p_restaurant order by created_at desc limit 50) c), '[]'),
    'promos', coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object('uses', (select count(*) from public.orders o where o.promo_code_id = x.id and o.status in ('new', 'accepted', 'ready', 'completed'))) order by x.created_at desc) from public.promo_codes x where x.restaurant_id = p_restaurant), '[]'),
    'audience', (select jsonb_build_object('customers', count(*), 'email', count(*) filter (where email_marketing and email is not null), 'sms', count(*) filter (where sms_marketing and phone is not null)) from public.customers where restaurant_id = p_restaurant),
    'sent30', (select jsonb_build_object('sms', count(*) filter (where channel = 'sms' and status = 'sent'), 'email', count(*) filter (where channel = 'email' and status = 'sent'),
        'failed', count(*) filter (where status = 'failed'), 'skipped', count(*) filter (where status = 'skipped'), 'queued', count(*) filter (where status = 'queued'))
      from public.messages where restaurant_id = p_restaurant and created_at > now() - interval '30 days'),
    'settings', (select jsonb_build_object('twilio_sid', m.twilio_sid, 'sms_from', m.sms_from, 'has_token', m.twilio_secret_id is not null, 'email_from', m.email_from,
        'email_reply_to', m.email_reply_to, 'review_url', m.review_url, 'quiet_start_min', m.quiet_start_min, 'quiet_end_min', m.quiet_end_min)
      from public.messaging_settings m where m.restaurant_id = p_restaurant));
end $$;

create function public.admin_segment_count(p_restaurant uuid, seg jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(p_restaurant, 'campaigns') then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select jsonb_build_object('all', count(*), 'email', count(*) filter (where email_marketing and email is not null), 'sms', count(*) filter (where sms_marketing and phone is not null))
    from public.segment_customers(p_restaurant, seg));
end $$;

create function public.admin_save_automation(p_restaurant uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can(p_restaurant, 'campaigns') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.automations set enabled = (p ->> 'enabled')::boolean, sms = (p ->> 'sms')::boolean, email = (p ->> 'email')::boolean,
    wait = greatest(0, least((p ->> 'wait')::int, 365)), subject = left(coalesce(p ->> 'subject', ''), 200), body = left(coalesce(p ->> 'body', ''), 5000),
    sms_body = left(coalesce(p ->> 'sms_body', ''), 600), promo_code = nullif(upper(trim(p ->> 'promo_code')), ''), updated_at = now()
  where restaurant_id = p_restaurant and kind = p ->> 'kind';
end $$;

create function public.admin_save_campaign(p_restaurant uuid, p jsonb, p_by text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cid uuid := nullif(p ->> 'id', '')::uuid; st text := coalesce(p ->> 'status', 'draft');
begin
  if not public.can(p_restaurant, 'campaigns') then raise exception 'not allowed' using errcode = '42501'; end if;
  if st not in ('draft', 'scheduled', 'cancelled') then raise exception 'Unknown status.'; end if;
  if cid is null then
    insert into public.campaigns (restaurant_id, name, channel, subject, body, sms_body, segment, status, send_at, created_by)
      values (p_restaurant, left(p ->> 'name', 120), p ->> 'channel', left(coalesce(p ->> 'subject', ''), 200), left(coalesce(p ->> 'body', ''), 5000),
        left(coalesce(p ->> 'sms_body', ''), 600), coalesce(p -> 'segment', '{"kind":"all"}'), st, coalesce(nullif(p ->> 'send_at', '')::timestamptz, now()), p_by)
      returning id into cid;
  else
    update public.campaigns set name = left(p ->> 'name', 120), channel = p ->> 'channel', subject = left(coalesce(p ->> 'subject', ''), 200),
      body = left(coalesce(p ->> 'body', ''), 5000), sms_body = left(coalesce(p ->> 'sms_body', ''), 600), segment = coalesce(p -> 'segment', segment),
      status = st, send_at = coalesce(nullif(p ->> 'send_at', '')::timestamptz, now())
    where id = cid and restaurant_id = p_restaurant and status in ('draft', 'scheduled');
    if not found then raise exception 'This campaign was already sent.'; end if;
  end if;
  return cid;
end $$;

create function public.admin_save_promo(p_restaurant uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare pid uuid := nullif(p ->> 'id', '')::uuid; c text := upper(regexp_replace(coalesce(p ->> 'code', ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if not public.can(p_restaurant, 'campaigns') then raise exception 'not allowed' using errcode = '42501'; end if;
  if pid is null then
    if length(c) < 3 then raise exception 'Codes need at least 3 letters or numbers.'; end if;
    insert into public.promo_codes (restaurant_id, code, kind, value, min_subtotal_cents, max_uses, once_per_guest, starts_at, ends_at, note)
      values (p_restaurant, c, p ->> 'kind', (p ->> 'value')::int, coalesce((p ->> 'min_subtotal_cents')::int, 0), nullif(p ->> 'max_uses', '')::int,
        coalesce((p ->> 'once_per_guest')::boolean, true), nullif(p ->> 'starts_at', '')::timestamptz, nullif(p ->> 'ends_at', '')::timestamptz, left(p ->> 'note', 200))
      returning id into pid;
  else
    update public.promo_codes set active = coalesce((p ->> 'active')::boolean, active) where id = pid and restaurant_id = p_restaurant;
  end if;
  return pid;
end $$;

create function public.admin_save_notice(p_restaurant uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare nid uuid := nullif(p ->> 'id', '')::uuid;
begin
  if not public.can(p_restaurant, 'website') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p ? 'remove' then delete from public.site_notices where id = (p ->> 'remove')::uuid and restaurant_id = p_restaurant; return null; end if;
  if (p ->> 'link_url') is not null and (p ->> 'link_url') <> '' and (p ->> 'link_url') !~ '^(https://|/)' then raise exception 'Links must start with https:// or /.'; end if;
  if nid is null then
    insert into public.site_notices (restaurant_id, kind, title, body, link_text, link_url, starts_on, ends_on, sort)
      values (p_restaurant, p ->> 'kind', left(p ->> 'title', 120), left(coalesce(p ->> 'body', ''), 600), left(nullif(p ->> 'link_text', ''), 40), nullif(p ->> 'link_url', ''),
        nullif(p ->> 'starts_on', '')::date, nullif(p ->> 'ends_on', '')::date, coalesce((p ->> 'sort')::int, 0)) returning id into nid;
  else
    update public.site_notices set title = left(p ->> 'title', 120), body = left(coalesce(p ->> 'body', ''), 600), link_text = left(nullif(p ->> 'link_text', ''), 40),
      link_url = nullif(p ->> 'link_url', ''), starts_on = nullif(p ->> 'starts_on', '')::date, ends_on = nullif(p ->> 'ends_on', '')::date,
      active = coalesce((p ->> 'active')::boolean, active) where id = nid and restaurant_id = p_restaurant;
  end if;
  return nid;
end $$;

-- Special hours also block reservations outside them (and the whole day when closed).
create function public.admin_save_hours_exception(p_restaurant uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare d date := (p ->> 'day')::date; rg jsonb := coalesce(p -> 'ranges', '[]'); tag text;
begin
  if not public.can(p_restaurant, 'website') then raise exception 'not allowed' using errcode = '42501'; end if;
  tag := 'Special hours: ' || d::text;
  delete from public.res_blocks where restaurant_id = p_restaurant and block_date = d and reason like 'Special hours:%';
  if p ? 'remove' then delete from public.hours_exceptions where restaurant_id = p_restaurant and day = d; return; end if;
  insert into public.hours_exceptions (restaurant_id, day, closed, ranges, note) values (p_restaurant, d, (p ->> 'closed')::boolean, rg, left(p ->> 'note', 120))
    on conflict (restaurant_id, day) do update set closed = excluded.closed, ranges = excluded.ranges, note = excluded.note;
  if (p ->> 'closed')::boolean then
    insert into public.res_blocks (restaurant_id, block_date, reason) values (p_restaurant, d, tag || coalesce(' ' || nullif(p ->> 'note', ''), ''));
  elsif jsonb_array_length(rg) > 0 then
    insert into public.res_blocks (restaurant_id, block_date, start_min, end_min, reason)
      select p_restaurant, d, 0, (split_part(rg -> 0 ->> 0, ':', 1)::int * 60 + split_part(rg -> 0 ->> 0, ':', 2)::int), tag
      union all
      select p_restaurant, d, (split_part(rg -> (jsonb_array_length(rg) - 1) ->> 1, ':', 1)::int * 60 + split_part(rg -> (jsonb_array_length(rg) - 1) ->> 1, ':', 2)::int)
        - (select res_last_seating_minutes from public.restaurants where id = p_restaurant) + 1, 1440, tag;
  end if;
end $$;

create function public.admin_item_sales(p_restaurant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare tz text;
begin
  if not public.can(p_restaurant, 'orders') then raise exception 'not allowed' using errcode = '42501'; end if;
  select timezone into tz from public.restaurants where id = p_restaurant;
  return coalesce((select jsonb_agg(x order by x.sales_cents desc) from (
    select i.name, sum(i.qty)::int qty, sum(i.line_total_cents)::int sales_cents, count(distinct o.id)::int orders
    from public.order_items i join public.orders o on o.id = i.order_id
    where o.restaurant_id = p_restaurant and o.status in ('new', 'accepted', 'ready', 'completed')
      and (o.created_at at time zone tz)::date between p_from and p_to
    group by i.name) x), '[]');
end $$;

revoke all on function public.upsert_customer(uuid, jsonb), public.refresh_customer(uuid), public.seed_automations(uuid), public.campaign_queue(uuid),
  public.automations_tick(uuid), public.messaging_secret(uuid), public.set_messaging_secret(uuid, text), public.render_msg(text, public.restaurants, public.customers, jsonb),
  public.segment_customers(uuid, jsonb), public.tg_order_customer(), public.tg_reservation_customer(), public.tg_rewards_customer(), public.tg_refresh_customer()
  from public, anon, authenticated;
grant execute on function public.upsert_customer(uuid, jsonb), public.seed_automations(uuid), public.automations_tick(uuid), public.campaign_queue(uuid),
  public.messaging_secret(uuid), public.set_messaging_secret(uuid, text) to service_role;
revoke all on function public.admin_customers(uuid, jsonb), public.admin_customer(uuid, uuid), public.admin_save_customer(uuid, jsonb), public.admin_marketing(uuid),
  public.admin_segment_count(uuid, jsonb), public.admin_save_automation(uuid, jsonb), public.admin_save_campaign(uuid, jsonb, text), public.admin_save_promo(uuid, jsonb),
  public.admin_save_notice(uuid, jsonb), public.admin_save_hours_exception(uuid, jsonb), public.admin_item_sales(uuid, date, date) from public, anon;
grant execute on function public.admin_customers(uuid, jsonb), public.admin_customer(uuid, uuid), public.admin_save_customer(uuid, jsonb), public.admin_marketing(uuid),
  public.admin_segment_count(uuid, jsonb), public.admin_save_automation(uuid, jsonb), public.admin_save_campaign(uuid, jsonb, text), public.admin_save_promo(uuid, jsonb),
  public.admin_save_notice(uuid, jsonb), public.admin_save_hours_exception(uuid, jsonb), public.admin_item_sales(uuid, date, date) to authenticated;
grant select on public.customers, public.automations, public.campaigns, public.messages, public.promo_codes to authenticated;
grant select on public.site_notices, public.hours_exceptions to anon, authenticated;
grant all on public.customers, public.messaging_settings, public.automations, public.campaigns, public.messages, public.promo_codes, public.site_notices,
  public.hours_exceptions, public.refunds to service_role;

-- New restaurants get default automations.
create function public.tg_new_restaurant_automations() returns trigger language plpgsql security definer set search_path = '' as $$
begin perform public.seed_automations(new.id); return null; end $$;
create trigger restaurants_automations after insert on public.restaurants for each row execute function public.tg_new_restaurant_automations();
