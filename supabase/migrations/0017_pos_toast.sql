-- Toast as a POS connection (orders, sold-out sync). See supabase/functions/pos/adapters.js.
alter table public.pos_connections drop constraint pos_connections_provider_check;
alter table public.pos_connections add constraint pos_connections_provider_check check (provider in ('clover', 'square', 'toast', 'cloudprnt'));
