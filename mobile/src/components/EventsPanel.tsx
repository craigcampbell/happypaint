import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CalendarDays, Sparkles, Trophy } from "lucide-react-native";

import {
  castVote,
  formatCountdown,
  getEventEntries,
  getSurfaceEvents,
  getWinner,
  nextPhase,
  PROMPT_PACKS,
  promptOfTheDay,
  readVotedPostIds,
  type EventEntry,
  type SurfaceEvent,
  type TimedEventStatus
} from "../eventEngine";
import { IconButton } from "./IconButton";

type Props = {
  // Open the studio for an event's prompt. `prompt` may seed the studio later.
  onEnterStudio: (prompt: string) => void;
  // Filter events to the discovery search (matches title/theme/tags).
  matches: (item: { title?: string; theme?: string; tags?: string[] }) => boolean;
};

const STATUS_STYLE: Record<TimedEventStatus, { bg: string; fg: string; label: string }> = {
  upcoming: { bg: "#e0f2fe", fg: "#075985", label: "Upcoming" },
  live: { bg: "#dcfce7", fg: "#166534", label: "Live" },
  voting: { bg: "#fef3c7", fg: "#92400e", label: "Voting" },
  ended: { bg: "#e2e8f0", fg: "#475569", label: "Ended" },
  draft: { bg: "#e2e8f0", fg: "#475569", label: "Draft" },
  cancelled: { bg: "#fee2e2", fg: "#b91c1c", label: "Cancelled" }
};

function StatusPill({ status }: { status: TimedEventStatus }) {
  const style = STATUS_STYLE[status];
  return <Text style={[styles.statusPill, { backgroundColor: style.bg, color: style.fg }]}>{style.label}</Text>;
}

function EntryRow({
  entry,
  onVote
}: {
  entry: EventEntry;
  onVote: (entry: EventEntry) => void;
}) {
  return (
    <View style={styles.entryRow}>
      <View style={styles.entryArt}>
        {entry.palette.slice(0, 3).map((color, index) => (
          <View key={`${entry.id}-${index}`} style={[styles.entrySwatch, { backgroundColor: color }]} />
        ))}
      </View>
      <View style={styles.entryCopy}>
        <Text style={styles.entryTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {entry.roomTitle} · {entry.contributors} artists
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: entry.voted }}
        disabled={entry.voted}
        onPress={() => onVote(entry)}
        style={[styles.voteButton, entry.voted && styles.voteButtonVoted]}
      >
        <Text style={[styles.voteCount, entry.voted && styles.voteCountVoted]}>{entry.displayVotes.toLocaleString()}</Text>
        <Text style={[styles.voteLabel, entry.voted && styles.voteCountVoted]}>{entry.voted ? "voted" : "vote"}</Text>
      </Pressable>
    </View>
  );
}

function EventCard({
  event,
  votedPostIds,
  onEnterStudio,
  onVote
}: {
  event: SurfaceEvent;
  votedPostIds: string[];
  onEnterStudio: (prompt: string) => void;
  onVote: (entry: EventEntry) => void;
}) {
  const phase = nextPhase(event);
  const entries = useMemo(
    () => getEventEntries(event.id, votedPostIds),
    [event.id, votedPostIds]
  );
  const winner = event.status === "ended" ? getWinner(event.id, votedPostIds) : null;

  return (
    <View style={styles.eventCard}>
      <View style={styles.eventTopline}>
        <StatusPill status={event.status} />
        <Text style={styles.eventTitle} numberOfLines={1}>
          {event.title}
        </Text>
      </View>
      <Text style={styles.eventTheme}>{event.theme}</Text>
      {event.description ? <Text style={styles.eventDesc}>{event.description}</Text> : null}

      {phase.at ? (
        <Text style={styles.countdown}>
          {phase.label} {formatCountdown(phase.at)} · {event.roomCount} rooms
        </Text>
      ) : (
        <Text style={styles.countdown}>Results are final · {event.roomCount} rooms</Text>
      )}

      {event.status === "live" ? (
        <View style={styles.ctaRow}>
          <IconButton icon={Sparkles} label="Enter studio for this prompt" onPress={() => onEnterStudio(event.prompt)} tone="dark" />
        </View>
      ) : null}

      {event.status === "voting" ? (
        <View style={styles.entryList}>
          <Text style={styles.entryHeading}>Vote for an entry (one vote each)</Text>
          {entries.length > 0 ? (
            entries.map((entry) => <EntryRow entry={entry} key={entry.id} onVote={onVote} />)
          ) : (
            <Text style={styles.meta}>Entries appear here once rooms post their art.</Text>
          )}
        </View>
      ) : null}

      {event.status === "ended" ? (
        <View style={styles.entryList}>
          <View style={styles.winnerHeading}>
            <Trophy size={16} color="#92400e" strokeWidth={2.4} />
            <Text style={styles.winnerLabel}>Winner</Text>
          </View>
          {winner ? (
            <EntryRow entry={{ ...winner, voted: true }} onVote={() => undefined} />
          ) : (
            <Text style={styles.meta}>No entries were posted for this event.</Text>
          )}
        </View>
      ) : null}

      {event.status === "upcoming" ? (
        <Text style={styles.upcomingNote}>Starts soon. Come back when it goes live to enter the prompt.</Text>
      ) : null}
    </View>
  );
}

