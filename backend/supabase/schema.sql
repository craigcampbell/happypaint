-- Happy Paint social backend reference schema.
-- Designed for invite-only rooms, scheduled sessions, optional accounts, and child-safe defaults.

create extension if not exists pgcrypto;

create type profile_kind as enum ('adult', 'teen', 'child', 'guardian_managed');
create type invite_status as enum ('pending', 'accepted', 'declined', 'expired', 'revoked');
create type session_status as enum ('planned', 'open', 'ended', 'cancelled');
create type participant_role as enum ('host', 'artist', 'viewer', 'guest', 'guardian', 'teacher', 'moderator');
create type room_audience as enum ('kid_safe', 'friends', 'adult_18');
create type room_visibility as enum ('private', 'listed_preview', 'featured', 'suppressed');
create type media_source_type as enum ('library', 'upload', 'link', 'gif', 'embed');
create type media_safety_status as enum ('approved', 'pending', 'blocked');
create type admin_scope as enum ('owner', 'moderator', 'library_curator', 'support', 'trust_safety');
create type moderation_report_status as enum ('open', 'reviewing', 'resolved', 'dismissed', 'escalated');
create type verification_review_kind as enum ('guardian_consent', 'adult_verification', 'teacher_approval');
create type verification_review_status as enum ('pending', 'approved', 'rejected', 'needs_more_info');
create type ban_scope as enum ('all_access', 'rooms', 'uploads', 'social', 'adult_rooms');
create type network_block_action as enum ('deny', 'challenge', 'rate_limit');
create type timed_event_status as enum ('draft', 'upcoming', 'live', 'voting', 'ended', 'cancelled');
create type gallery_visibility as enum ('private', 'public', 'featured', 'suppressed');
create type gallery_post_status as enum ('pending', 'approved', 'rejected', 'removed');
create type room_event_type as enum (
  'session_created',
  'join_attempt',
  'participant_joined',
  'participant_left',
  'role_requested',
  'role_changed',
  'stroke_commit',
  'stroke_preview',
  'media_added',
  'media_blocked',
  'media_removed',
  'discovery_preview_opened',
  'gallery_posted',
  'gallery_vote_cast',
  'event_joined',
  'room_locked',
  'room_unlocked',
  'admin_observe_start',
  'admin_observe_end',
  'export_log',
  'report_created'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  profile_kind profile_kind not null default 'teen',
  birth_year integer,
  guardian_profile_id uuid references public.profiles(id) on delete set null,
  guardian_consent_at timestamptz,
  adult_verified_at timestamptz,
  allow_contact_discovery boolean not null default false,
  allow_friend_invites boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contact_methods (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('email', 'phone')),
  -- Store normalized contact hashes, not raw email/phone, for matching and recovery flows.
  contact_hash text not null,
  verified_at timestamptz,
  guardian_approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (kind, contact_hash)
);

create table public.admin_roles (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  scope admin_scope not null,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (profile_id, scope)
);

create table public.profile_bans (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  banned_by_profile_id uuid references public.profiles(id) on delete set null,
  scope ban_scope not null default 'rooms',
  reason text not null check (char_length(reason) between 8 and 240),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at)
);

create table public.network_blocks (
  id uuid primary key default gen_random_uuid(),
  ip_network cidr not null,
  action network_block_action not null default 'challenge',
  reason text not null check (char_length(reason) between 8 and 240),
  provider text not null default 'manual',
  provider_rule_id text,
  created_by_profile_id uuid references public.profiles(id) on delete set null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at)
);

create table public.network_abuse_events (
  id bigint generated always as identity primary key,
  profile_id uuid references public.profiles(id) on delete set null,
  ip_hash text,
  ip_network cidr,
  route text not null,
  signal text not null,
  request_count integer not null default 1,
  window_seconds integer not null default 60,
  user_agent_hash text,
  action_taken network_block_action,
  created_at timestamptz not null default now()
);

