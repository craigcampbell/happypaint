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

-- =====================================================================
-- Paint Spaces, Assets, and Remix Lineage (docs/product-research.md §Paint Spaces)
-- Personal creative locker: profile identity, reusable assets, packs, usage, remix history.
-- =====================================================================

create type space_visibility as enum ('private', 'friends', 'public', 'featured');
create type space_age_band as enum ('under_13', 'teen', 'adult');
create type space_asset_kind as enum ('sticker', 'meme_template', 'loop', 'brush', 'palette', 'stamp', 'paper', 'room_theme');
create type asset_remix_permission as enum ('none', 'friends', 'public');
create type asset_pack_status as enum ('draft', 'pending', 'approved', 'rejected');
create type asset_use_context as enum ('canvas', 'room', 'export', 'remix');
create type remix_node_kind as enum ('space_asset', 'asset_pack', 'gallery_post', 'paint_session', 'project_snapshot');

create table public.space_profiles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  -- Self/forward reference to an owned space_asset used as the avatar; nullable.
  avatar_asset_id uuid,
  age_band space_age_band not null default 'teen',
  visibility space_visibility not null default 'private',
  guardian_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Under-13 spaces cannot be publicly discoverable and require a guardian.
  check (age_band <> 'under_13' or visibility in ('private', 'friends')),
  check (age_band <> 'under_13' or guardian_profile_id is not null)
);

