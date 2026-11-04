-- Reusable online ordering. One database serves many restaurants: every row
-- belongs to a restaurant. Guests never touch orders directly; all order writes
-- go through the `ordering` edge function, which prices carts on the server.

create extension if not exists pgcrypto;

create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  phone text,
  email text,
  address text,
  timezone text not null default 'America/Denver',
  -- {"mon":[["10:30","21:00"]], ... } missing or empty day = closed
  hours jsonb not null default '{}',
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 2500),
  guest_fee_bps integer not null default 0 check (guest_fee_bps between 0 and 1000),
  pickup_lead_minutes integer not null default 20 check (pickup_lead_minutes between 0 and 240),
  last_order_minutes_before_close integer not null default 0,
  accepting_orders boolean not null default true,
  test_mode boolean not null default true,
  stripe_account_id text,
  alert_email text,
  site_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  description text,
  note text,
  -- same shape as restaurants.hours; null = whenever the restaurant is open.
  -- Lunch and dinner versions of a menu are two categories with different hours.
  hours jsonb,
  sort integer not null default 0,
  active boolean not null default true,
  external_id text,
  unique (restaurant_id, external_id)
);
create index on public.menu_categories (restaurant_id, sort);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  category_id uuid not null references public.menu_categories(id) on delete cascade,
  name text not null,
  description text,
  price_cents integer not null check (price_cents >= 0),
  image text,
  allergens text[] not null default '{}',
  gluten_free boolean not null default false,
  vegetarian boolean not null default false,
  popular boolean not null default false,
  available boolean not null default true,
  sort integer not null default 0,
  external_id text,
  unique (restaurant_id, category_id, external_id)
);
create index on public.menu_items (category_id, sort);
create index on public.menu_items (restaurant_id);

create table public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer check (max_select is null or max_select >= 1), -- null = no limit
  external_id text,
  unique (restaurant_id, external_id)
);

create table public.modifier_options (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  group_id uuid not null references public.modifier_groups(id) on delete cascade,
  name text not null,
  price_cents integer not null default 0 check (price_cents >= 0),
  available boolean not null default true,
  sort integer not null default 0,
  external_id text,
  unique (group_id, external_id)
);
create index on public.modifier_options (group_id, sort);

create table public.item_modifier_groups (
  item_id uuid not null references public.menu_items(id) on delete cascade,
  group_id uuid not null references public.modifier_groups(id) on delete cascade,
  sort integer not null default 0,
  primary key (item_id, group_id)
);

-- A choice can open a follow-up group.
create table public.option_modifier_groups (
  option_id uuid not null references public.modifier_options(id) on delete cascade,
  group_id uuid not null references public.modifier_groups(id) on delete cascade,
  sort integer not null default 0,
  primary key (option_id, group_id)
);

create table public.staff (
  user_id uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text,
  role text not null default 'kitchen' check (role in ('kitchen', 'manager')),
  primary key (user_id, restaurant_id)
);

create sequence public.order_number_seq start 1001;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id),
  order_no text not null default (nextval('public.order_number_seq')::text),
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'new', 'accepted', 'ready', 'completed', 'cancelled', 'expired')),
  fulfillment text not null default 'pickup' check (fulfillment in ('pickup', 'delivery')),
  pickup_at timestamptz not null,
  first_name text not null,
  last_name text not null,
  phone text not null,
  email text not null,
  note text,
  subtotal_cents integer not null,
  tax_cents integer not null,
  guest_fee_cents integer not null default 0,
  tip_cents integer not null default 0,
  total_cents integer not null,
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'paid', 'test_paid', 'refunded', 'failed')),
  stripe_session_id text,
  stripe_payment_intent text,
  test_mode boolean not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  accepted_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  unique (restaurant_id, order_no)
);
create index on public.orders (restaurant_id, status, pickup_at);
create index on public.orders (stripe_session_id);

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  name text not null,
  qty integer not null check (qty between 1 and 50),
  unit_price_cents integer not null,
  line_total_cents integer not null,
  options jsonb not null default '[]',
  note text
);
create index on public.order_items (order_id);

