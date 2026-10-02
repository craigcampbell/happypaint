-- =====================================================================
-- Rename the legacy UK-spelled enum value 'cancelled' to the canonical US
-- spelling 'canceled' on the three enums that carry it:
--   session_status, timed_event_status, account_deletion_status
--
-- STATUS: NOT APPLIED TO PRODUCTION.
--   This Supabase backend is the legacy/optional reference backend, the
--   production app runs on PocketBase, which has no such enum. Apply this
--   migration manually (supabase db execute / psql) to any environment that
--   actually provisioned schema.sql BEFORE the rename; fresh provisions of
--   the current schema.sql already use 'canceled' and need nothing.
--
-- Idempotent: each DO block no-ops when the 'cancelled' label is absent
-- (fresh schema, or a database where the rename already ran). Existing rows
-- are preserved in place: ALTER TYPE ... RENAME VALUE rewrites the label,
-- not the data, and works on values used by table columns.
--
-- Requires PostgreSQL 10+ (ALTER TYPE ... RENAME VALUE).
-- =====================================================================

do $$
begin
  if exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'session_status'
      and e.enumlabel = 'cancelled'
  ) then
    alter type public.session_status rename value 'cancelled' to 'canceled';
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'timed_event_status'
      and e.enumlabel = 'cancelled'
  ) then
    alter type public.timed_event_status rename value 'cancelled' to 'canceled';
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'account_deletion_status'
      and e.enumlabel = 'cancelled'
  ) then
    alter type public.account_deletion_status rename value 'cancelled' to 'canceled';
  end if;
end $$;

-- PL/pgSQL function bodies are stored as text: renaming an enum label does
-- not rewrite the deletion RPC's old string literal. Preserve the installed
-- function's security/behavior while updating that literal, if it exists.
do $$
declare
  rpc regprocedure := to_regprocedure('public.request_account_deletion()');
  definition text;
begin
  if rpc is not null then
    definition := pg_get_functiondef(rpc);
    if position('''cancelled''' in definition) > 0 then
      execute replace(definition, '''cancelled''', '''canceled''');
    end if;
  end if;
end $$;

-- Read compatibility note: clients and servers shipping before this rename
-- may still READ or WRITE the 'cancelled' spelling against an unmigrated
-- database. Application-level ingress normalization (web
-- src/utils/cancellation.js, mobile src/cancellation.js) maps 'cancelled' to
-- 'canceled' on read, so mixed-version data keeps working during the window
-- before this migration is applied to a given environment.
