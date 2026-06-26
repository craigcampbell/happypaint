export const adminMetrics = [
  { id: "open-reports", label: "Open Reports", value: "12", detail: "3 high priority" },
  { id: "library-pending", label: "Library Pending", value: "27", detail: "GIFs, stickers, prompts" },
  { id: "rooms-live", label: "Live Rooms", value: "84", detail: "61 kid-safe" },
  { id: "discover-listed", label: "Listed Rooms", value: "36", detail: "0 adult indexed" },
  { id: "verification", label: "Verification Queue", value: "9", detail: "Adult and guardian review" },
  { id: "observers", label: "Staff Observers", value: "2", detail: "Audit logged" },
  { id: "security", label: "Security Alerts", value: "5", detail: "2 network spikes" },
];

export const moderationReports = [
  {
    id: "RPT-1042",
    priority: "High",
    room: "B7K2QH",
    audience: "Kid-safe",
    reason: "Imported link in kid room",
    detail: "Participant pasted an unknown URL into a room marked curated-only.",
    ageBand: "Under 13",
    createdAt: "8 min ago",
  },
  {
    id: "RPT-1039",
    priority: "Medium",
    room: "LUMA88",
    audience: "Friends",
    reason: "Sticker flagged",
    detail: "Automated image check flagged a user-uploaded reaction sticker.",
    ageBand: "Teen",
    createdAt: "21 min ago",
  },
  {
    id: "RPT-1034",
    priority: "Low",
    room: "MURAL5",
    audience: "18+",
    reason: "Verification mismatch",
    detail: "A join attempt was blocked because adult verification was missing.",
    ageBand: "Adult",
    createdAt: "1 hr ago",
  },
];

export const mediaReviewItems = [
  {
    id: "LIB-220",
    title: "Caption Cards: Lunch Table",
    type: "Prompt pack",
    source: "Internal library",
    ageFloor: "Kid-safe",
    status: "Pending",
  },
  {
    id: "LIB-218",
    title: "Sparkle Arrow Sticker Set",
    type: "Sticker pack",
    source: "Creator submission",
    ageFloor: "Kid-safe",
    status: "Needs review",
  },
  {
    id: "LIB-205",
    title: "Album Cover Remix Frame",
    type: "Template",
    source: "Internal library",
    ageFloor: "Teen",
    status: "Approved",
  },
];

export const roomReviewItems = [
  {
    id: "ROOM-91",
    code: "B7K2QH",
    audience: "Kid-safe",
    host: "guardian-managed",
    participants: 4,
    media: "Library only",
    state: "Live",
  },
  {
    id: "ROOM-88",
    code: "AURA22",
    audience: "Friends",
    host: "teen",
    participants: 6,
    media: "2 pending uploads",
    state: "Live",
  },
  {
    id: "ROOM-77",
    code: "ADULT9",
    audience: "18+",
    host: "verified adult",
    participants: 2,
    media: "Adult gate active",
    state: "Planned",
  },
];

export const liveMonitorRooms = [
  {
    id: "ROOM-91",
    code: "B7K2QH",
    audience: "Kid-safe",
    host: "guardian-managed",
    participants: 4,
    activity: "Drawing and library stickers",
    risk: "High",
    lastEvent: "Unknown link blocked",
  },
  {
    id: "ROOM-88",
    code: "AURA22",
    audience: "Friends",
    host: "teen",
    participants: 6,
    activity: "Meme remix session",
    risk: "Medium",
    lastEvent: "Sticker awaiting review",
  },
  {
    id: "ROOM-77",
    code: "ADULT9",
    audience: "18+",
    host: "verified adult",
    participants: 2,
    activity: "Planned room",
    risk: "Low",
    lastEvent: "Adult gate checked",
  },
];

export const roomEventLog = [
  {
    id: "EVT-9901",
    room: "B7K2QH",
    type: "media.blocked",
    actor: "system",
    detail: "Unknown URL blocked because the room is kid-safe.",
    createdAt: "2 min ago",
  },
  {
    id: "EVT-9900",
    room: "B7K2QH",
    type: "stroke.commit",
    actor: "participant",
    detail: "Marker stroke committed, 18 points.",
    createdAt: "3 min ago",
  },
  {
    id: "EVT-9898",
    room: "AURA22",
    type: "media.pending",
    actor: "participant",
    detail: "Uploaded sticker is waiting for moderation.",
    createdAt: "11 min ago",
  },
  {
    id: "EVT-9895",
    room: "ADULT9",
    type: "join.blocked",
    actor: "system",
    detail: "Join blocked for unverified adult profile.",
    createdAt: "22 min ago",
  },
];

