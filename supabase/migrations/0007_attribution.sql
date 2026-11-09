-- Marketing attribution: where the guest came from (tracking script data), kept with the order or
-- reservation so the sale can be reported to the attribution service once it is final.
alter table orders       add column if not exists attribution jsonb;
alter table reservations add column if not exists attribution jsonb;
