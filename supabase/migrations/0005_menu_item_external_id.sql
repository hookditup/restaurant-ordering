-- Adds each item's stable id to get_menu, so fixed website pages can match their cards to live data.
create or replace function public.get_menu(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', r.id, 'slug', r.slug, 'name', r.name, 'phone', r.phone, 'address', r.address,
      'timezone', r.timezone, 'hours', r.hours, 'tax_rate_bps', r.tax_rate_bps,
      'guest_fee_bps', r.guest_fee_bps, 'pickup_lead_minutes', r.pickup_lead_minutes,
      'last_order_minutes_before_close', r.last_order_minutes_before_close,
      'accepting_orders', r.accepting_orders, 'test_mode', r.test_mode,
      'delivery_enabled', r.delivery_enabled, 'delivery_lead_minutes', r.delivery_lead_minutes,
      'delivery_min_cents', r.delivery_min_cents, 'doordash_store_url', r.doordash_store_url),
    'popular', public.popular_names(r.id),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'description', c.description, 'note', c.note, 'hours', c.hours,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', i.id, 'ext', i.external_id, 'name', i.name, 'description', i.description, 'price_cents', i.price_cents,
            'image', i.image, 'allergens', i.allergens, 'gluten_free', i.gluten_free,
            'vegetarian', i.vegetarian, 'popular', i.popular,
            'pairs', coalesce((select jsonb_agg(p.paired_item_id order by p.sort) from public.item_pairings p where p.item_id = i.id), '[]'::jsonb),
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