create table public.space_assets (
  id uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references public.profiles(id) on delete cascade,
  kind space_asset_kind not null,
  title text not null check (char_length(title) between 1 and 80),
  -- Holds brush recipe / palette colors / loop frames metadata / sticker ref, etc.
  payload jsonb not null default '{}',
  thumbnail_url text,
  age_rating space_age_band not null default 'teen',
  remix_permission asset_remix_permission not null default 'none',
  visibility space_visibility not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Resolve the deferred avatar self/forward reference now that space_assets exists.
alter table public.space_profiles
  add constraint space_profiles_avatar_asset_fk
  foreign key (avatar_asset_id) references public.space_assets(id) on delete set null;

create table public.asset_packs (
  id uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  visibility space_visibility not null default 'private',
  version integer not null default 1 check (version >= 1),
  status asset_pack_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Only moderated packs can be public or featured.
  check (visibility not in ('public', 'featured') or status = 'approved')
);

create table public.asset_pack_items (
  pack_id uuid not null references public.asset_packs(id) on delete cascade,
  asset_id uuid not null references public.space_assets(id) on delete cascade,
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  primary key (pack_id, asset_id)
);

create table public.asset_uses (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.space_assets(id) on delete cascade,
  used_by_profile_id uuid not null references public.profiles(id) on delete cascade,
  context asset_use_context not null,
  source_id uuid,
  created_at timestamptz not null default now()
);

create table public.remix_lineage (
  id uuid primary key default gen_random_uuid(),
  parent_kind remix_node_kind not null,
  parent_id uuid not null,
  child_kind remix_node_kind not null,
  child_id uuid not null,
  created_at timestamptz not null default now(),
  unique (parent_kind, parent_id, child_kind, child_id),
  check (parent_kind <> child_kind or parent_id <> child_id)
);

comment on table public.space_profiles is 'Paint Space identity: display name, avatar asset, age band, visibility, and guardian gating.';
comment on table public.space_assets is 'Reusable Paint Space assets (stickers, brushes, palettes, loops, templates, room themes) with jsonb payload.';
comment on table public.asset_packs is 'Grouped, versioned collections of space assets with moderation status for public/featured publishing.';
comment on table public.asset_pack_items is 'Junction of asset packs to their member assets with ordering.';
comment on table public.asset_uses is 'Records where a space asset was used (canvas, room, export, remix) and by whom.';
comment on table public.remix_lineage is 'Parent/child remix graph across assets, packs, posts, sessions, and snapshots.';

-- =====================================================================
-- Entitlements (docs/product-research.md §90-day roadmap entitlement schema draft)
-- =====================================================================

create type entitlement_plan as enum ('free', 'studio', 'family', 'classroom');

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  plan entitlement_plan not null default 'free',
  flags jsonb not null default '{}',
  source text not null default 'system',
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.entitlements is 'Per-profile plan entitlements (free/studio/family/classroom) with feature flags and optional expiry.';

-- =====================================================================
-- Layer + frame persistence (docs/product-research.md §per-layer autosave format)
-- Extend paint_sessions for Layer Lite + tiny-loop data, and add project snapshots.
-- =====================================================================

alter table public.paint_sessions
  add column layers jsonb not null default '[]',
  add column frames jsonb not null default '[]',
  add column frame_count integer not null default 1 check (frame_count >= 1),
  add column frame_durations jsonb not null default '[]';

create table public.project_snapshots (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid references public.paint_sessions(id) on delete set null,
  title text not null default 'Untitled' check (char_length(title) between 1 and 120),
  layers jsonb not null default '[]',
  frames jsonb not null default '[]',
  frame_count integer not null default 1 check (frame_count >= 1),
  created_at timestamptz not null default now()
);

comment on table public.project_snapshots is 'Autosaved per-layer/per-frame project state (Layer Lite + tiny loops) for solo and session work.';

-- =====================================================================
-- Economy: wallets, ledger, products, receipts, tips, payouts (docs/paint-economy.md §Backend Model)
-- Balances are cached projections of the append-only ledger. No user-to-user currency transfer.
-- =====================================================================

create type currency_type as enum ('drops', 'kudos', 'creator');
create type ledger_direction as enum ('credit', 'debit');
create type drop_platform as enum ('apple', 'google', 'web');
create type purchase_status as enum ('pending', 'verified', 'failed', 'refunded', 'revoked');
create type payout_status as enum ('pending', 'approved', 'processing', 'paid', 'held', 'rejected', 'reversed');
create type tip_status as enum ('pending', 'approved', 'held', 'reversed', 'blocked');
create type payout_account_status as enum ('none', 'pending', 'approved', 'rejected', 'suspended');

create table public.wallets (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  -- Cached balances; authoritative values derive from wallet_ledger_entries.
  drops_balance bigint not null default 0 check (drops_balance >= 0),
  kudos_balance bigint not null default 0 check (kudos_balance >= 0),
  creator_balance bigint not null default 0 check (creator_balance >= 0),
  locked_balance bigint not null default 0 check (locked_balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.wallet_ledger_entries (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  amount bigint not null check (amount > 0),
  currency_type currency_type not null,
  direction ledger_direction not null,
  source text not null,
  source_id uuid,
  platform drop_platform,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table public.drop_products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  platform drop_platform not null,
  drop_amount integer not null check (drop_amount > 0),
  price_cents integer not null check (price_cents >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  platform drop_platform not null,
  receipt_id text not null,
  sku text not null,
  amount integer not null check (amount >= 0),
  status purchase_status not null default 'pending',
  raw_payload jsonb not null default '{}',
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, receipt_id)
);

create table public.asset_products (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.space_assets(id) on delete cascade,
  price_drops integer not null check (price_drops >= 0),
  creator_profile_id uuid not null references public.profiles(id) on delete cascade,
  platform_fee_bps integer not null default 0 check (platform_fee_bps between 0 and 10000),
  status asset_pack_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tips (
  id uuid primary key default gen_random_uuid(),
  sender_profile_id uuid not null references public.profiles(id) on delete cascade,
  receiver_profile_id uuid not null references public.profiles(id) on delete cascade,
  source_type text not null check (source_type in ('gallery_post', 'asset_pack', 'space_asset', 'timed_event', 'paint_session')),
  source_id uuid,
  amount_drops integer not null check (amount_drops > 0),
  status tip_status not null default 'pending',
  created_at timestamptz not null default now(),
  -- No user-to-user currency transfer disguised as a self-tip.
  check (sender_profile_id <> receiver_profile_id)
);

create table public.creator_payout_accounts (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  guardian_profile_id uuid references public.profiles(id) on delete set null,
  status payout_account_status not null default 'none',
  provider_account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.creator_payouts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  status payout_status not null default 'pending',
  provider_transfer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.economy_admin_actions (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id) on delete set null,
  action_type text not null check (action_type in ('credit_adjustment', 'debit_adjustment', 'hold_tip', 'reverse_tip', 'refund_purchase', 'revoke_purchase', 'approve_payout', 'hold_payout', 'reject_payout', 'reverse_payout', 'recalc_kudos', 'approve_payout_account', 'reject_payout_account', 'suspend_payout_account', 'activate_product', 'deactivate_product')),
  target_table text not null check (target_table in ('wallets', 'wallet_ledger_entries', 'drop_products', 'purchase_receipts', 'asset_products', 'tips', 'creator_payout_accounts', 'creator_payouts')),
  target_id uuid not null,
  note text,
  created_at timestamptz not null default now()
);

comment on table public.wallets is 'Cached per-profile balances (drops/kudos/creator/locked) derived from the append-only wallet ledger.';
comment on table public.wallet_ledger_entries is 'Append-only currency ledger: every earn, purchase, spend, tip, reversal, refund, hold, and admin adjustment. Idempotent.';
comment on table public.drop_products is 'Platform SKUs mapping a purchase to a Drop grant and price.';
comment on table public.purchase_receipts is 'App Store / Google Play / web receipt verification records, idempotent per platform receipt.';
comment on table public.asset_products is 'Priced Paint Space assets with creator and platform fee settings.';
comment on table public.tips is 'Drops tips with sender, receiver, source content, and moderation status. No self-tips.';
comment on table public.creator_payout_accounts is 'Creator payout enrollment, guardian-gated for minors; cash-out only after eligibility.';
comment on table public.creator_payouts is 'Cash payout records to verified/guardian-approved creators with provider transfer tracking.';
comment on table public.economy_admin_actions is 'Immutable audit log of admin economy actions (adjustments, holds, refunds, payouts).';

-- Enforce ledger append-only: block UPDATE and DELETE on wallet_ledger_entries.
create function public.block_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'wallet_ledger_entries is append-only; % is not permitted', tg_op;
end;
$$;

create trigger wallet_ledger_no_update
  before update on public.wallet_ledger_entries
  for each row execute function public.block_ledger_mutation();

create trigger wallet_ledger_no_delete
  before delete on public.wallet_ledger_entries
  for each row execute function public.block_ledger_mutation();

-- =====================================================================
-- Row Level Security: enable for all new tables.
-- =====================================================================

alter table public.space_profiles enable row level security;
alter table public.space_assets enable row level security;
alter table public.asset_packs enable row level security;
alter table public.asset_pack_items enable row level security;
alter table public.asset_uses enable row level security;
alter table public.remix_lineage enable row level security;
alter table public.entitlements enable row level security;
alter table public.project_snapshots enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_ledger_entries enable row level security;
alter table public.drop_products enable row level security;
alter table public.purchase_receipts enable row level security;
alter table public.asset_products enable row level security;
alter table public.tips enable row level security;
alter table public.creator_payout_accounts enable row level security;
alter table public.creator_payouts enable row level security;
alter table public.economy_admin_actions enable row level security;

-- Paint Spaces policies: owners manage their own; guardians and admins can read;
-- public/featured/friends visibility surfaces are read-only (no public people search of private spaces).

create policy "space profiles owner or guardian or admin read"
  on public.space_profiles for select
  using (
    profile_id = auth.uid()
    or guardian_profile_id = auth.uid()
    or public.is_admin()
    or visibility in ('public', 'featured')
  );

create policy "space profiles owner manage"
  on public.space_profiles for all
  using (profile_id = auth.uid() or public.is_admin())
  with check (profile_id = auth.uid() or public.is_admin());

create policy "space assets owner or shared read"
  on public.space_assets for select
  using (
    owner_profile_id = auth.uid()
    or public.is_admin()
    or visibility in ('public', 'featured')
  );

create policy "space assets owner manage"
  on public.space_assets for all
  using (owner_profile_id = auth.uid() or public.is_admin())
  with check (owner_profile_id = auth.uid() or public.is_admin());

create policy "asset packs owner or shared read"
  on public.asset_packs for select
  using (
    owner_profile_id = auth.uid()
    or public.is_admin()
    or (visibility in ('public', 'featured') and status = 'approved')
  );

create policy "asset packs owner manage"
  on public.asset_packs for all
  using (owner_profile_id = auth.uid() or public.is_admin())
  with check (owner_profile_id = auth.uid() or public.is_admin());

create policy "asset pack items owner or shared read"
  on public.asset_pack_items for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.asset_packs ap
      where ap.id = asset_pack_items.pack_id
        and (
          ap.owner_profile_id = auth.uid()
          or (ap.visibility in ('public', 'featured') and ap.status = 'approved')
        )
    )
  );

create policy "asset pack items owner manage"
  on public.asset_pack_items for all
  using (
    public.is_admin()
    or exists (
      select 1 from public.asset_packs ap
      where ap.id = asset_pack_items.pack_id and ap.owner_profile_id = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.asset_packs ap
      where ap.id = asset_pack_items.pack_id and ap.owner_profile_id = auth.uid()
    )
  );

create policy "asset uses self or owner or admin read"
  on public.asset_uses for select
  using (
    used_by_profile_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.space_assets sa
      where sa.id = asset_uses.asset_id and sa.owner_profile_id = auth.uid()
    )
  );

create policy "asset uses create self"
  on public.asset_uses for insert
  with check (auth.uid() = used_by_profile_id);

create policy "remix lineage related read"
  on public.remix_lineage for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.space_assets sa
      where (sa.id = remix_lineage.parent_id or sa.id = remix_lineage.child_id)
        and sa.owner_profile_id = auth.uid()
    )
    or exists (
      select 1 from public.asset_packs ap
      where (ap.id = remix_lineage.parent_id or ap.id = remix_lineage.child_id)
        and ap.owner_profile_id = auth.uid()
    )
  );