create table public.friend_invites (
  id uuid primary key default gen_random_uuid(),
  inviter_profile_id uuid not null references public.profiles(id) on delete cascade,
  invite_code text not null unique check (invite_code ~ '^[A-Z0-9]{6,10}$'),
  recipient_profile_id uuid references public.profiles(id) on delete cascade,
  status invite_status not null default 'pending',
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create table public.friendships (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  friend_profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, friend_profile_id),
  check (profile_id <> friend_profile_id)
);

create table public.paint_sessions (
  id uuid primary key default gen_random_uuid(),
  host_profile_id uuid references public.profiles(id) on delete set null,
  room_code text not null unique check (room_code ~ '^[A-Z0-9]{6,10}$'),
  title text not null default 'Happy Paint Session',
  theme text not null default 'Free draw',
  topic text not null default 'Free draw together',
  tags text[] not null default '{}',
  audience room_audience not null default 'kid_safe',
  visibility room_visibility not null default 'private',
  preview_snapshot_url text,
  safe_library_only boolean not null default true,
  adult_verified_required boolean not null default false,
  status session_status not null default 'planned',
  starts_at timestamptz,
  ends_at timestamptz,
  invite_only boolean not null default true,
  max_participants integer not null default 6 check (max_participants between 1 and 24),
  artist_slots integer not null default 4 check (artist_slots between 1 and 24),
  viewer_slots integer not null default 20 check (viewer_slots between 0 and 500),
  allow_viewer_reactions boolean not null default true,
  host_approval_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (audience <> 'kid_safe' or safe_library_only),
  check (audience <> 'adult_18' or adult_verified_required),
  check (audience <> 'adult_18' or visibility = 'private'),
  check (artist_slots + viewer_slots >= max_participants)
);

create table public.media_library_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_type media_source_type not null default 'library',
  asset_url text not null,
  thumbnail_url text,
  tags text[] not null default '{}',
  min_profile_kind profile_kind not null default 'child',
  safety_status media_safety_status not null default 'approved',
  created_at timestamptz not null default now()
);

create table public.session_invites (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.paint_sessions(id) on delete cascade,
  inviter_profile_id uuid references public.profiles(id) on delete set null,
  invite_code text not null unique check (invite_code ~ '^[A-Z0-9]{6,10}$'),
  recipient_profile_id uuid references public.profiles(id) on delete cascade,
  status invite_status not null default 'pending',
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create table public.session_participants (
  session_id uuid not null references public.paint_sessions(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role participant_role not null default 'viewer',
  joined_at timestamptz not null default now(),
  role_requested_at timestamptz not null default now(),
  role_approved_at timestamptz,
  role_approved_by_profile_id uuid references public.profiles(id) on delete set null,
  last_seen_at timestamptz,
  muted_until timestamptz,
  primary key (session_id, profile_id)
);

create table public.session_media_assets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.paint_sessions(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  library_item_id uuid references public.media_library_items(id) on delete set null,
  source_type media_source_type not null,
  source_url text,
  title text,
  safety_status media_safety_status not null default 'pending',
  trusted_provider text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  check (
    source_type <> 'library'
    or (library_item_id is not null and source_url is null)
  )
);

create table public.room_observation_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.paint_sessions(id) on delete cascade,
  admin_profile_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 8 and 160),
  presence_visible boolean not null default false,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.room_event_log (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.paint_sessions(id) on delete cascade,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  actor_is_admin boolean not null default false,
  event_type room_event_type not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.moderation_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_profile_id uuid references public.profiles(id) on delete set null,
  subject_profile_id uuid references public.profiles(id) on delete set null,
  session_id uuid references public.paint_sessions(id) on delete cascade,
  media_asset_id uuid references public.session_media_assets(id) on delete cascade,
  reason text not null check (char_length(reason) between 3 and 80),
  detail text,
  priority integer not null default 2 check (priority between 1 and 5),
  status moderation_report_status not null default 'open',
  assigned_admin_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.moderation_reports(id) on delete set null,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  action_type text not null check (action_type in ('approve_media', 'block_media', 'lock_room', 'unlock_room', 'remove_participant', 'change_participant_role', 'escalate', 'dismiss_report', 'start_observe', 'end_observe', 'export_room_log', 'approve_discovery_listing', 'suppress_discovery_listing', 'approve_event', 'lock_event', 'feature_gallery_post', 'unfeature_gallery_post', 'reset_gallery_votes', 'ban_profile', 'unban_profile', 'block_network', 'unblock_network', 'challenge_network', 'rate_limit_network')),
  target_table text not null check (target_table in ('profiles', 'paint_sessions', 'session_participants', 'session_media_assets', 'media_library_items', 'moderation_reports', 'room_observation_sessions', 'room_discovery_snapshots', 'timed_events', 'gallery_posts', 'gallery_votes', 'profile_bans', 'network_blocks')),
  target_id uuid not null,
  note text,
  created_at timestamptz not null default now()
);

create table public.verification_reviews (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind verification_review_kind not null,
  status verification_review_status not null default 'pending',
  reviewer_profile_id uuid references public.profiles(id) on delete set null,
  evidence_payload jsonb not null default '{}',
  decision_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table public.timed_events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 3 and 80),
  theme text not null check (char_length(theme) between 3 and 180),
  description text not null default '',
  tags text[] not null default '{}',
  audience room_audience not null default 'kid_safe',
  status timed_event_status not null default 'draft',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  voting_starts_at timestamptz,
  voting_ends_at timestamptz,
  created_by_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (voting_ends_at is null or voting_starts_at is not null),
  check (voting_ends_at is null or voting_ends_at > voting_starts_at),
  check (audience <> 'adult_18' or status in ('draft', 'cancelled'))
);

