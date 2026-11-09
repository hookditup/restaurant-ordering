-- Team access: per-person permissions for each admin section, plus agency (platform) admins
-- who can open every restaurant from one login.
--
-- Sections: kitchen, dashboard, orders, reservations, messages, rewards, gift, menu, choices,
-- pairs, settings, marketing, team. "team" lets someone add people and change what they can see.

create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;
grant all on public.platform_admins to service_role;

alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add column if not exists permissions text[] not null default '{}';
alter table public.staff add column if not exists created_at timestamptz not null default now();
alter table public.staff add constraint staff_role_check check (role in ('owner', 'manager', 'kitchen', 'custom'));

-- Existing managers keep full access; kitchen logins keep the kitchen screen.
update public.staff set permissions = array['kitchen','dashboard','orders','reservations','messages','rewards','gift','menu','choices','pairs','settings','marketing','team']
  where role = 'manager' and permissions = '{}';
update public.staff set permissions = array['kitchen'] where role = 'kitchen' and permissions = '{}';

create or replace function public.is_platform_admin() returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins p where p.user_id = (select auth.uid()));
$$;

create or replace function public.can(rid uuid, perm text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select public.is_platform_admin()
    or exists (select 1 from public.staff s where s.restaurant_id = rid and s.user_id = (select auth.uid()) and perm = any (s.permissions));
$$;

create or replace function public.is_staff(rid uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select public.is_platform_admin() or exists (select 1 from public.staff s where s.user_id = (select auth.uid()) and s.restaurant_id = rid);
$$;

create or replace function public.is_manager(rid uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select public.can(rid, 'team');
$$;

-- Restaurants this login can open, with what it may do in each.
create or replace function public.my_access() returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('id', r.id, 'slug', r.slug, 'name', r.name, 'timezone', r.timezone, 'agency', true,
      'perms', to_jsonb(array['kitchen','dashboard','orders','reservations','messages','rewards','gift','menu','choices','pairs','settings','marketing','team'])) x
      from public.restaurants r where public.is_platform_admin()
    union all
    select jsonb_build_object('id', r.id, 'slug', r.slug, 'name', r.name, 'timezone', r.timezone, 'agency', false, 'perms', to_jsonb(s.permissions))
      from public.staff s join public.restaurants r on r.id = s.restaurant_id
      where s.user_id = (select auth.uid()) and not public.is_platform_admin()
  ) t;
$$;

-- Service role only: look up a login by email when adding someone to a team.
create or replace function public.auth_user_id(p_email text) returns uuid
  language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
$$;

revoke all on function public.is_platform_admin(), public.can(uuid, text), public.my_access(), public.auth_user_id(text) from public, anon;
grant execute on function public.is_platform_admin(), public.can(uuid, text), public.my_access() to authenticated;
grant execute on function public.auth_user_id(text) to service_role;
revoke execute on function public.auth_user_id(text) from authenticated;

-- Each admin function now checks the section it belongs to instead of "is a manager".
do $$
declare f record; def text; perm text;
begin
  for f in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('admin_stats','admin_menu','admin_new_item','admin_save_item','admin_save_option','admin_set_pairs','admin_pair_ideas','admin_save_pair_rules','admin_save_settings')
  loop
    def := pg_get_functiondef(f.oid);
    perm := case f.proname
      when 'admin_stats' then $p$'dashboard'$p$
      when 'admin_new_item' then $p$'menu'$p$
      when 'admin_save_item' then $p$'menu'$p$
      when 'admin_save_option' then $p$'choices'$p$
      when 'admin_set_pairs' then $p$'pairs'$p$
      when 'admin_pair_ideas' then $p$'pairs'$p$
      when 'admin_save_pair_rules' then $p$'pairs'$p$
      else null end;
    if f.proname = 'admin_menu' then
      def := regexp_replace(def, 'public\.is_manager\(([a-z_.]+)\)', '(public.can(\1, ''menu'') or public.can(\1, ''choices'') or public.can(\1, ''pairs''))', 'g');
    elsif f.proname = 'admin_save_settings' then
      -- The Popular dishes form on the pairings tab saves only popular_* settings.
      def := regexp_replace(def, 'public\.is_manager\(([a-z_.]+)\)',
        '(public.can(\1, ''settings'') or (public.can(\1, ''pairs'') and (p - ''popular_days'' - ''popular_min_orders'' - ''popular_count'') = ''{}''::jsonb))', 'g');
    else
      def := regexp_replace(def, 'public\.is_manager\(([a-z_.]+)\)', 'public.can(\1, ' || perm || ')', 'g');
    end if;
    execute def;
  end loop;
end $$;

-- Table access for logged-in staff follows the same sections.
drop policy if exists staff_read_orders on public.orders;
create policy staff_read_orders on public.orders for select to authenticated
  using (public.can(restaurant_id, 'kitchen') or public.can(restaurant_id, 'orders'));
drop policy if exists staff_read_order_items on public.order_items;
create policy staff_read_order_items on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and (public.can(o.restaurant_id, 'kitchen') or public.can(o.restaurant_id, 'orders'))));
drop policy if exists staff_update_items on public.menu_items;
create policy staff_update_items on public.menu_items for update to authenticated
  using (public.can(restaurant_id, 'menu')) with check (public.can(restaurant_id, 'menu'));
drop policy if exists menu_images_manager_insert on storage.objects;
create policy menu_images_manager_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-images' and public.can(((storage.foldername(name))[1])::uuid, 'menu'));
drop policy if exists menu_images_manager_update on storage.objects;
create policy menu_images_manager_update on storage.objects for update to authenticated
  using (bucket_id = 'menu-images' and public.can(((storage.foldername(name))[1])::uuid, 'menu'));