create policy "remix lineage create related"
  on public.remix_lineage for insert
  with check (
    public.is_admin()
    or exists (
      select 1 from public.space_assets sa
      where sa.id = remix_lineage.child_id and sa.owner_profile_id = auth.uid()
    )
    or exists (
      select 1 from public.asset_packs ap
      where ap.id = remix_lineage.child_id and ap.owner_profile_id = auth.uid()
    )
  );

-- Entitlements: profile owner and admin can read; only admins write (entitlements are server/admin-issued).

create policy "entitlements self or admin read"
  on public.entitlements for select
  using (profile_id = auth.uid() or public.is_admin());

create policy "entitlements admin manage"
  on public.entitlements for all
  using (public.is_admin())
  with check (public.is_admin());

-- Project snapshots: strictly owner-managed; admins may read for moderation.

create policy "project snapshots owner or admin read"
  on public.project_snapshots for select
  using (profile_id = auth.uid() or public.is_admin());

create policy "project snapshots owner manage"
  on public.project_snapshots for all
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Economy policies: balances and ledgers are read-only to the owner; only the server
-- (admin/service role) writes balances and ledger entries. No user-to-user transfer.

create policy "wallets self or admin read"
  on public.wallets for select
  using (
    profile_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = wallets.profile_id and p.guardian_profile_id = auth.uid()
    )
  );