create table public.room_discovery_snapshots (
  session_id uuid primary key references public.paint_sessions(id) on delete cascade,
  title text not null,
  topic text not null,
  tags text[] not null default '{}',
  audience room_audience not null,
  visibility room_visibility not null default 'listed_preview',
  session_status session_status not null,
  preview_snapshot_url text,
  search_text text not null default '',
  artist_count integer not null default 0 check (artist_count >= 0),
  artist_slots integer not null default 4 check (artist_slots >= 0),
  viewer_count integer not null default 0 check (viewer_count >= 0),
  viewer_slots integer not null default 20 check (viewer_slots >= 0),
  featured_score numeric not null default 0,
  safety_status media_safety_status not null default 'pending',
  reviewed_by_profile_id uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (audience <> 'adult_18'),
  check (visibility <> 'featured' or safety_status = 'approved')
);

create table public.gallery_posts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.paint_sessions(id) on delete cascade,
  event_id uuid references public.timed_events(id) on delete set null,
  created_by_profile_id uuid references public.profiles(id) on delete set null,
  title text not null check (char_length(title) between 2 and 80),
  description text not null default '',
  image_url text not null,
  thumbnail_url text,
  tags text[] not null default '{}',
  visibility gallery_visibility not null default 'public',
  status gallery_post_status not null default 'pending',
  safety_status media_safety_status not null default 'pending',
  votes_count integer not null default 0 check (votes_count >= 0),
  featured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility <> 'featured' or status = 'approved')
);

create table public.event_entries (
  event_id uuid not null references public.timed_events(id) on delete cascade,
  session_id uuid not null references public.paint_sessions(id) on delete cascade,
  gallery_post_id uuid references public.gallery_posts(id) on delete set null,
  created_by_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (event_id, session_id)
);

create table public.gallery_votes (
  post_id uuid not null references public.gallery_posts(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  value smallint not null default 1 check (value = 1),
  device_hash text,
  created_at timestamptz not null default now(),
  primary key (post_id, profile_id)
);

create table public.gallery_vote_audit_events (
  id bigint generated always as identity primary key,
  post_id uuid references public.gallery_posts(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  device_hash text,
  ip_hash text,
  signal text not null,
  request_count integer not null default 1,
  window_seconds integer not null default 60,
  action_taken network_block_action,
  created_at timestamptz not null default now()
);

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_roles
    where profile_id = auth.uid()
  );
$$;

create function public.is_owner_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_roles
    where profile_id = auth.uid() and scope = 'owner'
  );
$$;

create table public.stroke_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.paint_sessions(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  client_event_id text not null,
  brush text not null,
  color text not null,
  opacity numeric not null,
  size numeric not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, client_event_id)
);

