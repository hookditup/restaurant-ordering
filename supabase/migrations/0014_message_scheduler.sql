-- Every 5 minutes: queue due automations and scheduled campaigns, then send.
-- The key that protects ?job=tick is generated here and kept in Vault; it is never in the repo.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'ordering_job_key', 'Protects the ordering function''s message job');
create function public.job_key() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'ordering_job_key' limit 1;
$$;
revoke all on function public.job_key() from public, anon, authenticated;
grant execute on function public.job_key() to service_role;
select cron.schedule('ordering-messages', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://khvwoynoqnatcqgvoyar.supabase.co/functions/v1/ordering?job=tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-key', (select decrypted_secret from vault.decrypted_secrets where name = 'ordering_job_key')),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
$job$);
