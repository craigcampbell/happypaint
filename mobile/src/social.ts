import AsyncStorage from "@react-native-async-storage/async-storage";
import { Share } from "react-native";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSIONS_KEY = "happy-paint:social-sessions";

export type RoomAudience = "kid-safe" | "friends" | "adult-18";

export type RoomAudiencePolicy = {
  id: RoomAudience;
  title: string;
  label: string;
  detail: string;
};

export const ROOM_AUDIENCE_POLICIES: RoomAudiencePolicy[] = [
  {
    id: "kid-safe",
    title: "Kid-safe",
    label: "Curated only",
    detail: "Only Happy Paint library prompts, stickers, and templates. Unknown links and uploads stay off."
  },
  {
    id: "friends",
    title: "Friends",
    label: "Invite remix",
    detail: "Friends can add art, images, and links after moderation checks are connected."
  },
  {
    id: "adult-18",
    title: "18+",
    label: "Verify adults",
    detail: "Hidden from child accounts and blocked until adult verification exists on the backend."
  }
];

export const SAFE_MEDIA_LIBRARY = [
  {
    id: "meme-captions",
    title: "Caption Cards",
    type: "Prompt pack"
  },
  {
    id: "friendly-stickers",
    title: "Friendly Stickers",
    type: "Sticker pack"
  },
  {
    id: "color-challenges",
    title: "Color Challenges",
    type: "Drawing prompt"
  }
];

export type PlannedSession = {
  id: string;
  code: string;
  audience: RoomAudience;
  artistSlots?: number;
  viewerSlots?: number;
  startsAt: number;
  theme: string;
  createdAt: number;
};

export function roomPolicyFor(audience: RoomAudience) {
  return ROOM_AUDIENCE_POLICIES.find((policy) => policy.id === audience) ?? ROOM_AUDIENCE_POLICIES[0];
}

export function createInviteCode(length = 6) {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  }
  return code;
}

export function normalizeInviteCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export function inviteLinks(code: string) {
  return {
    app: `happypaint://join/${code}`,
    web: `https://happypaint.app/join/${code}`
  };
}

export async function shareInvite(code: string, theme: string) {
  const links = inviteLinks(code);
  await Share.share({
    title: `Happy Paint: ${theme}`,
    message: `Join my Happy Paint room with code ${code}\n${links.web}\n${links.app}`
  });
}

export async function loadPlannedSessions(): Promise<PlannedSession[]> {
  const raw = await AsyncStorage.getItem(SESSIONS_KEY);
  if (!raw) {
    return [];
  }

  try {
    return (JSON.parse(raw) as PlannedSession[])
      .map((session) => ({ ...session, audience: session.audience ?? ("kid-safe" as RoomAudience) }))
      .sort((a, b) => a.startsAt - b.startsAt);
  } catch {
    return [];
  }
}

export async function savePlannedSessions(sessions: PlannedSession[]) {
  await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}
