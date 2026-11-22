-- Guest accounts: sign in with a phone number (or email) and a 6-digit code. No passwords.
-- An account is the guest's existing customers row, so campaigns, rewards and order history all line up.
alter table public.customers add column account_at timestamptz,              -- first sign-in
  add column addresses jsonb not null default '[]';                             -- saved delivery addresses

create table public.guest_codes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  login text not null,                     -- +1XXXXXXXXXX or a lowercase email
  code_hash text not null,                 -- sha256 hex of the code
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index guest_codes_login on public.guest_codes (restaurant_id, login, created_at desc);

create table public.guest_sessions (
  token_hash text primary key,             -- sha256 hex; the token itself only lives in the guest's browser
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index guest_sessions_customer on public.guest_sessions (customer_id);

alter table public.guest_codes enable row level security;     -- server only
alter table public.guest_sessions enable row level security;  -- server only
grant all on public.guest_codes, public.guest_sessions to service_role;

-- Campaign audience: guests who made an account.
create or replace function public.segment_customers(rid uuid, seg jsonb) returns setof public.customers
language sql stable security definer set search_path = '' as $$
  select c.* from public.customers c
  where c.restaurant_id = rid and case coalesce(seg ->> 'kind', 'all')
    when 'all' then true
    when 'lapsed' then c.last_order_at < now() - make_interval(days => coalesce((seg ->> 'days')::int, 45))
    when 'recent' then c.last_order_at >= now() - make_interval(days => coalesce((seg ->> 'days')::int, 30))
    when 'regulars' then c.order_count >= coalesce((seg ->> 'min_orders')::int, 3)
    when 'never_ordered' then c.order_count = 0
    when 'rewards' then exists (select 1 from public.rewards_accounts a where a.customer_id = c.id)
    when 'accounts' then c.account_at is not null
    when 'birthday_month' then c.birth_month = coalesce((seg ->> 'month')::int, extract(month from now())::int)
    when 'tag' then (seg ->> 'tag') = any (c.tags)
    else false end;
$$;

-- Old codes and sessions are cleared out daily.
select cron.schedule('guest-auth-cleanup', '17 9 * * *', $job$
  delete from public.guest_codes where created_at < now() - interval '2 days';
  delete from public.guest_sessions where expires_at < now();
$job$);
