-- Link existing orders, reservations and rewards members to customers; give owners/managers the new sections.
-- New admin sections for existing owner and manager logins.
update public.staff set permissions = array(select distinct unnest(permissions || array['customers', 'campaigns', 'website']))
  where role in ('owner', 'manager');

-- Seated guests still hold their seats; reservation tools follow the Reservations permission.
do $$
declare f text;
begin
  foreach f in array array['public.res_day(uuid,date)', 'public.res_month(uuid,date,integer)', 'public.staff_res_day(uuid,date)'] loop
    execute replace(pg_get_functiondef(f::regprocedure), 'status in (''requested'', ''confirmed'')', 'status in (''requested'', ''confirmed'', ''seated'')');
  end loop;
  foreach f in array array['public.admin_res_settings(uuid,jsonb)', 'public.admin_res_block(uuid,jsonb)'] loop
    execute replace(pg_get_functiondef(f::regprocedure), 'public.is_manager(p_restaurant)', 'public.can(p_restaurant, ''reservations'')');
  end loop;
end $$;

-- Backfill: link what we already have, oldest first.
update public.rewards_accounts set customer_id = public.upsert_customer(restaurant_id, jsonb_build_object('phone', phone, 'email', email,
  'first_name', split_part(name, ' ', 1), 'last_name', nullif(regexp_replace(name, '^\S+\s*', ''), ''), 'sms_marketing', sms_consent, 'source', 'rewards'))
  where customer_id is null;
update public.orders set customer_id = public.upsert_customer(restaurant_id, jsonb_build_object('phone', phone, 'email', email,
  'first_name', first_name, 'last_name', last_name, 'source', 'online order')) where customer_id is null;
update public.reservations set customer_id = public.upsert_customer(restaurant_id, jsonb_build_object('phone', phone, 'email', email,
  'first_name', split_part(name, ' ', 1), 'last_name', nullif(regexp_replace(name, '^\S+\s*', ''), ''), 'source', 'reservation')) where customer_id is null;
select public.refresh_customer(id) from public.customers;