alter table public.profiles enable row level security;
alter table public.admin_roles enable row level security;
alter table public.profile_bans enable row level security;
alter table public.network_blocks enable row level security;
alter table public.network_abuse_events enable row level security;
alter table public.contact_methods enable row level security;
alter table public.friend_invites enable row level security;
alter table public.friendships enable row level security;
alter table public.paint_sessions enable row level security;
alter table public.session_invites enable row level security;
alter table public.session_participants enable row level security;
alter table public.media_library_items enable row level security;
alter table public.session_media_assets enable row level security;
alter table public.room_observation_sessions enable row level security;
alter table public.room_event_log enable row level security;
alter table public.moderation_reports enable row level security;
alter table public.moderation_actions enable row level security;
alter table public.verification_reviews enable row level security;
alter table public.timed_events enable row level security;
alter table public.room_discovery_snapshots enable row level security;
alter table public.gallery_posts enable row level security;
alter table public.event_entries enable row level security;
alter table public.gallery_votes enable row level security;
alter table public.gallery_vote_audit_events enable row level security;
alter table public.stroke_events enable row level security;

create policy "profiles self read"
  on public.profiles for select
  using (auth.uid() = id or guardian_profile_id = auth.uid() or public.is_admin());

create policy "profiles self update"
  on public.profiles for update
  using (auth.uid() = id or guardian_profile_id = auth.uid());

create policy "admin roles admin read"
  on public.admin_roles for select
  using (profile_id = auth.uid() or public.is_admin());

create policy "admin roles owner manage"
  on public.admin_roles for all
  using (public.is_owner_admin())
  with check (public.is_owner_admin());

create policy "profile bans self or admin read"
  on public.profile_bans for select
  using (profile_id = auth.uid() or public.is_admin());

create policy "profile bans admin manage"
  on public.profile_bans for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "network blocks admin only"
  on public.network_blocks for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "network abuse admin read"
  on public.network_abuse_events for select
  using (public.is_admin());

create policy "network abuse system insert"
  on public.network_abuse_events for insert
  with check (public.is_admin());

create policy "contacts owner only"
  on public.contact_methods for all
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

create policy "friend invites participants"
  on public.friend_invites for select
  using (auth.uid() = inviter_profile_id or auth.uid() = recipient_profile_id);

create policy "friend invites create self"
  on public.friend_invites for insert
  with check (auth.uid() = inviter_profile_id);

create policy "friendships participants"
  on public.friendships for select
  using (auth.uid() = profile_id or auth.uid() = friend_profile_id);

create policy "sessions participants read"
  on public.paint_sessions for select
  using (
    public.is_admin()
    or
    host_profile_id = auth.uid()
    or exists (
      select 1 from public.session_participants sp
      where sp.session_id = paint_sessions.id and sp.profile_id = auth.uid()
    )
  );

create policy "sessions host create"
  on public.paint_sessions for insert
  with check (
    auth.uid() = host_profile_id
    and not exists (
      select 1 from public.profile_bans pb
      where pb.profile_id = auth.uid()
        and pb.revoked_at is null
        and (pb.expires_at is null or pb.expires_at > now())
        and (
          pb.scope in ('all_access', 'rooms')
          or (paint_sessions.audience = 'adult_18' and pb.scope = 'adult_rooms')
        )
    )
  );

create policy "sessions host update"
  on public.paint_sessions for update
  using (auth.uid() = host_profile_id or public.is_admin());

create policy "session invites participants"
  on public.session_invites for select
  using (auth.uid() = inviter_profile_id or auth.uid() = recipient_profile_id);

create policy "session invites create self"
  on public.session_invites for insert
  with check (auth.uid() = inviter_profile_id);

create policy "participants same session read"
  on public.session_participants for select
  using (
    public.is_admin()
    or profile_id = auth.uid()
    or exists (
      select 1 from public.session_participants mine
      where mine.session_id = session_participants.session_id and mine.profile_id = auth.uid()
    )
  );

