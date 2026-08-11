-- Sat Space, 2026-08-11
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once.


-- ---------------------------------------------------------------------------
-- 1. Rate limiting
-- ---------------------------------------------------------------------------
-- One row per request to a protected endpoint, used to count how often a
-- single visitor is hitting it.
--
-- client_hash is a one-way fingerprint of the visitor's IP address, never the
-- address itself. The same visitor always produces the same fingerprint, so
-- counting works, but the value cannot be turned back into an IP address.
-- Rows older than an hour are deleted automatically by the API.

create table if not exists public.rate_limits (
  id          bigserial primary key,
  bucket      text not null,
  client_hash text not null,
  created_at  timestamptz not null default now()
);

create index if not exists rate_limits_lookup
  on public.rate_limits (bucket, client_hash, created_at desc);

-- Nothing but the backend should ever see this table.
alter table public.rate_limits enable row level security;

-- Tables created from raw SQL do not get Supabase's automatic role grants, so
-- these have to be explicit or the API fails with permission denied (42501).
grant select, insert, delete on public.rate_limits to service_role;
grant usage, select on sequence public.rate_limits_id_seq to service_role;


-- ---------------------------------------------------------------------------
-- 2. Allow the new "expired" purchase status
-- ---------------------------------------------------------------------------
-- Reservations nobody paid for now move to "expired" and hand their slots
-- back, instead of holding them for the rest of the campaign. They are marked
-- rather than deleted so there is still a record of what happened.
--
-- If purchases.status has a CHECK constraint listing the allowed values, then
-- "expired" has to be added to it or every expiry fails. This block finds such
-- a constraint whatever it happens to be named, drops it, and puts back a
-- complete one. If there was no constraint, it simply adds a good one.

do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'purchases'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    execute format('alter table public.purchases drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.purchases
  add constraint purchases_status_check
  check (status in ('pending', 'paid', 'approved', 'rejected', 'expired'));
