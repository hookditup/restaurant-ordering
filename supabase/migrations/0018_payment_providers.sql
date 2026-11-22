-- Card processor per restaurant. No row (or provider 'stripe') = Stripe, exactly as before.
-- Authorize.net, Clover and Square pay straight into the restaurant's own merchant account.
create table public.payment_settings (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  provider text not null default 'stripe' check (provider in ('stripe', 'authorizenet', 'clover', 'square')),
  env text not null default 'production' check (env in ('production', 'sandbox')),
  settings jsonb not null default '{}',   -- authorizenet: api_login_id; clover: merchant_id; square: location_id
  secret_id uuid,                          -- Vault: {"key": "...", "hook_key": "..."}
  last_ok_at timestamptz, last_error text,
  updated_at timestamptz not null default now()
);
alter table public.payment_settings enable row level security; -- server only; staff use the admin_* functions
grant all on public.payment_settings to service_role;

-- Which processor took each payment, its page/session and its transaction (for refunds).
alter table public.orders add column payment_provider text not null default 'stripe', add column payment_session text, add column payment_ref text;
create index orders_payment_session on public.orders (payment_provider, payment_session) where payment_session is not null;
create index orders_awaiting_other on public.orders (created_at) where status = 'awaiting_payment' and payment_provider <> 'stripe';
alter table public.gift_cards add column payment_provider text not null default 'stripe', add column payment_session text, add column payment_ref text;
create index gift_cards_payment_session on public.gift_cards (payment_provider, payment_session) where payment_session is not null;
alter table public.refunds add column provider_refund_id text;

create function public.payment_secret(rid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from public.payment_settings p join vault.decrypted_secrets s on s.id = p.secret_id where p.restaurant_id = rid;
$$;
revoke all on function public.payment_secret(uuid) from public, anon, authenticated;
grant execute on function public.payment_secret(uuid) to service_role;

-- Admin: anyone with Settings can see it; only agency logins can change where the money goes.
create function public.admin_payments(p_restaurant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare sec jsonb;
begin
  if not public.can(p_restaurant, 'settings') then raise exception 'not allowed' using errcode = '42501'; end if;
  select coalesce(nullif(s.decrypted_secret, ''), '{}')::jsonb into sec from public.payment_settings p join vault.decrypted_secrets s on s.id = p.secret_id where p.restaurant_id = p_restaurant;
  return (select jsonb_build_object('provider', coalesce(p.provider, 'stripe'), 'env', coalesce(p.env, 'production'), 'settings', coalesce(p.settings, '{}'),
      'has_key', coalesce(sec ->> 'key', '') <> '', 'has_hook_key', coalesce(sec ->> 'hook_key', '') <> '',
      'last_ok_at', p.last_ok_at, 'last_error', p.last_error, 'can_edit', public.is_platform_admin(),
      'test_mode', r.test_mode, 'stripe_account', r.stripe_account_id is not null)
    from public.restaurants r left join public.payment_settings p on p.restaurant_id = r.id where r.id = p_restaurant);
end $$;

-- p: { provider, env, settings, key?, hook_key? }. Blank keys keep the saved ones.
create function public.admin_save_payments(p_restaurant uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare sid uuid; sec jsonb; old text; switched boolean;
begin
  if not public.is_platform_admin() then raise exception 'Only Hook''d IT Up can change the card processor.' using errcode = '42501'; end if;
  if p ->> 'provider' not in ('stripe', 'authorizenet', 'clover', 'square') then raise exception 'Pick a card processor.'; end if;
  select provider into old from public.payment_settings where restaurant_id = p_restaurant;
  switched := old is distinct from p ->> 'provider';
  insert into public.payment_settings (restaurant_id, provider, env, settings)
    values (p_restaurant, p ->> 'provider', coalesce(p ->> 'env', 'production'), coalesce(p -> 'settings', '{}'))
    on conflict (restaurant_id) do update set provider = excluded.provider, env = excluded.env, settings = excluded.settings,
      last_error = null, last_ok_at = case when payment_settings.provider = excluded.provider then payment_settings.last_ok_at end, updated_at = now();
  select secret_id into sid from public.payment_settings where restaurant_id = p_restaurant;
  if not switched and nullif(trim(p ->> 'key'), '') is null and nullif(trim(p ->> 'hook_key'), '') is null then return; end if;
  if not switched then select coalesce(nullif(decrypted_secret, ''), '{}')::jsonb into sec from vault.decrypted_secrets where id = sid; end if;
  sec := coalesce(sec, '{}');  -- a new processor starts with no keys
  if nullif(trim(p ->> 'key'), '') is not null then sec := sec || jsonb_build_object('key', trim(p ->> 'key')); end if;
  if nullif(trim(p ->> 'hook_key'), '') is not null then sec := sec || jsonb_build_object('hook_key', trim(p ->> 'hook_key')); end if;
  if sid is null then
    update public.payment_settings set secret_id = vault.create_secret(sec::text, 'payment_keys_' || p_restaurant::text) where restaurant_id = p_restaurant;
  else
    perform vault.update_secret(sid, sec::text);
  end if;
end $$;
revoke all on function public.admin_payments(uuid), public.admin_save_payments(uuid, jsonb) from public, anon;
grant execute on function public.admin_payments(uuid), public.admin_save_payments(uuid, jsonb) to authenticated;
