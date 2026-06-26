// Happy Paint — purge-account Edge Function (Deno / Supabase).
//
// WHAT THIS DOES
// Processes DUE account_deletion_requests (scheduled_purge_at <= now() and
// status in ('requested','processing')) and HARD-DELETES the user: all rows
// they own across the public schema, then the auth.users record via the Admin
// API. Marks each request 'completed'.
//
// HOW IT RUNS — NEVER FROM A CLIENT.
// This uses the SERVICE ROLE key (full read/write, bypasses RLS) and must only
// run server-side on a schedule or by an admin:
//   * Supabase scheduled function / pg_cron hitting this function's URL, OR
//   * a manual admin invoke.
// The client-facing path is the public.request_account_deletion() RPC, which
// only SCHEDULES deletion (30-day grace). This function performs the purge.
//
// IDEMPOTENCY
// Deletes are "delete where owner = uid" (safe to repeat). auth.admin.deleteUser
// tolerates an already-deleted user (404) — we treat that as success. If a run
// dies partway, the request stays 'processing' and the next run finishes it.
//
// DEPLOY: see ../README.md (supabase functions deploy purge-account + secrets).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Service-role secrets injected via function env (set with `supabase secrets set`).
// SUPABASE_URL is provided automatically in the function runtime.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Process at most this many due requests per invocation to keep runs bounded.
const BATCH_LIMIT = 25;

// Tables owned by a profile, keyed by the column that points at the profile id.
// Order does not matter much because most FKs are `on delete cascade` from
// profiles, but we delete explicitly so the purge is complete and auditable even
// where FKs are `on delete set null`. Deleting the profile row last would also
// cascade, but we enumerate to be explicit and resilient to schema drift.
const OWNED_TABLES: Array<{ table: string; column: string }> = [
  // Core creative data
  { table: "project_snapshots", column: "profile_id" },
  { table: "space_assets", column: "owner_profile_id" },
  { table: "space_profiles", column: "profile_id" },
  { table: "asset_packs", column: "owner_profile_id" },
  { table: "asset_uses", column: "used_by_profile_id" },
  { table: "replay_snapshots", column: "owner_profile_id" },
  { table: "timelapse_assets", column: "owner_profile_id" },
  // Economy
  { table: "wallet_ledger_entries", column: "profile_id" }, // append-only: see note below
  { table: "wallets", column: "profile_id" },
  { table: "purchase_receipts", column: "profile_id" },
  { table: "asset_products", column: "creator_profile_id" },
  { table: "creator_payouts", column: "profile_id" },
  { table: "creator_payout_accounts", column: "profile_id" },
  // AI assist
  { table: "ai_generations", column: "profile_id" },
  { table: "ai_consent", column: "profile_id" },
  { table: "ai_credits", column: "profile_id" },
  // Entitlements + social + sync
  { table: "entitlements", column: "profile_id" },
  { table: "contact_methods", column: "profile_id" },
  { table: "friend_invites", column: "inviter_profile_id" },
  { table: "session_invites", column: "inviter_profile_id" },
  { table: "session_participants", column: "profile_id" },
  { table: "gallery_votes", column: "profile_id" },
  { table: "gallery_posts", column: "created_by_profile_id" },
  { table: "verification_reviews", column: "profile_id" },
  { table: "device_sync_state", column: "profile_id" },
];

type DeletionRequest = {
  id: string;
  profile_id: string;
  status: string;
  scheduled_purge_at: string | null;
};

async function purgeProfile(
  supabase: ReturnType<typeof createClient>,
  profileId: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  // 1. Delete owned rows across the public schema.
  // NOTE: wallet_ledger_entries has before-update/before-delete triggers that
  // raise (append-only). Account deletion is a compliance carve-out: drop these
  // triggers, or run this purge in a SECURITY DEFINER SQL routine that disables
  // them, BEFORE enabling deletion in production. Documented in README.md.
  for (const { table, column } of OWNED_TABLES) {
    const { error } = await supabase.from(table).delete().eq(column, profileId);
    if (error) {
      errors.push(`${table}.${column}: ${error.message}`);
    }
  }

  // 2. friendships + tips reference the profile on two columns; clear both sides.
  for (const col of ["profile_id", "friend_profile_id"]) {
    const { error } = await supabase.from("friendships").delete().eq(col, profileId);
    if (error) errors.push(`friendships.${col}: ${error.message}`);
  }
  for (const col of ["sender_profile_id", "receiver_profile_id"]) {
    const { error } = await supabase.from("tips").delete().eq(col, profileId);
    if (error) errors.push(`tips.${col}: ${error.message}`);
  }

  // 3. Delete the profile row itself (cascades anything we missed).
  {
    const { error } = await supabase.from("profiles").delete().eq("id", profileId);
    if (error) errors.push(`profiles.id: ${error.message}`);
  }

  // 4. Delete the auth.users record (Admin API). 404 => already gone => success.
  {
    const { error } = await supabase.auth.admin.deleteUser(profileId);
    if (error && !/not\s*found|404/i.test(error.message)) {
      errors.push(`auth.admin.deleteUser: ${error.message}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

async function run(): Promise<Response> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ error: "missing SUPABASE_URL / SERVICE_ROLE_KEY" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Pull due requests.
  const { data: due, error: dueErr } = await supabase
    .from("account_deletion_requests")
    .select("id, profile_id, status, scheduled_purge_at")
    .in("status", ["requested", "processing"])
    .lte("scheduled_purge_at", new Date().toISOString())
    .order("scheduled_purge_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (dueErr) {
    return new Response(JSON.stringify({ error: dueErr.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const requests = (due ?? []) as DeletionRequest[];
  const results: Array<{ id: string; status: string; errors?: string[] }> = [];

  for (const req of requests) {
    // Mark processing first so a crash mid-purge is resumable on the next run.
    await supabase
      .from("account_deletion_requests")
      .update({ status: "processing" })
      .eq("id", req.id);

    const { ok, errors } = await purgeProfile(supabase, req.profile_id);

    if (ok) {
      // The request row may already be gone (cascaded with the profile). Best-effort
      // mark completed; ignore "no row" outcomes.
      await supabase
        .from("account_deletion_requests")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", req.id);
      results.push({ id: req.id, status: "completed" });
    } else {
      results.push({ id: req.id, status: "processing", errors });
    }
  }

  return new Response(
    JSON.stringify({ processed: requests.length, results }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

Deno.serve(() => run());
