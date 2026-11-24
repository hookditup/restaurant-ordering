-- Reservations taken by the AI phone host: the caller may not give an email.
alter table public.reservations alter column email drop not null;

-- Move a reservation to another day/time and/or party size, if there is room (its own seats don't count against it).
create function public.res_move(rid uuid, res_id uuid, d date, m int, g int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.restaurants; rec public.reservations; slot jsonb; was text;
begin
  select * into r from public.restaurants where id = rid;
  select * into rec from public.reservations where id = res_id and restaurant_id = rid for update;
  if rec.id is null or rec.status not in ('requested', 'confirmed') then return jsonb_build_object('ok', false, 'error', 'Reservation not found.'); end if;
  perform pg_advisory_xact_lock(hashtextextended(rid::text || d::text, 0));
  was := rec.status;
  update public.reservations set status = 'cancelled' where id = rec.id;   -- so its own seats are free while we look
  select s into slot from jsonb_array_elements(public.res_day(rid, d)) s where (s ->> 'min')::int = m;
  if slot is null or (g <= r.res_max_online and (slot ->> 'left')::int < g) then
    update public.reservations set status = was where id = rec.id;
    return jsonb_build_object('ok', false, 'error', 'That time is full.');
  end if;
  update public.reservations set res_date = d, start_min = m, res_time = public.res_label(m), guests = g, party_size = g::text,
    large_party = g > r.res_max_online, status = case when g > r.res_max_online then 'requested' else was end, handled_by = 'Phone host'
  where id = rec.id returning * into rec;
  return jsonb_build_object('ok', true, 'id', rec.id, 'status', rec.status, 'date', rec.res_date, 'label', rec.res_time, 'guests', rec.guests);
end $$;
revoke all on function public.res_move(uuid, uuid, date, int, int) from public, anon, authenticated;
grant execute on function public.res_move(uuid, uuid, date, int, int) to service_role;