create policy "wallets admin manage"
  on public.wallets for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "ledger self or admin read"
  on public.wallet_ledger_entries for select
  using (
    profile_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = wallet_ledger_entries.profile_id and p.guardian_profile_id = auth.uid()
    )
  );

create policy "ledger admin insert"
  on public.wallet_ledger_entries for insert
  with check (public.is_admin());

create policy "drop products public read"
  on public.drop_products for select
  using (active = true or public.is_admin());

create policy "drop products admin manage"
  on public.drop_products for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "purchase receipts self or admin read"
  on public.purchase_receipts for select
  using (profile_id = auth.uid() or public.is_admin());

create policy "purchase receipts admin manage"
  on public.purchase_receipts for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "asset products public or owner read"
  on public.asset_products for select
  using (
    public.is_admin()
    or creator_profile_id = auth.uid()
    or status = 'approved'
  );

create policy "asset products creator create"
  on public.asset_products for insert
  with check (
    auth.uid() = creator_profile_id
    and exists (
      select 1 from public.space_assets sa
      where sa.id = asset_products.asset_id and sa.owner_profile_id = auth.uid()
    )
  );

create policy "asset products admin manage"
  on public.asset_products for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "tips participants or admin read"
  on public.tips for select
  using (
    sender_profile_id = auth.uid()
    or receiver_profile_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.profiles p
      where (p.id = tips.sender_profile_id or p.id = tips.receiver_profile_id)
        and p.guardian_profile_id = auth.uid()
    )
  );

