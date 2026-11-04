-- Load or replace one restaurant's whole menu from a JSON payload (service role only).
create function public.import_menu(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare rid uuid; c jsonb; i jsonb; g jsonb; o jsonb; cid uuid; iid uuid; gid uuid; ref jsonb;
begin
  insert into public.restaurants (slug, name, phone, email, address, timezone, hours, tax_rate_bps, guest_fee_bps,
    pickup_lead_minutes, test_mode, alert_email, site_url)
  values (p->'restaurant'->>'slug', p->'restaurant'->>'name', p->'restaurant'->>'phone', p->'restaurant'->>'email',
    p->'restaurant'->>'address', coalesce(p->'restaurant'->>'timezone','America/Denver'), p->'restaurant'->'hours',
    (p->'restaurant'->>'tax_rate_bps')::int, coalesce((p->'restaurant'->>'guest_fee_bps')::int,0),
    coalesce((p->'restaurant'->>'pickup_lead_minutes')::int,20), true, p->'restaurant'->>'alert_email', p->'restaurant'->>'site_url')
  on conflict (slug) do update set name=excluded.name, phone=excluded.phone, email=excluded.email, address=excluded.address,
    hours=excluded.hours, site_url=excluded.site_url
  returning id into rid;

  delete from public.menu_categories where restaurant_id = rid;
  delete from public.modifier_groups where restaurant_id = rid;

  for g in select * from jsonb_array_elements(p->'groups') loop
    insert into public.modifier_groups (restaurant_id, name, min_select, max_select, external_id)
    values (rid, g->>'name', (g->>'min')::int, (g->>'max')::int, g->>'id') returning id into gid;
    for o in select * from jsonb_array_elements(g->'options') loop
      insert into public.modifier_options (restaurant_id, group_id, name, price_cents, sort, external_id)
      values (rid, gid, o->>'name', (o->>'price_cents')::int, (o->>'sort')::int, o->>'id');
    end loop;
  end loop;

  for g in select * from jsonb_array_elements(p->'groups') loop
    for o in select * from jsonb_array_elements(g->'options') loop
      for ref in select * from jsonb_array_elements(coalesce(o->'groups','[]'::jsonb)) loop
        insert into public.option_modifier_groups (option_id, group_id)
        select op.id, gc.id from public.modifier_options op
          join public.modifier_groups gp on gp.id = op.group_id and gp.external_id = g->>'id' and gp.restaurant_id = rid
          join public.modifier_groups gc on gc.external_id = ref#>>'{}' and gc.restaurant_id = rid
        where op.external_id = o->>'id';
      end loop;
    end loop;
  end loop;

  for c in select * from jsonb_array_elements(p->'categories') loop
    insert into public.menu_categories (restaurant_id, name, description, note, hours, sort, external_id)
    values (rid, c->>'name', c->>'description', c->>'note', nullif(c->'hours','null'::jsonb), (c->>'sort')::int, c->>'id')
    returning id into cid;
    for i in select * from jsonb_array_elements(c->'items') loop
      insert into public.menu_items (restaurant_id, category_id, name, description, price_cents, image, allergens,
        gluten_free, vegetarian, popular, sort, external_id)
      values (rid, cid, i->>'name', i->>'description', (i->>'price_cents')::int, i->>'image',
        array(select jsonb_array_elements_text(i->'allergens')), (i->>'gluten_free')::boolean, (i->>'vegetarian')::boolean,
        (i->>'popular')::boolean, (i->>'sort')::int, i->>'id') returning id into iid;
      insert into public.item_modifier_groups (item_id, group_id, sort)
      select iid, gr.id, r.ord from jsonb_array_elements_text(i->'groups') with ordinality r(ext, ord)
      join public.modifier_groups gr on gr.external_id = r.ext and gr.restaurant_id = rid;
    end loop;
  end loop;

  return jsonb_build_object('restaurant', rid,
    'categories', (select count(*) from public.menu_categories where restaurant_id = rid),
    'items', (select count(*) from public.menu_items where restaurant_id = rid),
    'groups', (select count(*) from public.modifier_groups where restaurant_id = rid),
    'options', (select count(*) from public.modifier_options where restaurant_id = rid));
end $$;
revoke all on function public.import_menu(jsonb) from public, anon, authenticated;

create function public.rate_limit(p_key text, p_max int, p_seconds int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare h int;
begin
  insert into public.rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_seconds) then now() else r.window_start end
  returning hits into h;
  return h <= p_max;
end $$;
revoke all on function public.rate_limit(text, int, int) from public, anon, authenticated;

revoke execute on function public.is_staff(uuid) from anon;