export const verificationItems = [
  {
    id: "VER-44",
    profile: "Parent account",
    kind: "Guardian consent",
    status: "Waiting on email confirmation",
  },
  {
    id: "VER-41",
    profile: "Creator account",
    kind: "Adult verification",
    status: "Manual review",
  },
  {
    id: "VER-39",
    profile: "Teacher account",
    kind: "Classroom approval",
    status: "School domain verified",
  },
];

export const banReviewItems = [
  {
    id: "BAN-12",
    profile: "teen-profile-482",
    scope: "Rooms",
    reason: "Repeated unsafe uploads after warnings",
    status: "Active",
    expires: "24 hours",
  },
  {
    id: "BAN-09",
    profile: "adult-profile-117",
    scope: "Social",
    reason: "Attempted to invite child profile into adult room",
    status: "Active",
    expires: "Manual review",
  },
  {
    id: "BAN-04",
    profile: "guardian-managed-031",
    scope: "Uploads",
    reason: "Sticker uploads paused during review",
    status: "Review",
    expires: "2 hours",
  },
];

export const networkBlockItems = [
  {
    id: "NET-44",
    network: "203.0.113.0/24",
    action: "Challenge",
    reason: "Join-code guessing spike",
    provider: "Cloudflare WAF",
    expires: "30 min",
  },
  {
    id: "NET-38",
    network: "198.51.100.42/32",
    action: "Deny",
    reason: "Credential stuffing pattern",
    provider: "Vercel WAF",
    expires: "2 hours",
  },
  {
    id: "NET-35",
    network: "2001:db8:4::/48",
    action: "Rate-limit",
    reason: "Room creation burst",
    provider: "Edge function",
    expires: "15 min",
  },
];

export const ddosSignals = [
  {
    id: "SIG-77",
    route: "/join/:code",
    volume: "4,820 req/min",
    signal: "Code guessing",
    action: "Challenge by IP and device",
  },
  {
    id: "SIG-71",
    route: "/api/rooms",
    volume: "1,240 req/min",
    signal: "Create-room burst",
    action: "Rate-limit authenticated users",
  },
  {
    id: "SIG-68",
    route: "/assets/*",
    volume: "18,900 req/min",
    signal: "Static asset flood",
    action: "Serve from CDN cache",
  },
];

export const discoveryReviewItems = [
  {
    id: "DISC-31",
    room: "CAPTION",
    topic: "Draw the reaction image, not the comment section.",
    audience: "Kid-safe",
    visibility: "Featured",
    tags: "Meme remix, Kid-safe, Coloring",
    issue: "Approved snapshot expires in 18 min",
  },
  {
    id: "DISC-28",
    room: "COVER9",
    topic: "Fake Album Cover Night",
    audience: "Friends",
    visibility: "Listed preview",
    tags: "Album cover, Study break",
    issue: "Artist seats require host approval",
  },
  {
    id: "DISC-24",
    room: "ADULT9",
    topic: "18+ live draw",
    audience: "18+",
    visibility: "Blocked",
    tags: "Hidden",
    issue: "Adult rooms cannot enter public discovery",
  },
];

export const eventAdminItems = [
  {
    id: "EVT-DROP",
    title: "Daily Remix Drop",
    status: "Live",
    window: "Ends in 5h",
    rooms: 18,
    safety: "Kid-safe templates only",
  },
  {
    id: "EVT-LOOP",
    title: "Loop Battle",
    status: "Voting",
    window: "Closes tonight",
    rooms: 12,
    safety: "Vote throttle active",
  },
  {
    id: "EVT-WALL",
    title: "Weekend Wallpaper Jam",
    status: "Upcoming",
    window: "Starts Friday",
    rooms: 9,
    safety: "Gallery review required",
  },
];

export const galleryVoteItems = [
  {
    id: "VOTE-91",
    title: "Snack Planet",
    event: "Daily Remix Drop",
    votes: "482",
    signal: "Normal",
    status: "Featured",
  },
  {
    id: "VOTE-77",
    title: "Night Bus Loop",
    event: "Loop Battle",
    votes: "391",
    signal: "Mobile burst",
    status: "Review",
  },
  {
    id: "VOTE-70",
    title: "Static Hearts",
    event: "Weekend Wallpaper Jam",
    votes: "274",
    signal: "Normal",
    status: "Approved",
  },
];