create policy "participants join self"
  on public.session_participants for insert
  with check (
    auth.uid() = profile_id
    and not exists (
      select 1 from public.profile_bans pb
      where pb.profile_id = auth.uid()
        and pb.revoked_at is null
        and (pb.expires_at is null or pb.expires_at > now())
        and pb.scope in ('all_access', 'rooms', 'social')
    )
    and exists (
      select 1
      from public.paint_sessions ps
      join public.profiles p on p.id = auth.uid()
      where ps.id = session_participants.session_id
        and ps.status in ('planned', 'open')
        and (
          ps.host_profile_id = auth.uid()
          or ps.invite_only = false
          or exists (
            select 1
            from public.session_invites si
            where si.session_id = ps.id
              and si.recipient_profile_id = auth.uid()
              and si.status = 'accepted'
              and si.expires_at > now()
          )
        )
        and (
          select count(*)
          from public.session_participants existing
          where existing.session_id = ps.id
        ) < ps.max_participants
        and (
          (session_participants.role = 'host' and ps.host_profile_id = auth.uid())
          or session_participants.role in ('viewer', 'guest')
        )
        and (
          session_participants.role <> 'viewer'
          or (
            select count(*)
            from public.session_participants viewers
            where viewers.session_id = ps.id and viewers.role = 'viewer'
          ) < ps.viewer_slots
        )
        and (
          ps.audience <> 'adult_18'
          or (p.profile_kind = 'adult' and p.adult_verified_at is not null)
        )
        and not exists (
          select 1 from public.profile_bans adult_pb
          where adult_pb.profile_id = auth.uid()
            and adult_pb.revoked_at is null
            and (adult_pb.expires_at is null or adult_pb.expires_at > now())
            and adult_pb.scope = 'adult_rooms'
            and ps.audience = 'adult_18'
        )
    )
  );

create policy "participants host role update"
  on public.session_participants for update
  using (
    public.is_admin()
    or exists (
      select 1 from public.paint_sessions ps
      where ps.id = session_participants.session_id and ps.host_profile_id = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.paint_sessions ps
      where ps.id = session_participants.session_id
        and ps.host_profile_id = auth.uid()
        and (
          session_participants.role not in ('host', 'artist', 'teacher')
          or (
            select count(*)
            from public.session_participants artists
            where artists.session_id = ps.id and artists.role in ('host', 'artist', 'teacher')
          ) <= ps.artist_slots
        )
        and (
          session_participants.role <> 'viewer'
          or (
            select count(*)
            from public.session_participants viewers
            where viewers.session_id = ps.id and viewers.role = 'viewer'
          ) <= ps.viewer_slots
        )
    )
  );

create policy "approved media library read"
  on public.media_library_items for select
  using (safety_status = 'approved' or public.is_admin());

create policy "media library admin manage"
  on public.media_library_items for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "session media participants read"
  on public.session_media_assets for select
  using (
    public.is_admin()
    or
    exists (
      select 1 from public.session_participants sp
      where sp.session_id = session_media_assets.session_id and sp.profile_id = auth.uid()
    )
  );

create policy "session media admin manage"
  on public.session_media_assets for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "reports create self"
  on public.moderation_reports for insert
  with check (auth.uid() = reporter_profile_id);

create policy "reports reporter or admin read"
  on public.moderation_reports for select
  using (auth.uid() = reporter_profile_id or public.is_admin());

create policy "reports admin update"
  on public.moderation_reports for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "moderation actions admin only"
  on public.moderation_actions for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "verification reviews self or admin read"
  on public.verification_reviews for select
  using (auth.uid() = profile_id or public.is_admin());

create policy "verification reviews self create"
  on public.verification_reviews for insert
  with check (auth.uid() = profile_id);

create policy "verification reviews admin update"
  on public.verification_reviews for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "timed events public read"
  on public.timed_events for select
  using (
    public.is_admin()
    or (
      audience <> 'adult_18'
      and status in ('upcoming', 'live', 'voting', 'ended')
    )
  );

create policy "timed events admin manage"
  on public.timed_events for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "room discovery approved public read"
  on public.room_discovery_snapshots for select
  using (
    public.is_admin()
    or (
      audience <> 'adult_18'
      and visibility in ('listed_preview', 'featured')
      and session_status in ('planned', 'open')
      and safety_status = 'approved'
    )
  );

