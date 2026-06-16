import { ArrowLeft, Pause, Play, Repeat, Share2, Sparkles } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Slider from "@react-native-community/slider";
import * as Sharing from "expo-sharing";
import {
  AlphaType,
  ColorType,
  Skia
} from "@shopify/react-native-skia";

import { IconButton } from "./IconButton";
import { bytesToBase64, encodeGif, type RgbaFrame } from "../gif";
import { makeSpaceAssetId, upsertSpaceAsset } from "../paintSpace";
import { loadReplaySnapshots } from "../replay";
import { timelapseExportPath, writePng } from "../storage";
import type { DrawingProject, ReplaySnapshot, SpaceAsset, TimelapsePayload } from "../types";

type Props = {
  project: DrawingProject;
  onBack: () => void;
  // Remix: start a NEW artwork from the selected snapshot PNG (reuses the
  // new-project-from-image path in App).
  onRemixFromSnapshot: (uri: string, sourceTitle: string) => void;
};

// Flipbook playback speeds (frames per second).
const SPEEDS: Array<{ label: string; fps: number }> = [
  { label: "0.5x", fps: 4 },
  { label: "1x", fps: 8 },
  { label: "2x", fps: 16 },
  { label: "4x", fps: 32 }
];

// Per-frame delay in the exported GIF timelapse (ms). 8fps-ish playback.
const TIMELAPSE_FRAME_MS = 120;

