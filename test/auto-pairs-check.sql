-- Checks automatic pairings on made-up orders, then rolls them back by raising the result as an error.
-- Run against the test restaurant. Expected: Tacos and the first dish pair; the dish on every order does not;
-- a pair on three orders does not; sold-out dishes and orders past pairs_days drop out; hand picks stay first.
do $$
declare rid uuid; a text := 'Tacos'; b text; c text; x text; n int; oid uuid; res jsonb := '{}'; m jsonb; made uuid[] := '{}'; pick_names jsonb;
begin
  select id into rid from public.restaurants where slug = 'lupitas-valley';
  select to_jsonb(array_agg(name)) into pick_names from (
    select distinct name from public.menu_items mi where mi.restaurant_id = rid and mi.available and mi.name <> a
      and mi.name not in (select m2.name from public.item_pairings p join public.menu_items m1 on m1.id = p.item_id join public.menu_items m2 on m2.id = p.paired_item_id where m1.name = a)
    order by name limit 3) q;
  b := pick_names->>0; c := pick_names->>1; x := pick_names->>2;
  for n in 1..43 loop
    insert into public.orders (restaurant_id, pickup_at, first_name, last_name, phone, email, subtotal_cents, tax_cents, total_cents, test_mode, status)
      values (rid, now(), 'Pair', 'Test', '+14355550100', 'test@example.com', 100, 0, 100, true, 'completed') returning id into oid;
    made := made || oid;
    insert into public.order_items (order_id, name, qty, unit_price_cents, line_total_cents) values (oid, x, 1, 100, 100);
    if n <= 6 then insert into public.order_items (order_id, name, qty, unit_price_cents, line_total_cents) values (oid, a, 1, 100, 100), (oid, b, 1, 100, 100); end if;
    if n between 7 and 8 then insert into public.order_items (order_id, name, qty, unit_price_cents, line_total_cents) values (oid, a, 1, 100, 100); end if;
    if n between 9 and 11 then insert into public.order_items (order_id, name, qty, unit_price_cents, line_total_cents) values (oid, a, 1, 100, 100), (oid, c, 1, 100, 100); end if;
  end loop;
  res := jsonb_build_object('names', pick_names, 'auto', public.auto_pairs(rid));
  m := public.get_menu('lupitas-valley');
  res := res || jsonb_build_object('tacos', (select jsonb_agg(ii->'pairs') from jsonb_array_elements(m->'categories') cc, jsonb_array_elements(cc->'items') ii where ii->>'name' = a));
  update public.menu_items set available = false where restaurant_id = rid and name = b;
  res := res || jsonb_build_object('sold_out', public.auto_pairs(rid)->a);
  update public.menu_items set available = true where restaurant_id = rid and name = b;
  update public.orders set created_at = now() - interval '100 days' where id = any(made);
  res := res || jsonb_build_object('old_orders', public.auto_pairs(rid));
  raise exception 'RESULT %', res;
end $$;
