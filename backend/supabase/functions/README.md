# Happy Paint Supabase Edge Functions

## `purge-account`

Hard-deletes accounts whose deletion grace window has elapsed. It is the
out-of-band counterpart to the `public.request_account_deletion()` RPC: the RPC
(called by the web/mobile clients) only **schedules** deletion (status
`requested`, `scheduled_purge_at = now() + 30 days`). This function performs the
actual purge.

It uses the **service role key** and bypasses RLS, so it must only ever run
server-side — on a schedule or via an admin invoke. It is never callable by a
normal client.

### Behavior

Processes due `account_deletion_requests` (`scheduled_purge_at <= now()`, status
`requested`/`processing`), marks each `processing`, deletes the user's rows
across the public schema, calls `auth.admin.deleteUser(profile_id)`, then marks
the request `completed`. Idempotent and resumable (re-running finishes any
request left `processing`).

### Deploy

```sh
# from repo root
supabase functions deploy purge-account

# Set the service-role secret (Project Settings → API → service_role key).
# SUPABASE_URL is injected automatically by the function runtime.
supabase secrets set SERVICE_ROLE_KEY="<your-service-role-key>"
```

### Schedule it

Run on a cron (daily is plenty for a 30-day grace window). Either:

- **pg_cron + pg_net** calling the function URL with the service-role bearer:

  ```sql
  select cron.schedule(
    'purge-account-daily',
    '17 3 * * *', -- 03:17 UTC daily
    $$
    select net.http_post(
      url     := 'https://<project-ref>.functions.supabase.co/purge-account',
      headers := jsonb_build_object(
        'Authorization', 'Bearer <service-role-key>',
        'Content-Type', 'application/json'
      )
    );
    $$
  );
  ```

- or a **Supabase scheduled function** / external scheduler hitting the same URL.

### Before enabling in production

`wallet_ledger_entries` has append-only triggers (`block_ledger_mutation`) that
raise on UPDATE/DELETE. Account deletion is a compliance carve-out: either drop
those triggers for the purge, or wrap the ledger delete in a `SECURITY DEFINER`
SQL routine that disables them for the operation. See the note in
`purge-account/index.ts`.