create policy "tips sender create"
  on public.tips for insert
  with check (
    auth.uid() = sender_profile_id
    and sender_profile_id <> receiver_profile_id
    and not exists (
      select 1 from public.profile_bans pb
      where pb.profile_id = auth.uid()
        and pb.revoked_at is null
        and (pb.expires_at is null or pb.expires_at > now())
        and pb.scope in ('all_access', 'social')
    )
  );

create policy "tips admin manage"
  on public.tips for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "payout accounts self or guardian or admin read"
  on public.creator_payout_accounts for select
  using (
    profile_id = auth.uid()
    or guardian_profile_id = auth.uid()
    or public.is_admin()
  );

create policy "payout accounts admin manage"
  on public.creator_payout_accounts for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "creator payouts self or admin read"
  on public.creator_payouts for select
  using (profile_id = auth.uid() or public.is_admin());

create policy "creator payouts admin manage"
  on public.creator_payouts for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "economy admin actions admin only"
  on public.economy_admin_actions for all
  using (public.is_admin())
  with check (public.is_admin());

-- =====================================================================
-- Indexes for new tables.
-- =====================================================================

create index space_assets_owner_idx on public.space_assets(owner_profile_id, kind);
create index space_assets_visibility_idx on public.space_assets(visibility) where visibility in ('public', 'featured');
create index asset_packs_owner_idx on public.asset_packs(owner_profile_id, status);
create index asset_pack_items_asset_idx on public.asset_pack_items(asset_id);
create index asset_uses_asset_idx on public.asset_uses(asset_id, created_at);
create index asset_uses_profile_idx on public.asset_uses(used_by_profile_id, created_at);
create index remix_lineage_parent_idx on public.remix_lineage(parent_kind, parent_id);
create index remix_lineage_child_idx on public.remix_lineage(child_kind, child_id);
create index entitlements_profile_idx on public.entitlements(profile_id, plan);
create index project_snapshots_profile_idx on public.project_snapshots(profile_id, created_at);
create index project_snapshots_session_idx on public.project_snapshots(session_id) where session_id is not null;
create index wallet_ledger_profile_idx on public.wallet_ledger_entries(profile_id, created_at);
create index wallet_ledger_source_idx on public.wallet_ledger_entries(source, source_id);
create index drop_products_active_idx on public.drop_products(platform, active);
create index purchase_receipts_profile_idx on public.purchase_receipts(profile_id, created_at);
create index purchase_receipts_status_idx on public.purchase_receipts(status, created_at);
create index asset_products_creator_idx on public.asset_products(creator_profile_id, status);
create index tips_receiver_idx on public.tips(receiver_profile_id, created_at);
create index tips_sender_idx on public.tips(sender_profile_id, created_at);
create index tips_status_idx on public.tips(status, created_at);
create index creator_payouts_profile_idx on public.creator_payouts(profile_id, status);
create index economy_admin_actions_target_idx on public.economy_admin_actions(target_table, target_id, created_at);

-- =====================================================================
-- Room Replay & Timelapse (docs/product-research.md §"Replay and Process Sharing")
-- SNAPSHOT-BASED, NOT per-stroke. Replay is reconstructed from a capped, decimated
-- series of image snapshots, not the raw stroke_events stream:
--   * Periodic keyframes are captured on a timer ('keyframe').
--   * Meaningful changes (layer add, big fill, frame change) capture an 'event' snapshot.
--   * The artist can force a 'manual' snapshot (e.g. before/after).
-- The capture pipeline is expected to CAP total snapshots per session and DECIMATE
-- (drop low-change_score intermediate frames) so storage stays bounded while major
-- moments survive. seq is a monotonic per-session ordering used to play back frames.
-- Finished timelapse exports (GIF/MP4/sprite) are materialized into timelapse_assets.
-- =====================================================================

create type replay_snapshot_kind as enum ('keyframe', 'event', 'manual');
create type timelapse_format as enum ('gif', 'mp4', 'sprite');

