-- Texting setup survey. Owners answer the questions carriers need for A2P 10DLC registration.
-- Anyone can submit; nobody can read back through the public API. Staff read it with the service role.
create table public.onboarding_submissions (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'a2p_10dlc' check (kind in ('a2p_10dlc')),
  business_name text not null check (length(business_name) between 1 and 200),
  data jsonb not null check (jsonb_typeof(data) = 'object' and length(data::text) < 30000),
  status text not null default 'new' check (status in ('new', 'in_review', 'submitted', 'approved', 'rejected')),
  notes text,
  created_at timestamptz not null default now()
);
alter table public.onboarding_submissions enable row level security;
create policy onboarding_insert on public.onboarding_submissions for insert to anon, authenticated
  with check (status = 'new' and notes is null);
grant insert on public.onboarding_submissions to anon, authenticated;
