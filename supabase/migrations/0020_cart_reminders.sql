-- Abandoned cart reminders for signed-in guests, and birthdays on the guest account.
alter table public.customers add column cart jsonb, add column cart_at timestamptz;

alter table public.automations drop constraint automations_kind_check;
alter table public.automations add constraint automations_kind_check
  check (kind in ('order_ready', 'reservation_reminder', 'welcome', 'winback', 'birthday', 'review', 'points', 'cart'));

-- The signed-in guest for a browser session token (same SHA-256 the ordering function stores).
create function public.guest_customer(p_slug text, p_session text) returns uuid
language sql stable security definer set search_path = '' as $$
  select s.customer_id from public.guest_sessions s join public.restaurants r on r.id = s.restaurant_id
  where r.slug = p_slug and s.expires_at > now()
    and s.token_hash = encode(extensions.digest(convert_to(lower(coalesce(p_session, '')), 'utf8'), 'sha256'), 'hex');
$$;
revoke all on function public.guest_customer(text, text) from public, anon, authenticated;

-- The menu page saves a signed-in guest's cart so a reminder can name what they left.
-- p_lines: [{id, qty, options, note}] (to restore it); p_names: ["2 × Tacos", ...] (for the message).
create function public.guest_save_cart(p_slug text, p_session text, p_lines jsonb, p_names jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare cid uuid := public.guest_customer(p_slug, p_session);
begin
  if cid is null then return false; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    update public.customers set cart = null, cart_at = null where id = cid;
  else
    if jsonb_array_length(p_lines) > 60 or length(p_lines::text) > 20000 then return false; end if;
    update public.customers set cart = jsonb_build_object('lines', p_lines, 'names',
        (select coalesce(jsonb_agg(left(x, 80)), '[]') from (select jsonb_array_elements_text(coalesce(p_names, '[]')) x limit 20) n)),
      cart_at = now() where id = cid;
  end if;
  return true;
end $$;

-- Saved cart and birthday for the account sheet.
create function public.guest_extras(p_slug text, p_session text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('cart', c.cart -> 'lines', 'birth_month', c.birth_month, 'birth_day', c.birth_day)
  from public.customers c where c.id = public.guest_customer(p_slug, p_session);
$$;

create function public.guest_birthday(p_slug text, p_session text, p_month int, p_day int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare cid uuid := public.guest_customer(p_slug, p_session);
begin
  if cid is null then return false; end if;
  if p_month is null or p_day is null then
    update public.customers set birth_month = null, birth_day = null where id = cid;
  elsif p_month between 1 and 12 and p_day between 1 and 31 then
    update public.customers set birth_month = p_month, birth_day = p_day where id = cid;
  else return false; end if;
  return true;
end $$;
grant execute on function public.guest_save_cart(text, text, jsonb, jsonb), public.guest_extras(text, text), public.guest_birthday(text, text, int, int) to anon, authenticated;

-- The new automation, off until the owner turns it on.
insert into public.automations (restaurant_id, kind, enabled, sms, email, wait, subject, body, sms_body)
select id, 'cart', false, true, true, 1, 'You left something at {restaurant}',
  E'Hi {first_name}, your order is still waiting: {items}.\n\nFinish it here: {cart_link}',
  '{restaurant}: Hi {first_name}, your order is still in your cart ({items}). Finish it: {cart_link}'
from public.restaurants on conflict do nothing;

create or replace function public.seed_automations(rid uuid) returns void
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
    '{restaurant}: You have {points} points, enough for a reward! Use code {code}: {link}'),
  (rid, 'cart', false, true, true, 1, 'You left something at {restaurant}',
    E'Hi {first_name}, your order is still waiting: {items}.\n\nFinish it here: {cart_link}',
    '{restaurant}: Hi {first_name}, your order is still in your cart ({items}). Finish it: {cart_link}')
  on conflict do nothing;
$$;

-- Same as 0012, plus the cart reminder.
create or replace function public.automations_tick(rid uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare r public.restaurants; a public.automations; n int := 0; k int; promo text; ms public.messaging_settings; today date;
begin
  select * into r from public.restaurants where id = rid and active;
  if r.id is null then return 0; end if;
  select * into ms from public.messaging_settings where restaurant_id = rid;
  today := (now() at time zone r.timezone)::date;
  create temp table if not exists _due (cid uuid, extra jsonb, dk text, mk boolean) on commit drop;
  for a in select * from public.automations where restaurant_id = rid and enabled and kind in ('winback', 'birthday', 'review', 'points', 'reservation_reminder', 'cart') loop
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
    elsif a.kind = 'cart' then
      -- Signed-in guests who left food in the cart this many hours ago and haven't ordered since. Once a week at most.
      truncate _due;
      insert into _due select c.id, jsonb_build_object('items', (select string_agg(x, ', ') from jsonb_array_elements_text(c.cart -> 'names') x), 'cart_link', r.site_url || '/menu/?cart=1'),
          'c:' || c.id || ':' || to_char(c.cart_at, 'YYYYMMDDHH24MI'), true
        from public.customers c where c.restaurant_id = rid and c.cart is not null
          and c.cart_at between now() - make_interval(hours => a.wait + 24) and now() - make_interval(hours => a.wait)
          and not exists (select 1 from public.orders o where o.customer_id = c.id and o.created_at >= c.cart_at and o.status <> 'expired')
          and not exists (select 1 from public.messages m where m.customer_id = c.id and m.kind = 'cart' and m.created_at > now() - interval '7 days');
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
  perform public.campaign_queue(id) from public.msg_campaigns where restaurant_id = rid and status = 'scheduled' and send_at <= now();
  return n;
end $$;