create table public.replay_snapshots (
  id uuid primary key default gen_random_uuid(),
  -- A snapshot belongs to a live/recorded session and/or a saved project; both nullable
  -- so manual before/after snapshots on a solo project still work.
  session_id uuid references public.paint_sessions(id) on delete cascade,
  project_snapshot_id uuid references public.project_snapshots(id) on delete set null,
  owner_profile_id uuid not null references public.profiles(id) on delete cascade,
  seq integer not null check (seq >= 0),
  kind replay_snapshot_kind not null default 'keyframe',
  -- Storage object key or signed URL of the rendered frame image.
  image_url text,
  storage_ref text,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  -- 0..1 estimate of how much changed vs the prior snapshot; used to decimate.
  change_score numeric check (change_score is null or (change_score >= 0 and change_score <= 1)),
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- A snapshot must point at something to be meaningful.
  check (session_id is not null or project_snapshot_id is not null),
  -- Must carry a renderable reference.
  check (image_url is not null or storage_ref is not null)
);

create table public.timelapse_assets (
  id uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references public.profiles(id) on delete cascade,
  source_session_id uuid references public.paint_sessions(id) on delete set null,
  -- Optional link to the saved project the export was rendered from.
  source_project_snapshot_id uuid references public.project_snapshots(id) on delete set null,
  format timelapse_format not null default 'mp4',
  frame_count integer not null default 0 check (frame_count >= 0),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  asset_url text,
  storage_ref text,
  -- Exported clips are user-generated and surfaced socially, so they carry a safety gate.
  safety_status media_safety_status not null default 'pending',
  created_at timestamptz not null default now(),
  check (asset_url is not null or storage_ref is not null)
);

comment on table public.replay_snapshots is 'Snapshot-based room/process replay: capped, decimated series of image frames (periodic keyframes + event + manual snapshots) ordered by seq. Not per-stroke; reconstructs process from rendered images.';
comment on table public.timelapse_assets is 'Materialized timelapse exports (gif/mp4/sprite) rendered from replay_snapshots, moderated before public sharing.';

-- =====================================================================
-- Community Brush/Stamp/Pack moderation pipeline (docs/product-research.md §"Community Brushes and Stamps")
-- space_assets already carries kind='brush'/'stamp' and asset_packs already has a
-- status column. verification_reviews covers identity/guardian/teacher review only, so
-- we add a dedicated asset-content review queue for brushes/stamps/packs (safety,
-- copyright, adult content, spam, misleading names).
-- =====================================================================

-- Structured brush parameters (engine recipe) for brush/stamp assets. Guarded add in
-- case it already exists; payload remains the general bag, brush_recipe is the typed slot.
alter table public.space_assets
  add column if not exists brush_recipe jsonb;

create type asset_moderation_target_kind as enum ('asset', 'pack');
create type asset_moderation_status as enum ('pending', 'approved', 'rejected', 'needs_changes');

create table public.asset_moderation_queue (
  id uuid primary key default gen_random_uuid(),
  target_kind asset_moderation_target_kind not null,
  -- Polymorphic: references space_assets.id (asset) or asset_packs.id (pack). Not a FK
  -- because the target table varies by target_kind, matching the existing moderation_actions pattern.
  target_id uuid not null,
  submitted_by uuid references public.profiles(id) on delete set null,
  status asset_moderation_status not null default 'pending',
  reviewer_profile_id uuid references public.profiles(id) on delete set null,
  reason text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz
);

comment on table public.asset_moderation_queue is 'Review queue for community brushes/stamps/assets and packs (safety, copyright, adult content, spam, misleading names) before public/featured publishing.';

-- =====================================================================
-- AI Assist (docs/product-research.md §AI) — safety-gated, consent-gated.
-- Under-13 spaces require a guardian on the consent record; generated assets flow
-- through a moderation status before becoming public ("safety queue for generated assets").
-- =====================================================================

create type ai_generation_kind as enum ('palette', 'prompt_card', 'brush_recipe', 'line_cleanup', 'caption', 'background');
create type ai_moderation_status as enum ('pending', 'approved', 'blocked');

create table public.ai_consent (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  -- Required for under-13 profiles; the guardian who granted AI consent.
  guardian_profile_id uuid references public.profiles(id) on delete set null,
  version text not null,
  consented_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (profile_id, version),
  check (revoked_at is null or revoked_at >= consented_at)
);

