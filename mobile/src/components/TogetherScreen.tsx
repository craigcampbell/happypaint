import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, CalendarClock, Link, MessageCircle, Plus, ShieldCheck, Users } from "lucide-react-native";

import {
  createInviteCode,
  loadPlannedSessions,
  normalizeInviteCode,
  ROOM_AUDIENCE_POLICIES,
  roomPolicyFor,
  savePlannedSessions,
  SAFE_MEDIA_LIBRARY,
  shareInvite,
  type PlannedSession,
  type RoomAudience
} from "../social";
import { IconButton } from "./IconButton";

type Props = {
  initialJoinCode?: string;
  onBack: () => void;
};

const THEMES = ["Free draw", "Color together", "Draw a creature", "Wallpaper challenge"];

function nextHour() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return date;
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatTimeInput(date: Date) {
  return date.toTimeString().slice(0, 5);
}

function sessionDate(dateValue: string, timeValue: string) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

export function TogetherScreen({ initialJoinCode = "", onBack }: Props) {
  const initialDate = nextHour();
  const [roomCode, setRoomCode] = useState(() => normalizeInviteCode(initialJoinCode) || createInviteCode());
  const [joinCode, setJoinCode] = useState(() => normalizeInviteCode(initialJoinCode));
  const [theme, setTheme] = useState(THEMES[0]);
  const [roomAudience, setRoomAudience] = useState<RoomAudience>("kid-safe");
  const [artistSlots, setArtistSlots] = useState("4");
  const [viewerSlots, setViewerSlots] = useState("20");
  const [dateValue, setDateValue] = useState(formatDateInput(initialDate));
  const [timeValue, setTimeValue] = useState(formatTimeInput(initialDate));
  const [sessions, setSessions] = useState<PlannedSession[]>([]);

  const activePolicy = roomPolicyFor(roomAudience);

  useEffect(() => {
    void loadPlannedSessions().then(setSessions);
  }, []);

  useEffect(() => {
    const code = normalizeInviteCode(initialJoinCode);
    if (code) {
      setRoomCode(code);
      setJoinCode(code);
    }
  }, [initialJoinCode]);

  const newRoom = useCallback(() => {
    const code = createInviteCode();
    setRoomCode(code);
    setJoinCode(code);
  }, []);

  const joinRoom = useCallback(() => {
    const code = normalizeInviteCode(joinCode);
    if (!code) {
      Alert.alert("Room code needed", "Ask your friend for their Happy Paint room code.");
      return;
    }
    setRoomCode(code);
    Alert.alert("Room ready", `When live sync is connected, this opens room ${code}.`);
  }, [joinCode]);

  const planSession = useCallback(async () => {
    const startsAt = sessionDate(dateValue, timeValue).getTime();
    const session: PlannedSession = {
      id: `session-${Date.now()}`,
      code: roomCode,
      audience: roomAudience,
      artistSlots: Number(artistSlots) || 4,
      viewerSlots: Number(viewerSlots) || 20,
      startsAt,
      theme,
      createdAt: Date.now()
    };
    const nextSessions = [session, ...sessions].slice(0, 8);
    setSessions(nextSessions);
    await savePlannedSessions(nextSessions);
    await shareInvite(roomCode, theme);
  }, [artistSlots, dateValue, roomAudience, roomCode, sessions, theme, timeValue, viewerSlots]);

  const shareRoom = useCallback(async () => {
    if (roomAudience === "adult-18") {
      Alert.alert("Verification needed", "18+ rooms should stay locked until adult verification is connected.");
      return;
    }

    await shareInvite(roomCode, theme);
  }, [roomAudience, roomCode, theme]);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Gallery" onPress={onBack} />
        <View style={styles.titleBlock}>
          <Text style={styles.title}>Paint Together</Text>
          <Text style={styles.subtitle}>Invite-only rooms for friends and family</Text>
        </View>
      </View>

      <View style={styles.roomPanel}>
        <View style={styles.roomHeader}>
          <Users size={24} color="#0f766e" />
          <Text style={styles.roomLabel}>Room Code</Text>
        </View>
        <Text style={styles.roomCode}>{roomCode}</Text>
        <Text style={styles.roomMeta}>
          {Number(artistSlots) || 4} artist seats · {Number(viewerSlots) || 20} viewer seats
        </Text>
        <View style={styles.actions}>
          <IconButton icon={Plus} label="New room" onPress={newRoom} />
          <IconButton icon={MessageCircle} label="Share" onPress={shareRoom} tone="dark" />
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <ShieldCheck size={20} color="#0f172a" />
          <Text style={styles.sectionTitle}>Room safety</Text>
        </View>
        <View style={styles.policyGrid}>
          {ROOM_AUDIENCE_POLICIES.map((policy) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: roomAudience === policy.id }}
              key={policy.id}
              onPress={() => setRoomAudience(policy.id)}
              style={[styles.policyCard, roomAudience === policy.id && styles.policyCardActive]}
            >
              <Text style={[styles.policyTitle, roomAudience === policy.id && styles.policyTitleActive]}>
                {policy.title}
              </Text>
              <Text style={styles.policyLabel}>{policy.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.policyDetail}>{activePolicy.detail}</Text>
      </View>

      {roomAudience === "kid-safe" ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Safe library</Text>
          <View style={styles.themeGrid}>
            {SAFE_MEDIA_LIBRARY.map((item) => (
              <Pressable
                accessibilityRole="button"
                key={item.id}
                onPress={() => setTheme(item.title)}
                style={styles.safeLibraryCard}
              >
                <Text style={styles.safeLibraryTitle}>{item.title}</Text>
                <Text style={styles.safeLibraryMeta}>{item.type}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Users size={20} color="#0f172a" />
          <Text style={styles.sectionTitle}>Room roles</Text>
        </View>
        <View style={styles.dateRow}>
          <View style={styles.roleField}>
            <Text style={styles.roleLabel}>Artist seats</Text>
            <TextInput
              inputMode="numeric"
              keyboardType="number-pad"
              onChangeText={(value) => setArtistSlots(value.replace(/[^0-9]/g, "").slice(0, 2))}
              style={styles.input}
              value={artistSlots}
            />
          </View>
          <View style={styles.roleField}>
            <Text style={styles.roleLabel}>Viewer seats</Text>
            <TextInput
              inputMode="numeric"
              keyboardType="number-pad"
              onChangeText={(value) => setViewerSlots(value.replace(/[^0-9]/g, "").slice(0, 3))}
              style={styles.input}
              value={viewerSlots}
            />
          </View>
        </View>
        <Text style={styles.policyDetail}>Hosts approve who can draw. Viewers can preview, vote, and react.</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Link size={20} color="#0f172a" />
          <Text style={styles.sectionTitle}>Join a friend</Text>
        </View>
        <TextInput
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={8}
          onChangeText={(value) => setJoinCode(normalizeInviteCode(value))}
          placeholder="ABC123"
          style={styles.input}
          value={joinCode}
        />
        <IconButton icon={Users} label="Join room" onPress={joinRoom} />
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <CalendarClock size={20} color="#0f172a" />
          <Text style={styles.sectionTitle}>Plan a paint date</Text>
        </View>
        <View style={styles.themeGrid}>
          {THEMES.map((item) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: theme === item }}
              key={item}
              onPress={() => setTheme(item)}
              style={[styles.themeChip, theme === item && styles.themeChipActive]}
            >
              <Text style={[styles.themeText, theme === item && styles.themeTextActive]}>{item}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.dateRow}>
          <TextInput onChangeText={setDateValue} style={styles.input} value={dateValue} />
          <TextInput onChangeText={setTimeValue} style={styles.input} value={timeValue} />
        </View>
        <IconButton icon={MessageCircle} label="Plan and invite" onPress={planSession} tone="dark" />
      </View>

      {sessions.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Planned sessions</Text>
          {sessions.map((session) => (
            <Pressable key={session.id} onPress={() => setRoomCode(session.code)} style={styles.sessionRow}>
              <View>
                <Text style={styles.sessionTitle}>{session.theme}</Text>
                <Text style={styles.sessionMeta}>
                  {new Date(session.startsAt).toLocaleString()} · {session.artistSlots ?? 4} artists
                </Text>
              </View>
              <View style={styles.sessionBadge}>
                <Text style={styles.sessionCode}>{session.code}</Text>
                <Text style={styles.sessionAudience}>{roomPolicyFor(session.audience).title}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.safetyPanel}>
        <ShieldCheck size={22} color="#92400e" />
        <View style={styles.safetyText}>
          <Text style={styles.safetyTitle}>Safer by default</Text>
          <Text style={styles.safetyBody}>
            Kid-safe rooms use the curated library first. 18+ rooms should require verified adult accounts and stay hidden from
            child profiles.
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10
  },
  dateRow: {
    flexDirection: "row",
    gap: 10
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  input: {
    backgroundColor: "#ffffff",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    color: "#0f172a",
    flex: 1,
    fontSize: 16,
    fontWeight: "800",
    minHeight: 44,
    paddingHorizontal: 12
  },
  policyCard: {
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    minHeight: 68,
    minWidth: 92,
    padding: 10
  },
  policyCardActive: {
    backgroundColor: "#ccfbf1",
    borderColor: "#0f766e"
  },
  policyDetail: {
    color: "#475569",
    fontSize: 14,
    lineHeight: 20
  },
  policyGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  policyLabel: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 4
  },
  policyTitle: {
    color: "#334155",
    fontSize: 15,
    fontWeight: "900"
  },
  policyTitleActive: {
    color: "#134e4a"
  },
  roomCode: {
    color: "#0f172a",
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: 4
  },
  roomHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  roomLabel: {
    color: "#334155",
    fontSize: 15,
    fontWeight: "900"
  },
  roomMeta: {
    color: "#0f766e",
    fontSize: 13,
    fontWeight: "900"
  },
  roomPanel: {
    backgroundColor: "#ecfdf5",
    borderColor: "#0f766e",
    borderRadius: 8,
    borderWidth: 1,
    gap: 14,
    padding: 16
  },
  roleField: {
    flex: 1,
    gap: 5
  },
  roleLabel: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "900"
  },
  safetyBody: {
    color: "#78350f",
    fontSize: 14,
    lineHeight: 20
  },
  safetyPanel: {
    alignItems: "flex-start",
    backgroundColor: "#fffbeb",
    borderColor: "#f59e0b",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 14
  },
  safetyText: {
    flex: 1
  },
  safetyTitle: {
    color: "#78350f",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 4
  },
  safeLibraryCard: {
    backgroundColor: "#fefce8",
    borderColor: "#facc15",
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 58,
    paddingHorizontal: 10,
    paddingVertical: 10
  },
  safeLibraryMeta: {
    color: "#854d0e",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 4
  },
  safeLibraryTitle: {
    color: "#422006",
    fontSize: 14,
    fontWeight: "900"
  },
  screen: {
    gap: 14,
    padding: 16,
    paddingBottom: 28
  },
  section: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  sectionTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900"
  },
  sessionCode: {
    color: "#0f766e",
    fontSize: 16,
    fontWeight: "900"
  },
  sessionAudience: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "900",
    textAlign: "right"
  },
  sessionBadge: {
    alignItems: "flex-end"
  },
  sessionMeta: {
    color: "#64748b",
    fontSize: 13
  },
  sessionRow: {
    alignItems: "center",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 10
  },
  sessionTitle: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "900"
  },
  subtitle: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  themeChip: {
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 10
  },
  themeChipActive: {
    backgroundColor: "#ccfbf1",
    borderColor: "#0f766e"
  },
  themeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  themeText: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "800"
  },
  themeTextActive: {
    color: "#134e4a"
  },
  title: {
    color: "#0f172a",
    fontSize: 26,
    fontWeight: "900"
  },
  titleBlock: {
    flex: 1
  }
});