export function ReplayScreen({ project, onBack, onRemixFromSnapshot }: Props) {
  const [snapshots, setSnapshots] = useState<ReplaySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const loaded = await loadReplaySnapshots(project.id);
      if (active) {
        setSnapshots(loaded);
        setIndex(loaded.length > 0 ? 0 : 0);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [project.id]);

  const count = snapshots.length;
  const fps = SPEEDS[speedIndex].fps;
  const current = snapshots[Math.min(index, Math.max(0, count - 1))];

  // Flipbook playback: advance the index at the selected fps; stop at the end.
  useEffect(() => {
    if (playTimerRef.current) {
      clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
    if (!isPlaying || count === 0) {
      return;
    }
    playTimerRef.current = setTimeout(() => {
      setIndex((value) => {
        const next = value + 1;
        if (next >= count) {
          setIsPlaying(false);
          return count - 1;
        }
        return next;
      });
    }, Math.max(20, Math.round(1000 / fps)));
    return () => {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [count, fps, index, isPlaying]);

  useEffect(() => {
    return () => {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
      }
    };
  }, []);

  const togglePlay = useCallback(() => {
    if (count === 0) {
      return;
    }
    setIsPlaying((playing) => {
      if (!playing && index >= count - 1) {
        setIndex(0);
      }
      return !playing;
    });
  }, [count, index]);

  // Decode the snapshot PNG files into RGBA frames and encode a GIF via the
  // existing async-yielding encoder (gif.ts). Returns the export uri.
  const buildTimelapseGif = useCallback(async (): Promise<{ uri: string; frameCount: number; durationMs: number }> => {
    if (count < 2) {
      throw new Error("Keep painting — a timelapse needs at least 2 snapshots.");
    }
    const rgbaFrames: RgbaFrame[] = [];
    for (const snap of snapshots) {
      const base64 = await readBase64(snap.uri);
      if (!base64) {
        continue;
      }
      const data = Skia.Data.fromBase64(base64);
      const image = Skia.Image.MakeImageFromEncoded(data);
      if (!image) {
        continue;
      }
      try {
        const w = image.width();
        const h = image.height();
        const pixels = image.readPixels(0, 0, {
          width: w,
          height: h,
          colorType: ColorType.RGBA_8888,
          alphaType: AlphaType.Unpremul
        });
        if (pixels && pixels instanceof Uint8Array && pixels.length === w * h * 4) {
          rgbaFrames.push({ width: w, height: h, data: pixels, delayMs: TIMELAPSE_FRAME_MS });
        }
      } finally {
        image.dispose();
      }
    }
    if (rgbaFrames.length < 2) {
      throw new Error("Could not read snapshot pixels on this device build.");
    }
    const bytes = await encodeGif(rgbaFrames);
    const base64 = bytesToBase64(bytes);
    const uri = timelapseExportPath(project.id, "gif");
    await writePng(uri, base64); // writes base64 to file (encoding-agnostic)
    return { uri, frameCount: rgbaFrames.length, durationMs: rgbaFrames.length * TIMELAPSE_FRAME_MS };
  }, [count, project.id, snapshots]);

  const exportTimelapse = useCallback(async () => {
    setBusyLabel("Encoding timelapse...");
    try {
      const { uri } = await buildTimelapseGif();
      const available = await Sharing.isAvailableAsync();
      if (available) {
        await Sharing.shareAsync(uri, { dialogTitle: "Share timelapse GIF", mimeType: "image/gif" });
      } else {
        Alert.alert("Saved timelapse", uri);
      }
    } catch (error) {
      Alert.alert("Timelapse failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setBusyLabel(null);
    }
  }, [buildTimelapseGif]);

  const saveTimelapseToSpace = useCallback(async () => {
    setBusyLabel("Saving timelapse...");
    try {
      const { uri, frameCount, durationMs } = await buildTimelapseGif();
      const payload: TimelapsePayload = { uri, format: "gif", frameCount, durationMs };
      const asset: SpaceAsset = {
        id: makeSpaceAssetId(),
        kind: "timelapse",
        title: `${project.title} timelapse`,
        payload,
        thumbnail: current?.uri,
        previewUri: current?.uri,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // Exported clips are surfaced socially -> carry the safety gate.
        visibility: "private",
        moderation_status: "pending"
      };
      await upsertSpaceAsset(asset);
      Alert.alert("Saved to Paint Space", "Your timelapse is in the locker.");
    } catch (error) {
      Alert.alert("Save failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setBusyLabel(null);
    }
  }, [buildTimelapseGif, current?.uri, project.title]);

  const remix = useCallback(() => {
    if (!current) {
      return;
    }
    onRemixFromSnapshot(current.uri, project.title);
  }, [current, onRemixFromSnapshot, project.title]);

  const subtitle = useMemo(
    () =>
      count === 0
        ? "Keep painting — snapshots are captured automatically while you draw."
        : `${count} snapshot${count === 1 ? "" : "s"} of your process. Snapshot-based replay (not stroke-by-stroke).`,
    [count]
  );

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Back" onPress={onBack} />
        <View style={styles.titleBlock}>
          <Text style={styles.title}>Replay & Timelapse</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.emptyState}>
          <ActivityIndicator color="#0f766e" />
        </View>
      ) : count === 0 ? (
        <View style={styles.emptyState}>
          <Repeat size={44} color="#64748b" strokeWidth={1.8} />
          <Text style={styles.emptyTitle}>No replay yet.</Text>
          <Text style={styles.emptyText}>
            Snapshots are captured automatically as you paint. Come back after drawing for a bit.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.stage}>
            {current ? <Image resizeMode="contain" source={{ uri: current.uri }} style={styles.stageImage} /> : null}
          </View>

          <View style={styles.panel}>
            <View style={styles.controlsRow}>
              <IconButton icon={isPlaying ? Pause : Play} label={isPlaying ? "Pause" : "Play"} onPress={togglePlay} />
              <Text style={styles.counter}>
                {Math.min(index + 1, count)}/{count}
              </Text>
            </View>
            <Slider
              maximumTrackTintColor="#cbd5e1"
              maximumValue={Math.max(0, count - 1)}
              minimumTrackTintColor="#0f766e"
              minimumValue={0}
              onValueChange={(value) => {
                setIsPlaying(false);
                setIndex(Math.round(value));
              }}
              step={1}
              thumbTintColor="#0f766e"
              value={Math.min(index, Math.max(0, count - 1))}
            />

            <Text style={styles.controlLabel}>Speed</Text>
            <View style={styles.segmentRow}>
              {SPEEDS.map((speed, speedIdx) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: speedIndex === speedIdx }}
                  key={speed.label}
                  onPress={() => setSpeedIndex(speedIdx)}
                  style={[styles.segment, speedIndex === speedIdx && styles.segmentActive]}
                >
                  <Text style={[styles.segmentText, speedIndex === speedIdx && styles.segmentTextActive]}>{speed.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Make something from it</Text>
            <View style={styles.toolbar}>
              <IconButton icon={Sparkles} label="Remix from here" onPress={remix} />
              <IconButton icon={Share2} label="Export timelapse" onPress={() => void exportTimelapse()} disabled={!!busyLabel} />
              <IconButton icon={Repeat} label="Save to Space" onPress={() => void saveTimelapseToSpace()} disabled={!!busyLabel} />
            </View>
          </View>
        </>
      )}

      <Modal animationType="fade" transparent visible={!!busyLabel}>
        <View style={styles.modalBackdrop}>
          <View style={styles.busyCard}>
            <ActivityIndicator color="#0f766e" />
            <Text style={styles.busyText}>{busyLabel}</Text>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// Read a file uri as a base64 string. Lazily imports expo-file-system (legacy)
// so this stays consistent with storage.ts's import style.
async function readBase64(uri: string): Promise<string | null> {
  try {
    const FileSystem = await import("expo-file-system/legacy");
    return await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  busyCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 12,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16
  },
  busyText: {
    color: "#0f172a",
    fontSize: 14,
    fontWeight: "800"
  },
  controlLabel: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "900",
    marginBottom: 8,
    marginTop: 10
  },
  controlsRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between"
  },
  counter: {
    color: "#0f766e",
    fontSize: 15,
    fontWeight: "900"
  },
  emptyState: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 24
  },
  emptyText: {
    color: "#64748b",
    fontSize: 15,
    lineHeight: 21,
    maxWidth: 280,
    textAlign: "center"
  },
  emptyTitle: {
    color: "#0f172a",
    fontSize: 20,
    fontWeight: "900"
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.45)",
    flex: 1,
    justifyContent: "center",
    padding: 24
  },
  panel: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 12
  },
  panelTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900"
  },
  screen: {
    gap: 14,
    padding: 16,
    paddingBottom: 28
  },
  segment: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    flexGrow: 1,
    minHeight: 40,
    minWidth: 64,
    paddingHorizontal: 10,
    paddingVertical: 10
  },
  segmentActive: {
    backgroundColor: "#ccfbf1",
    borderColor: "#0f766e"
  },
  segmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  segmentText: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "800"
  },
  segmentTextActive: {
    color: "#134e4a"
  },
  stage: {
    alignItems: "center",
    aspectRatio: 4 / 3,
    backgroundColor: "#ffffff",
    borderColor: "#1f2937",
    borderRadius: 8,
    borderWidth: 2,
    justifyContent: "center",
    overflow: "hidden",
    width: "100%"
  },
  stageImage: {
    height: "100%",
    width: "100%"
  },
  subtitle: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  title: {
    color: "#0f172a",
    fontSize: 22,
    fontWeight: "900"
  },
  titleBlock: {
    flex: 1,
    minWidth: 0
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  }
});