create policy "room discovery admin manage"
  on public.room_discovery_snapshots for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "gallery posts public read"
  on public.gallery_posts for select
  using (
    public.is_admin()
    or (
      visibility in ('public', 'featured')
      and status = 'approved'
      and safety_status = 'approved'
      and exists (
        select 1 from public.paint_sessions ps
        where ps.id = gallery_posts.session_id and ps.audience <> 'adult_18'
      )
      and (
        event_id is null
        or exists (
          select 1 from public.timed_events te
          where te.id = gallery_posts.event_id and te.audience <> 'adult_18'
        )
      )
    )
  );

create policy "gallery posts artists create"
  on public.gallery_posts for insert
  with check (
    auth.uid() = created_by_profile_id
    and not exists (
      select 1 from public.profile_bans pb
      where pb.profile_id = auth.uid()
        and pb.revoked_at is null
        and (pb.expires_at is null or pb.expires_at > now())
        and pb.scope in ('all_access', 'uploads', 'social')
    )
    and exists (
      select 1 from public.session_participants sp
      where sp.session_id = gallery_posts.session_id
        and sp.profile_id = auth.uid()
        and sp.role in ('host', 'artist', 'teacher')
    )
  );

create policy "gallery posts admin manage"
  on public.gallery_posts for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "event entries public read"
  on public.event_entries for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.timed_events te
      where te.id = event_entries.event_id
        and te.audience <> 'adult_18'
        and te.status in ('upcoming', 'live', 'voting', 'ended')
    )
  );

create policy "event entries participants create"
  on public.event_entries for insert
  with check (
    auth.uid() = created_by_profile_id
    and exists (
      select 1 from public.session_participants sp
      where sp.session_id = event_entries.session_id
        and sp.profile_id = auth.uid()
        and sp.role in ('host', 'artist', 'teacher')
    )
    and exists (
      select 1 from public.timed_events te
      where te.id = event_entries.event_id
        and te.audience <> 'adult_18'
        and te.status in ('upcoming', 'live')
    )
  );

create policy "event entries admin manage"
  on public.event_entries for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "gallery votes self or admin read"
  on public.gallery_votes for select
  using (profile_id = auth.uid() or public.is_admin());

create policy "gallery votes create self"
  on public.gallery_votes for insert
  with check (
    auth.uid() = profile_id
    and not exists (
      select 1 from public.profile_bans pb
      where pb.profile_id = auth.uid()
        and pb.revoked_at is null
        and (pb.expires_at is null or pb.expires_at > now())
        and pb.scope in ('all_access', 'social')
    )
    and exists (
      select 1
      from public.gallery_posts gp
      join public.paint_sessions ps on ps.id = gp.session_id
      left join public.timed_events te on te.id = gp.event_id
      where gp.id = gallery_votes.post_id
        and gp.visibility in ('public', 'featured')
        and gp.status = 'approved'
        and gp.safety_status = 'approved'
        and ps.audience <> 'adult_18'
        and (
          gp.event_id is null
          or (
            te.audience <> 'adult_18'
            and te.status = 'voting'
            and (te.voting_starts_at is null or te.voting_starts_at <= now())
            and (te.voting_ends_at is null or te.voting_ends_at > now())
          )
        )
    )
  );

create policy "gallery vote audit admin only"
  on public.gallery_vote_audit_events for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "session media participants create"
  on public.session_media_assets for insert
  with check (
    auth.uid() = profile_id
    and not exists (
      select 1 from public.profile_bans pb
      where pb.profile_id = auth.uid()
        and pb.revoked_at is null
        and (pb.expires_at is null or pb.expires_at > now())
        and pb.scope in ('all_access', 'uploads')
    )
    and exists (
      select 1 from public.session_participants sp
      where sp.session_id = session_media_assets.session_id
        and sp.profile_id = auth.uid()
        and sp.role in ('host', 'artist', 'teacher')
    )
    and exists (
      select 1
      from public.paint_sessions ps
      where ps.id = session_media_assets.session_id
        and (
          ps.audience <> 'kid_safe'
          or (
            session_media_assets.source_type = 'library'
            and session_media_assets.safety_status = 'approved'
            and session_media_assets.library_item_id is not null
          )
        )
        and (
          ps.audience <> 'adult_18'
          or exists (
            select 1 from public.profiles p
            where p.id = auth.uid()
              and p.profile_kind = 'adult'
              and p.adult_verified_at is not null
          )
        )
    )
  );