create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid references public.orders(id) on delete cascade,
  at timestamptz not null default now(),
  source text not null,
  event text not null,
  data jsonb not null default '{}'
);
create index on public.order_events (order_id, at);

-- Stripe retries webhooks; this stops one event being applied twice.
create table public.stripe_events (
  id text primary key,
  received_at timestamptz not null default now()
);

create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits integer not null default 1
);

-- Is this user staff at this restaurant? Used by the policies below.
create function public.is_staff(rid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff s where s.user_id = auth.uid() and s.restaurant_id = rid);
$$;
revoke all on function public.is_staff(uuid) from public;
grant execute on function public.is_staff(uuid) to authenticated;

-- One modifier group with its options and any follow-up groups (one level).
create function public.group_json(gid uuid, nested boolean default true) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select,
    'options', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'price_cents', o.price_cents,
        'groups', case when nested then coalesce((
          select jsonb_agg(public.group_json(omg.group_id, false) order by omg.sort)
          from public.option_modifier_groups omg where omg.option_id = o.id), '[]'::jsonb)
          else '[]'::jsonb end) order by o.sort)
      from public.modifier_options o where o.group_id = g.id and o.available), '[]'::jsonb))
  from public.modifier_groups g where g.id = gid;
$$;

-- The whole menu for one restaurant in a single call.
create function public.get_menu(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', r.id, 'slug', r.slug, 'name', r.name, 'phone', r.phone, 'address', r.address,
      'timezone', r.timezone, 'hours', r.hours, 'tax_rate_bps', r.tax_rate_bps,
      'guest_fee_bps', r.guest_fee_bps, 'pickup_lead_minutes', r.pickup_lead_minutes,
      'last_order_minutes_before_close', r.last_order_minutes_before_close,
      'accepting_orders', r.accepting_orders, 'test_mode', r.test_mode),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'description', c.description, 'note', c.note, 'hours', c.hours,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', i.id, 'name', i.name, 'description', i.description, 'price_cents', i.price_cents,
            'image', i.image, 'allergens', i.allergens, 'gluten_free', i.gluten_free,
            'vegetarian', i.vegetarian, 'popular', i.popular,
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

grant execute on function public.get_menu(text) to anon, authenticated;
revoke all on function public.group_json(uuid, boolean) from public, anon, authenticated;

alter table public.restaurants enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.modifier_groups enable row level security;
alter table public.modifier_options enable row level security;
alter table public.item_modifier_groups enable row level security;
alter table public.option_modifier_groups enable row level security;
alter table public.staff enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;
alter table public.stripe_events enable row level security;
alter table public.rate_limits enable row level security;

-- Guests read the menu through get_menu(). Staff can read their own
-- restaurant's data and can pause items; every order change goes through the
-- edge function. No policy = no access, which is what stripe_events,
-- rate_limits and the menu tables get for anon.
create policy staff_read_self on public.staff for select to authenticated using (user_id = (select auth.uid()));
create policy staff_read_restaurant on public.restaurants for select to authenticated using (public.is_staff(id));
create policy staff_read_orders on public.orders for select to authenticated using (public.is_staff(restaurant_id));
create policy staff_read_order_items on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and public.is_staff(o.restaurant_id)));
create policy staff_read_items on public.menu_items for select to authenticated using (public.is_staff(restaurant_id));
create policy staff_update_items on public.menu_items for update to authenticated
  using (public.is_staff(restaurant_id)) with check (public.is_staff(restaurant_id));

grant select on public.staff, public.restaurants, public.orders, public.order_items, public.menu_items to authenticated;
grant update (available) on public.menu_items to authenticated;
revoke all on public.menu_categories, public.modifier_groups, public.modifier_options,
  public.item_modifier_groups, public.option_modifier_groups, public.order_events,
  public.stripe_events, public.rate_limits from anon, authenticated;
revoke all on public.restaurants, public.menu_items, public.staff, public.orders, public.order_items from anon;
