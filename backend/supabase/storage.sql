-- Happy Paint storage buckets + RLS policies.
-- Run AFTER schema.sql (Supabase Dashboard → SQL Editor, or psql).
--
-- Convention: every object a user owns is stored under a top-level folder named
-- by their auth.uid() / profile id, i.e. the object path is "<uid>/<...>".
-- storage.foldername(name)[1] is that first path segment. Policies compare it to
-- auth.uid() so a user can read/write ONLY their own folder. This mirrors the
-- no-public-people-search posture in docs/social-backend.md: private creative
-- data is owner-only; public read is granted ONLY where content is meant to be
-- shared (approved gallery/timelapse previews).
--
-- Buckets:
--   artwork  (private)  drawing autosaves + gallery-source PNGs, owner-only.
--   replay   (private)  per-snapshot timelapse/replay frames, owner-only.
--   previews (public-read) approved gallery thumbnails + timelapse previews that
--                         are safe to surface publicly; writes still owner-only.

-- ---------------------------------------------------------------------
-- Buckets (idempotent).
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values
  ('artwork', 'artwork', false),
  ('replay', 'replay', false),
  ('previews', 'previews', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- artwork: strictly owner-only (private drawing + gallery-source images).
-- ---------------------------------------------------------------------
create policy "artwork owner read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'artwork'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "artwork owner insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'artwork'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "artwork owner update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'artwork'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'artwork'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "artwork owner delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'artwork'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------
-- replay: strictly owner-only (timelapse/replay snapshot frames).
-- ---------------------------------------------------------------------
create policy "replay owner read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'replay'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "replay owner insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'replay'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "replay owner update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'replay'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'replay'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "replay owner delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'replay'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------
-- previews: PUBLIC READ (approved gallery thumbnails / timelapse previews),
-- but writes remain owner-only. Only put already-approved, shareable content
-- here; safety review lives in gallery_posts/timelapse_assets.safety_status.
-- ---------------------------------------------------------------------
create policy "previews public read"
  on storage.objects for select
  using (bucket_id = 'previews');

create policy "previews owner insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'previews'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "previews owner update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'previews'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'previews'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "previews owner delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'previews'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