export function EventsPanel({ onEnterStudio, matches }: Props) {
  const [votedPostIds, setVotedPostIds] = useState<string[]>([]);
  const [notice, setNotice] = useState("Daily and weekend events. Kid-safe and friends only — no adult events.");

  useEffect(() => {
    let active = true;
    void readVotedPostIds().then((ids) => {
      if (active) {
        setVotedPostIds(ids);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const events = useMemo(() => getSurfaceEvents().filter((event) => matches(event)), [matches]);
  const dailyPack = PROMPT_PACKS.find((pack) => pack.kind === "daily");
  const weekendPack = PROMPT_PACKS.find((pack) => pack.kind === "weekend");

  const handleVote = useCallback(
    async (entry: EventEntry) => {
      const result = await castVote(entry.id);
      setVotedPostIds(result.votedPostIds);
      setNotice(result.ok ? `Vote added for ${entry.title}.` : `${entry.title} already has your vote.`);
    },
    []
  );

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <CalendarDays size={20} color="#0f172a" strokeWidth={2.4} />
        <Text style={styles.sectionTitle}>Events</Text>
        <Text style={styles.count}>{events.length}</Text>
      </View>

      <View style={styles.promptRow}>
        {dailyPack ? (
          <View style={styles.promptCard}>
            <Text style={styles.promptKind}>{dailyPack.title}</Text>
            <Text style={styles.promptCadence}>{dailyPack.cadence}</Text>
            <Text style={styles.promptText} numberOfLines={3}>
              {promptOfTheDay(dailyPack)}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => onEnterStudio(promptOfTheDay(dailyPack))}
              style={styles.promptButton}
            >
              <Text style={styles.promptButtonText}>Draw today's prompt</Text>
            </Pressable>
          </View>
        ) : null}
        {weekendPack ? (
          <View style={styles.promptCard}>
            <Text style={styles.promptKind}>{weekendPack.title}</Text>
            <Text style={styles.promptCadence}>{weekendPack.cadence}</Text>
            <Text style={styles.promptText} numberOfLines={3}>
              {promptOfTheDay(weekendPack)}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => onEnterStudio(promptOfTheDay(weekendPack))}
              style={styles.promptButton}
            >
              <Text style={styles.promptButtonText}>Take the challenge</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {events.map((event) => (
        <EventCard event={event} key={event.id} onEnterStudio={onEnterStudio} onVote={handleVote} votedPostIds={votedPostIds} />
      ))}

      <Text style={styles.notice}>{notice}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
  countdown: {
    color: "#0f766e",
    fontSize: 13,
    fontWeight: "900"
  },
  ctaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  entryArt: {
    backgroundColor: "#f8fafc",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 3,
    height: 44,
    overflow: "hidden",
    padding: 4,
    width: 56
  },
  entryCopy: {
    flex: 1,
    minWidth: 0
  },
  entryHeading: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "900"
  },
  entryList: {
    gap: 8
  },
  entryRow: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 8
  },
  entrySwatch: {
    borderRadius: 4,
    flex: 1
  },
  entryTitle: {
    color: "#0f172a",
    fontSize: 14,
    fontWeight: "900"
  },
  eventCard: {
    backgroundColor: "#fbfdfd",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 12
  },
  eventDesc: {
    color: "#64748b",
    fontSize: 13,
    lineHeight: 18
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
  meta: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  notice: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "800",
    lineHeight: 18
  },
  promptButton: {
    backgroundColor: "#111827",
    borderRadius: 8,
    marginTop: 4,
    paddingVertical: 8
  },
  promptButtonText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "900",
    textAlign: "center"
  },
  promptCadence: {
    color: "#0f766e",
    fontSize: 11,
    fontWeight: "900"
  },
  promptCard: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    gap: 6,
    padding: 10
  },
  promptKind: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "900"
  },
  promptRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12
  },
  promptText: {
    color: "#475569",
    fontSize: 13,
    lineHeight: 18
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
    borderRadius: 999,
    fontSize: 11,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 4
  },
  upcomingNote: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18
  },
  voteButton: {
    alignItems: "center",
    backgroundColor: "#111827",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 46,
    minWidth: 64,
    paddingHorizontal: 8
  },
  voteButtonVoted: {
    backgroundColor: "#dcfce7",
    borderColor: "#86efac",
    borderWidth: 1
  },
  voteCount: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "900"
  },
  voteCountVoted: {
    color: "#166534"
  },
  voteLabel: {
    color: "#cbd5e1",
    fontSize: 11,
    fontWeight: "900"
  },
  winnerHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6
  },
  winnerLabel: {
    color: "#92400e",
    fontSize: 13,
    fontWeight: "900"
  }
});
