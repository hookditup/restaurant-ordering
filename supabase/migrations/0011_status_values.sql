-- Allow seated/no-show reservations and partly refunded orders. Existing rows already fit.
alter table public.reservations drop constraint reservations_status_check;
alter table public.reservations add constraint reservations_status_check check (status in ('requested', 'confirmed', 'declined', 'cancelled', 'seated', 'no_show'));
alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check check (payment_status in ('unpaid', 'paid', 'test_paid', 'gift_card', 'refunded', 'partly_refunded', 'failed'));