create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind ai_generation_kind not null,
  input jsonb not null default '{}',
  output jsonb not null default '{}',
  model text,
  -- The consent version in force when this generation ran (audit trail).
  consent_version text not null,
  -- Generated content is gated until reviewed before it can be made public.
  moderation_status ai_moderation_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table public.ai_credits (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.ai_consent is 'AI Assist consent records per profile and policy version, guardian-gated for minors; revocable.';
comment on table public.ai_generations is 'AI Assist generation log (palette/prompt/brush/cleanup/caption/background) with input/output, model, consent version, and a moderation gate before public use.';
comment on table public.ai_credits is 'Optional per-profile AI Assist credit balance referenced by the economy.';

-- =====================================================================
-- Account deletion (App Review requirement, docs/social-backend.md §"Store Review Notes":
-- "Add in-app account deletion before release"). Always available, never gated or sold.
-- =====================================================================

create type account_deletion_status as enum ('requested', 'processing', 'completed', 'cancelled');

create table public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  status account_deletion_status not null default 'requested',
  requested_at timestamptz not null default now(),
  -- When the hard purge is scheduled to run (e.g. after a grace/cancellation window).
  scheduled_purge_at timestamptz,
  completed_at timestamptz,
  note text
);

comment on table public.account_deletion_requests is 'In-app account deletion requests with grace window and purge scheduling; always available to the owning profile (App Review requirement).';

-- =====================================================================
-- Cross-device sync (light) — docs/social-backend.md: accounts unlock cross-device sync.
-- Sync uses existing auth + profiles for identity and project_snapshots as the
-- authoritative per-project state; clients sync drawing as stroke_events, not image
-- streams. We do NOT build a full sync engine here. device_sync_state is a thin
-- per-device cursor so a client can resume from its last synced point.
-- =====================================================================

create table public.device_sync_state (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  device_id text not null,
  last_synced_at timestamptz not null default now(),
  primary key (profile_id, device_id)
);

comment on table public.device_sync_state is 'Thin per-device sync cursor (last_synced_at) for resuming cross-device sync; authoritative state lives in project_snapshots/stroke_events.';

-- =====================================================================
-- Row Level Security: enable + policies for replay, AI, moderation, deletion, sync tables.
-- =====================================================================

alter table public.replay_snapshots enable row level security;
alter table public.timelapse_assets enable row level security;
alter table public.asset_moderation_queue enable row level security;
alter table public.ai_consent enable row level security;
alter table public.ai_generations enable row level security;
alter table public.ai_credits enable row level security;
alter table public.account_deletion_requests enable row level security;
alter table public.device_sync_state enable row level security;

-- Replay snapshots: owner manages own; participants of the session can read; admins read all.
create policy "replay snapshots owner or participant read"
  on public.replay_snapshots for select
  using (
    owner_profile_id = auth.uid()
    or public.is_admin()
    or (
      session_id is not null
      and exists (
        select 1 from public.session_participants sp
        where sp.session_id = replay_snapshots.session_id and sp.profile_id = auth.uid()
      )
    )
  );

create policy "replay snapshots owner manage"
  on public.replay_snapshots for all
  using (owner_profile_id = auth.uid() or public.is_admin())
  with check (owner_profile_id = auth.uid() or public.is_admin());

-- Timelapse assets: owner manages own; surfaced publicly only once approved; admins read all.
create policy "timelapse assets owner or approved read"
  on public.timelapse_assets for select
  using (
    owner_profile_id = auth.uid()
    or public.is_admin()
    or safety_status = 'approved'
  );

create policy "timelapse assets owner manage"
  on public.timelapse_assets for all
  using (owner_profile_id = auth.uid() or public.is_admin())
  with check (owner_profile_id = auth.uid() or public.is_admin());

-- Asset moderation queue: submitter can create/read own submissions; admins manage all.
create policy "asset moderation submitter or admin read"
  on public.asset_moderation_queue for select
  using (submitted_by = auth.uid() or public.is_admin());

create policy "asset moderation submitter create"
  on public.asset_moderation_queue for insert
  with check (auth.uid() = submitted_by and status = 'pending');

create policy "asset moderation admin manage"
  on public.asset_moderation_queue for all
  using (public.is_admin())
  with check (public.is_admin());

-- AI consent: owner manages own; guardian can read/manage child consent; admins read.
create policy "ai consent self or guardian or admin read"
  on public.ai_consent for select
  using (
    profile_id = auth.uid()
    or guardian_profile_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = ai_consent.profile_id and p.guardian_profile_id = auth.uid()
    )
  );

