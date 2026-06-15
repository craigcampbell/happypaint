import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, Eye, Heart, Search, Sparkles, Users } from "lucide-react-native";

import {
  DISCOVER_TAGS,
  DISCOVERABLE_ROOMS,
  PUBLIC_GALLERY_PIECES,
  TIMED_EVENTS,
  type GalleryPiece,
  type TimedEvent
} from "../discovery";
import { roomPolicyFor } from "../social";
import { IconButton } from "./IconButton";

type Props = {
  onBack: () => void;
  onTogether: () => void;
};

type SearchableItem = {
  title: string;
  tags?: string[];
  topic?: string;
  theme?: string;
  roomTitle?: string;
  event?: string;
  code?: string;
};

function matchesSearch(item: SearchableItem, query: string, tags: string[]) {
  const haystack = [
    item.title,
    item.topic,
    item.theme,
    item.roomTitle,
    item.event,
    item.code,
    ...(item.tags ?? [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const cleanQuery = query.trim().toLowerCase();
  const matchesQuery = cleanQuery.length === 0 || haystack.includes(cleanQuery);
  const matchesTags = tags.length === 0 || tags.every((tag) => item.tags?.includes(tag));

  return matchesQuery && matchesTags;
}

function GalleryArt({ piece }: { piece: GalleryPiece }) {
  return (
    <View style={styles.galleryArt}>
      <View style={[styles.galleryStrokeOne, { backgroundColor: piece.palette[0] }]} />
      <View style={[styles.galleryStrokeTwo, { backgroundColor: piece.palette[1] }]} />
      <View style={[styles.galleryStrokeThree, { backgroundColor: piece.palette[2] }]} />
    </View>
  );
}

function EventRow({ event }: { event: TimedEvent }) {
  return (
    <View style={styles.eventCard}>
      <View style={styles.eventTopline}>
        <Text style={styles.statusPill}>{event.status}</Text>
        <Text style={styles.eventTitle} numberOfLines={1}>
          {event.title}
        </Text>
      </View>
      <Text style={styles.eventTheme}>{event.theme}</Text>
      <Text style={styles.meta}>
        {event.window} · {event.roomCount} rooms · {event.galleryCount} posts
      </Text>
    </View>
  );
}

export function DiscoverScreen({ onBack, onTogether }: Props) {
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [notice, setNotice] = useState("Browse and preview. Joining needs an invite or host approval.");
  const [votedIds, setVotedIds] = useState<string[]>([]);
  const [voteCounts, setVoteCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(PUBLIC_GALLERY_PIECES.map((piece) => [piece.id, piece.votes]))
  );

  const rooms = useMemo(
    () => DISCOVERABLE_ROOMS.filter((room) => matchesSearch(room, query, activeTags)),
    [activeTags, query]
  );
  const events = useMemo(
    () => TIMED_EVENTS.filter((event) => matchesSearch(event, query, activeTags)),
    [activeTags, query]
  );
  const gallery = useMemo(
    () => PUBLIC_GALLERY_PIECES.filter((piece) => matchesSearch(piece, query, activeTags)),
    [activeTags, query]
  );

  const toggleTag = (tag: string) => {
    setActiveTags((current) => (current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]));
  };

  const voteFor = (piece: GalleryPiece) => {
    if (votedIds.includes(piece.id)) {
      setNotice(`${piece.title} already has your vote in this demo.`);
      return;
    }

    setVotedIds((current) => [...current, piece.id]);
    setVoteCounts((current) => ({ ...current, [piece.id]: current[piece.id] + 1 }));
    setNotice(`Vote added for ${piece.title}.`);
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Gallery" onPress={onBack} />
        <View style={styles.titleBlock}>
          <Text style={styles.title}>Discover</Text>
          <Text style={styles.subtitle}>Topics, rooms, events, and group gallery votes</Text>
        </View>
      </View>

      <View style={styles.searchBox}>
        <View style={styles.sectionHeader}>
          <Search size={18} color="#0f172a" strokeWidth={2.4} />
          <Text style={styles.sectionTitle}>Search before joining</Text>
        </View>
        <TextInput
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Try meme remix, anime, coloring..."
          style={styles.input}
          value={query}
        />
        <View style={styles.tagWrap}>
          {DISCOVER_TAGS.map((tag) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: activeTags.includes(tag) }}
              key={tag}
              onPress={() => toggleTag(tag)}
              style={[styles.tagChip, activeTags.includes(tag) && styles.tagChipActive]}
            >
              <Text style={[styles.tagText, activeTags.includes(tag) && styles.tagTextActive]}>{tag}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.notice}>{notice}</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Eye size={20} color="#0f172a" strokeWidth={2.4} />
          <Text style={styles.sectionTitle}>Rooms</Text>
          <Text style={styles.count}>{rooms.length}</Text>
        </View>
        {rooms.map((room) => {
          const policy = roomPolicyFor(room.audience);

          return (
            <View key={room.id} style={styles.roomCard}>
              <View style={styles.roomArt}>
                <View style={[styles.roomStrokeOne, { backgroundColor: room.accent }]} />
                <View style={[styles.roomStrokeTwo, { backgroundColor: room.accent }]} />
                <View style={styles.roomRing} />
              </View>
              <View style={styles.roomTopline}>
                <Text style={styles.statusPill}>{room.status}</Text>
                <Text style={styles.audience}>{policy.title}</Text>
              </View>
              <Text style={styles.roomTitle}>{room.title}</Text>
              <Text style={styles.roomTopic}>{room.topic}</Text>
              <View style={styles.tagWrap}>
                {room.tags.map((tag) => (
                  <Text key={tag} style={styles.miniTag}>
                    {tag}
                  </Text>
                ))}
              </View>
              <View style={styles.roleGrid}>
                <Text style={styles.rolePill}>
                  Artists {room.artists.active}/{room.artists.max}
                </Text>
                <Text style={styles.rolePill}>
                  Viewers {room.viewers.active}/{room.viewers.max}
                </Text>
              </View>
              <Text style={styles.roleNote}>{room.rolePolicy}</Text>
              <View style={styles.actionRow}>
                <IconButton icon={Eye} label="Preview" onPress={() => setNotice(`${room.title} preview opened.`)} tone="dark" />
                <IconButton icon={Users} label="Role request" onPress={onTogether} />
              </View>
            </View>
          );
        })}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Sparkles size={20} color="#0f172a" strokeWidth={2.4} />
          <Text style={styles.sectionTitle}>Timed Events</Text>
          <Text style={styles.count}>{events.length}</Text>
        </View>
        {events.map((event) => (
          <EventRow event={event} key={event.id} />
        ))}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Heart size={20} color="#0f172a" strokeWidth={2.4} />
          <Text style={styles.sectionTitle}>Gallery Vote</Text>
          <Text style={styles.count}>{gallery.length}</Text>
        </View>
        {gallery.map((piece) => (
          <View key={piece.id} style={styles.galleryCard}>
            <GalleryArt piece={piece} />
            <View style={styles.galleryCopy}>
              <Text style={styles.galleryTitle}>{piece.title}</Text>
              <Text style={styles.meta}>
                {piece.roomTitle} · {piece.contributors} artists
              </Text>
              <Text style={styles.meta}>{piece.event}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={votedIds.includes(piece.id)}
              onPress={() => voteFor(piece)}
              style={[styles.voteButton, votedIds.includes(piece.id) && styles.voteButtonDisabled]}
            >
              <Text style={styles.voteText}>{voteCounts[piece.id].toLocaleString()}</Text>
              <Text style={styles.voteLabel}>votes</Text>
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10
  },
  audience: {
    color: "#0f766e",
    fontSize: 12,
    fontWeight: "900"
  },
  count: {
    backgroundColor: "#e0f2fe",
    borderRadius: 999,
    color: "#075985",
    fontSize: 12,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  eventCard: {
    backgroundColor: "#fbfdfd",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 7,
    padding: 12
  },
  eventTheme: {
    color: "#475569",
    fontSize: 14,
    lineHeight: 20
  },
  eventTitle: {
    color: "#0f172a",
    flex: 1,
    fontSize: 15,
    fontWeight: "900"
  },
  eventTopline: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  galleryArt: {
    backgroundColor: "#f8fafc",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    height: 72,
    overflow: "hidden",
    position: "relative",
    width: 88
  },
  galleryCard: {
    alignItems: "center",
    backgroundColor: "#fbfdfd",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 10
  },
  galleryCopy: {
    flex: 1
  },
  galleryStrokeOne: {
    borderRadius: 999,
    height: 14,
    left: 9,
    position: "absolute",
    top: 15,
    transform: [{ rotate: "12deg" }],
    width: 68
  },
  galleryStrokeThree: {
    borderRadius: 999,
    bottom: 16,
    height: 13,
    left: 23,
    position: "absolute",
    transform: [{ rotate: "-26deg" }],
    width: 46
  },
  galleryStrokeTwo: {
    borderRadius: 999,
    bottom: -12,
    height: 52,
    position: "absolute",
    right: -12,
    width: 52
  },
  galleryTitle: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "900"
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
    fontSize: 16,
    fontWeight: "800",
    minHeight: 46,
    paddingHorizontal: 12
  },
  meta: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  miniTag: {
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 999,
    borderWidth: 1,
    color: "#334155",
    fontSize: 11,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 4
  },
  notice: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "800",
    lineHeight: 18
  },
  roleGrid: {
    flexDirection: "row",
    gap: 8
  },
  roleNote: {
    color: "#475569",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18
  },
  rolePill: {
    backgroundColor: "#ecfdf5",
    borderColor: "#99f6e4",
    borderRadius: 8,
    borderWidth: 1,
    color: "#0f766e",
    flex: 1,
    fontSize: 12,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 8,
    textAlign: "center"
  },
  roomArt: {
    backgroundColor: "#f8fafc",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    height: 124,
    overflow: "hidden",
    position: "relative"
  },
  roomCard: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 12
  },
  roomRing: {
    borderColor: "#111827",
    borderRadius: 999,
    borderWidth: 10,
    height: 72,
    left: 26,
    opacity: 0.88,
    position: "absolute",
    top: 20,
    width: 72
  },
  roomStrokeOne: {
    borderRadius: 999,
    height: 14,
    left: 22,
    position: "absolute",
    top: 44,
    transform: [{ rotate: "18deg" }],
    width: 148
  },
  roomStrokeTwo: {
    borderRadius: 999,
    height: 28,
    left: 68,
    opacity: 0.76,
    position: "absolute",
    top: 78,
    transform: [{ rotate: "-22deg" }],
    width: 110
  },
  roomTitle: {
    color: "#0f172a",
    fontSize: 19,
    fontWeight: "900"
  },
  roomTopic: {
    color: "#475569",
    fontSize: 14,
    lineHeight: 20
  },
  roomTopline: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  screen: {
    gap: 14,
    padding: 16,
    paddingBottom: 28
  },
  searchBox: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14
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
    flex: 1,
    fontSize: 18,
    fontWeight: "900"
  },
  statusPill: {
    backgroundColor: "#dcfce7",
    borderRadius: 999,
    color: "#166534",
    fontSize: 11,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 4
  },
  subtitle: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  tagChip: {
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  tagChipActive: {
    backgroundColor: "#ccfbf1",
    borderColor: "#0f766e"
  },
  tagText: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "900"
  },
  tagTextActive: {
    color: "#134e4a"
  },
  tagWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  title: {
    color: "#0f172a",
    fontSize: 26,
    fontWeight: "900"
  },
  titleBlock: {
    flex: 1
  },
  voteButton: {
    alignItems: "center",
    backgroundColor: "#111827",
    borderRadius: 8,
    minHeight: 50,
    minWidth: 70,
    justifyContent: "center",
    paddingHorizontal: 10
  },
  voteButtonDisabled: {
    opacity: 0.5
  },
  voteLabel: {
    color: "#cbd5e1",
    fontSize: 11,
    fontWeight: "900"
  },
  voteText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "900"
  }
});