create policy "room observation admin only"
  on public.room_observation_sessions for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "room event log admin read"
  on public.room_event_log for select
  using (public.is_admin());

create policy "room event log participants insert"
  on public.room_event_log for insert
  with check (
    (
      auth.uid() = actor_profile_id
      and exists (
        select 1 from public.session_participants sp
        where sp.session_id = room_event_log.session_id and sp.profile_id = auth.uid()
      )
      and actor_is_admin = false
    )
    or (
      public.is_admin()
      and actor_is_admin = true
    )
  );

create policy "stroke events participants read"
  on public.stroke_events for select
  using (
    public.is_admin()
    or
    exists (
      select 1 from public.session_participants sp
      where sp.session_id = stroke_events.session_id and sp.profile_id = auth.uid()
    )
  );

create policy "stroke events participants create"
  on public.stroke_events for insert
  with check (
    auth.uid() = profile_id
    and exists (
      select 1 from public.session_participants sp
      where sp.session_id = stroke_events.session_id
        and sp.profile_id = auth.uid()
        and sp.role in ('host', 'artist', 'teacher')
    )
  );

create index contact_methods_profile_id_idx on public.contact_methods(profile_id);
create index admin_roles_profile_scope_idx on public.admin_roles(profile_id, scope);
create index profile_bans_profile_active_idx on public.profile_bans(profile_id, expires_at) where revoked_at is null;
create index network_blocks_network_active_idx on public.network_blocks(ip_network, expires_at) where revoked_at is null;
create index network_abuse_events_route_idx on public.network_abuse_events(route, created_at);
create index friend_invites_inviter_idx on public.friend_invites(inviter_profile_id);
create index paint_sessions_visibility_idx on public.paint_sessions(visibility, audience, status);
create index paint_sessions_tags_idx on public.paint_sessions using gin(tags);
create index session_invites_session_idx on public.session_invites(session_id);
create index session_participants_profile_idx on public.session_participants(profile_id);
create index session_participants_role_idx on public.session_participants(session_id, role);
create index media_library_items_safety_idx on public.media_library_items(safety_status);
create index session_media_assets_session_idx on public.session_media_assets(session_id, created_at);
create index room_observation_sessions_session_idx on public.room_observation_sessions(session_id, started_at);
create index room_observation_sessions_admin_idx on public.room_observation_sessions(admin_profile_id, started_at);
create index room_event_log_session_idx on public.room_event_log(session_id, id);
create index room_event_log_type_idx on public.room_event_log(event_type, created_at);
create index moderation_reports_status_priority_idx on public.moderation_reports(status, priority, created_at);
create index moderation_actions_report_idx on public.moderation_actions(report_id, created_at);
create index verification_reviews_status_idx on public.verification_reviews(status, created_at);
create index timed_events_status_window_idx on public.timed_events(status, starts_at, ends_at);
create index timed_events_tags_idx on public.timed_events using gin(tags);
create index room_discovery_public_idx on public.room_discovery_snapshots(visibility, safety_status, featured_score desc);
create index room_discovery_tags_idx on public.room_discovery_snapshots using gin(tags);
create index room_discovery_search_idx on public.room_discovery_snapshots using gin(to_tsvector('english', search_text));
create index gallery_posts_public_idx on public.gallery_posts(visibility, status, safety_status, votes_count desc);
create index gallery_posts_event_idx on public.gallery_posts(event_id, votes_count desc);
create index gallery_posts_tags_idx on public.gallery_posts using gin(tags);
create index event_entries_session_idx on public.event_entries(session_id);
create unique index gallery_votes_device_idx on public.gallery_votes(post_id, device_hash) where device_hash is not null;
create index gallery_vote_audit_post_idx on public.gallery_vote_audit_events(post_id, created_at);
create index stroke_events_session_id_idx on public.stroke_events(session_id, id);