create policy "ai consent self or guardian manage"
  on public.ai_consent for all
  using (
    profile_id = auth.uid()
    or guardian_profile_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = ai_consent.profile_id and p.guardian_profile_id = auth.uid()
    )
  )
  with check (
    profile_id = auth.uid()
    or guardian_profile_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = ai_consent.profile_id and p.guardian_profile_id = auth.uid()
    )
  );

-- AI generations: owner and guardian read; insert requires active (non-revoked) consent,
-- with under-13 requiring a guardian on the consent record. Moderation status is server-set.
create policy "ai generations self or guardian or admin read"
  on public.ai_generations for select
  using (
    profile_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = ai_generations.profile_id and p.guardian_profile_id = auth.uid()
    )
  );

create policy "ai generations self create with consent"
  on public.ai_generations for insert
  with check (
    auth.uid() = profile_id
    and moderation_status = 'pending'
    and exists (
      select 1 from public.ai_consent c
      join public.profiles p on p.id = c.profile_id
      where c.profile_id = auth.uid()
        and c.version = ai_generations.consent_version
        and c.revoked_at is null
        and (
          p.profile_kind <> 'child'
          or c.guardian_profile_id is not null
        )
    )
  );

create policy "ai generations admin manage"
  on public.ai_generations for update
  using (public.is_admin())
  with check (public.is_admin());

-- AI credits: owner and guardian read; only the server/admin writes balances.
create policy "ai credits self or guardian or admin read"
  on public.ai_credits for select
  using (
    profile_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = ai_credits.profile_id and p.guardian_profile_id = auth.uid()
    )
  );

create policy "ai credits admin manage"
  on public.ai_credits for all
  using (public.is_admin())
  with check (public.is_admin());

-- Account deletion: the owning profile can always create, read, and cancel its own
-- request; admins can read all. Never gated by plan/economy.
create policy "account deletion self or admin read"
  on public.account_deletion_requests for select
  using (profile_id = auth.uid() or public.is_admin());

create policy "account deletion self create"
  on public.account_deletion_requests for insert
  with check (auth.uid() = profile_id and status = 'requested');

-- Owner may cancel (or otherwise update) their own request; admins drive processing/completion.
create policy "account deletion self or admin update"
  on public.account_deletion_requests for update
  using (profile_id = auth.uid() or public.is_admin())
  with check (profile_id = auth.uid() or public.is_admin());

-- Device sync state: strictly owner-managed; admins may read for support.
create policy "device sync state self or admin read"
  on public.device_sync_state for select
  using (profile_id = auth.uid() or public.is_admin());

create policy "device sync state owner manage"
  on public.device_sync_state for all
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- =====================================================================
-- Indexes for replay, AI, moderation, deletion, and sync tables.
-- =====================================================================

create index replay_snapshots_session_seq_idx on public.replay_snapshots(session_id, seq) where session_id is not null;
create index replay_snapshots_owner_idx on public.replay_snapshots(owner_profile_id, captured_at);
create index replay_snapshots_project_idx on public.replay_snapshots(project_snapshot_id) where project_snapshot_id is not null;
create index timelapse_assets_owner_idx on public.timelapse_assets(owner_profile_id, created_at);
create index timelapse_assets_session_idx on public.timelapse_assets(source_session_id) where source_session_id is not null;
create index timelapse_assets_safety_idx on public.timelapse_assets(safety_status);
create index asset_moderation_queue_status_idx on public.asset_moderation_queue(status, submitted_at);
create index asset_moderation_queue_target_idx on public.asset_moderation_queue(target_kind, target_id);
create index ai_consent_profile_idx on public.ai_consent(profile_id) where revoked_at is null;
create index ai_generations_profile_idx on public.ai_generations(profile_id, created_at);
create index ai_generations_moderation_idx on public.ai_generations(moderation_status, created_at);
create index account_deletion_requests_profile_idx on public.account_deletion_requests(profile_id, status);
create index account_deletion_requests_purge_idx on public.account_deletion_requests(scheduled_purge_at) where status in ('requested', 'processing');
create index device_sync_state_profile_idx on public.device_sync_state(profile_id, last_synced_at);
