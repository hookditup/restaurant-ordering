-- Website forms, reservation requests, rewards and gift cards. Guests and staff reach
-- these only through the `ordering` edge function, so the tables have no policies.

alter table public.restaurants
  add column forms_email text,
  add column rewards_points_per_dollar integer not null default 1 check (rewards_points_per_dollar between 0 and 100),
  add column rewards_redeem_points integer not null default 100 check (rewards_redeem_points > 0),
  add column rewards_redeem_cents integer not null default 500 check (rewards_redeem_cents > 0),
  add column gift_min_cents integer not null default 1000,
  add column gift_max_cents integer not null default 50000;

alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('unpaid', 'paid', 'test_paid', 'gift_card', 'refunded', 'failed'));
alter table public.orders
  add column discount_cents integer not null default 0,
  add column gift_applied_cents integer not null default 0,
  add column amount_due_cents integer,
  add column credits_released boolean not null default false;

create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  kind text not null,
  data jsonb not null,
  status text not null default 'new' check (status in ('new', 'done')),
  created_at timestamptz not null default now()
);
create index on public.form_submissions (restaurant_id, status, created_at desc);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  email text not null,
  phone text not null,
  res_date date not null,
  res_time text not null,
  party_size text not null,
  requests text,
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'declined', 'cancelled')),
  handled_by text,
  created_at timestamptz not null default now()
);
create index on public.reservations (restaurant_id, res_date, status);

create table public.rewards_accounts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  phone text not null,
  name text not null,
  email text,
  code text not null,
  points integer not null default 0 check (points >= 0),
  sms_consent boolean not null default false,
  created_at timestamptz not null default now(),
  unique (restaurant_id, phone),
  unique (restaurant_id, code)
);

create table public.rewards_events (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.rewards_accounts(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  points integer not null,
  reason text not null,
  by_name text,
  at timestamptz not null default now()
);
create unique index rewards_earned_once on public.rewards_events (order_id) where reason = 'earned';

create table public.gift_cards (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  code text not null,
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  initial_cents integer not null check (initial_cents > 0),
  balance_cents integer not null default 0 check (balance_cents >= 0),
  status text not null default 'pending' check (status in ('pending', 'active', 'void')),
  source text not null default 'online' check (source in ('online', 'staff')),
  buyer_name text,
  buyer_email text,
  recipient_name text,
  recipient_email text,
  message text,
  test_mode boolean not null,
  stripe_payment_intent text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (restaurant_id, code)
);

create table public.gift_card_events (
  id bigint generated always as identity primary key,
  gift_card_id uuid not null references public.gift_cards(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  cents integer not null,
  reason text not null,
  by_name text,
  at timestamptz not null default now()
);

-- Balance changes are atomic. Each returns the new balance, or null if there isn't enough.
create function public.rewards_change(p_account uuid, p_delta int, p_reason text, p_order uuid default null, p_by text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare b integer;
begin
  update public.rewards_accounts set points = points + p_delta
    where id = p_account and points + p_delta >= 0 returning points into b;
  if b is null then return null; end if;
  insert into public.rewards_events (account_id, order_id, points, reason, by_name) values (p_account, p_order, p_delta, p_reason, p_by);
  return b;
end $$;

create function public.gift_change(p_card uuid, p_delta int, p_reason text, p_order uuid default null, p_by text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare b integer;
begin
  update public.gift_cards set balance_cents = balance_cents + p_delta
    where id = p_card and status = 'active' and balance_cents + p_delta >= 0 returning balance_cents into b;
  if b is null then return null; end if;
  insert into public.gift_card_events (gift_card_id, order_id, cents, reason, by_name) values (p_card, p_order, p_delta, p_reason, p_by);
  return b;
end $$;

-- Gives back points and gift card money taken for an order. Safe to call twice.
create function public.order_release_credits(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e record; hit uuid;
begin
  update public.orders set credits_released = true where id = p_order and not credits_released returning id into hit;
  if hit is null then return; end if;
  for e in select account_id, sum(points)::int as pts from public.rewards_events
    where order_id = p_order and reason = 'redeemed' group by account_id loop
    perform public.rewards_change(e.account_id, -e.pts, 'returned', p_order, 'system');
  end loop;
  for e in select gift_card_id, sum(cents)::int as amt from public.gift_card_events
    where order_id = p_order and reason = 'redeemed' group by gift_card_id loop
    perform public.gift_change(e.gift_card_id, -e.amt, 'returned', p_order, 'system');
  end loop;
end $$;

-- Adds points for a picked-up order when the phone matches a member. Counts each order once.
create function public.order_earn_points(p_order uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare o public.orders; acct uuid; pts integer; rate integer;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then return 0; end if;
  select id into acct from public.rewards_accounts where restaurant_id = o.restaurant_id and phone = o.phone;
  select rewards_points_per_dollar into rate from public.restaurants where id = o.restaurant_id;
  pts := floor(greatest(o.subtotal_cents - o.discount_cents, 0) / 100.0)::int * rate;
  if acct is null or pts <= 0 then return 0; end if;
  insert into public.rewards_events (account_id, order_id, points, reason) values (acct, p_order, pts, 'earned')
    on conflict (order_id) where reason = 'earned' do nothing;
  if not found then return 0; end if;
  update public.rewards_accounts set points = points + pts where id = acct;
  return pts;
end $$;

alter table public.form_submissions enable row level security;
alter table public.reservations enable row level security;
alter table public.rewards_accounts enable row level security;
alter table public.rewards_events enable row level security;
alter table public.gift_cards enable row level security;
alter table public.gift_card_events enable row level security;
revoke all on public.form_submissions, public.reservations, public.rewards_accounts, public.rewards_events,
  public.gift_cards, public.gift_card_events from anon, authenticated;
grant all on public.form_submissions, public.reservations, public.rewards_accounts, public.rewards_events,
  public.gift_cards, public.gift_card_events to service_role;
revoke all on function public.rewards_change(uuid, int, text, uuid, text), public.gift_change(uuid, int, text, uuid, text),
  public.order_release_credits(uuid), public.order_earn_points(uuid) from public, anon, authenticated;
grant execute on function public.rewards_change(uuid, int, text, uuid, text), public.gift_change(uuid, int, text, uuid, text),
  public.order_release_credits(uuid), public.order_earn_points(uuid) to service_role;
