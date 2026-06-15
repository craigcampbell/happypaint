import Slider from "@react-native-community/slider";
import {
  ArrowLeft,
  Download,
  Eraser,
  FileImage,
  FolderOpen,
  ImagePlus,
  RotateCcw,
  Save,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2
} from "lucide-react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  Canvas,
  Circle,
  Group,
  Image as SkiaImage,
  Path,
  Rect,
  Skia,
  useCanvasRef,
  useImage
} from "@shopify/react-native-skia";

import { BRUSHES, CANVAS_ASPECT_RATIO, COLORS, TEXTURES } from "../constants";
import { copyImportAsync, exportPath, previewPath, writePng } from "../storage";
import type { BrushId, BrushSettings, DrawPoint, DrawingProject, SprayDot, Stroke, TextureId } from "../types";
import { IconButton } from "./IconButton";

type Props = {
  calmMode: boolean;
  premiumPreview: boolean;
  project: DrawingProject;
  settings: BrushSettings;
  onBack: () => void;
  onOpenSettings: () => void;
  onProjectChange: (project: DrawingProject) => void;
  onSettingsChange: (settings: BrushSettings) => void;
};

type CanvasSize = {
  width: number;
  height: number;
};

const MIN_CANVAS_WIDTH = 240;

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function makePoint(x: number, y: number, settings: BrushSettings): DrawPoint {
  const jitter = 1 + (Math.random() * 2 - 1) * settings.variation;
  return {
    x,
    y,
    size: Math.max(1, settings.size * jitter)
  };
}

function makeSprayDots(point: DrawPoint): SprayDot[] {
  const dots = clamp(Math.floor(point.size * 1.4), 10, 72);
  return Array.from({ length: dots }, () => {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * point.size;
    return {
      x: point.x + Math.cos(angle) * radius,
      y: point.y + Math.sin(angle) * radius,
      radius: Math.max(0.8, Math.random() * 2.4)
    };
  });
}

function pointSpacing(settings: BrushSettings) {
  if (settings.brush === "spray") {
    return Math.max(7, settings.size * 0.36);
  }

  if (settings.brush === "eraser") {
    return Math.max(4, settings.size * 0.22);
  }

  if (settings.brush === "pencil") {
    return Math.max(2, settings.size * 0.1);
  }

  return Math.max(3, settings.size * 0.14);
}

function makePath(points: DrawPoint[]) {
  const path = Skia.Path.Make();
  if (points.length === 0) {
    return path;
  }

  path.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midX = (previous.x + current.x) / 2;
    const midY = (previous.y + current.y) / 2;
    path.quadTo(previous.x, previous.y, midX, midY);
  }
  return path;
}

function makeSprayPath(dots: SprayDot[]) {
  const path = Skia.Path.Make();

  for (const dot of dots) {
    path.addCircle(dot.x, dot.y, dot.radius);
  }

  return path;
}

type StrokeNodeProps = {
  paperBackground: string;
  stroke: Stroke;
};

const StrokeNode = memo(function StrokeNode({ stroke, paperBackground }: StrokeNodeProps) {
  const path = useMemo(() => makePath(stroke.points), [stroke.points, stroke.points.length]);
  const sprayPath = useMemo(
    () => makeSprayPath(stroke.sprayDots ?? []),
    [stroke.sprayDots, stroke.sprayDots?.length]
  );

  if (stroke.brush === "marker") {
    return (
      <Path
        path={path}
        color={stroke.color}
        opacity={stroke.opacity}
        strokeCap="round"
        strokeJoin="round"
        strokeWidth={stroke.size}
        style="stroke"
      />
    );
  }

  if (stroke.brush === "pencil") {
    return (
      <Path
        path={path}
        color={stroke.color}
        opacity={stroke.opacity * 0.72}
        strokeCap="round"
        strokeJoin="round"
        strokeWidth={Math.max(1, stroke.size * 0.62)}
        style="stroke"
      />
    );
  }

  if (stroke.brush === "spray") {
    return (
      <Path path={sprayPath} color={stroke.color} opacity={stroke.opacity} />
    );
  }

  if (stroke.brush === "eraser") {
    return (
      <Path
        path={path}
        color={paperBackground}
        opacity={1}
        strokeCap="round"
        strokeJoin="round"
        strokeWidth={stroke.size * 1.35}
        style="stroke"
      />
    );
  }

  if (stroke.brush === "glow") {
    return (
      <Group>
        <Path
          path={path}
          color={stroke.color}
          opacity={stroke.opacity * 0.34}
          strokeCap="round"
          strokeJoin="round"
          strokeWidth={stroke.size * 1.6}
          style="stroke"
        />
        <Path
          path={path}
          color={stroke.color}
          opacity={stroke.opacity * 0.84}
          strokeCap="round"
          strokeJoin="round"
          strokeWidth={stroke.size * 0.82}
          style="stroke"
        />
        <Path
          path={path}
          color="#ffffff"
          opacity={stroke.opacity * 0.36}
          strokeCap="round"
          strokeJoin="round"
          strokeWidth={Math.max(1, stroke.size * 0.22)}
          style="stroke"
        />
      </Group>
    );
  }

  return (
    <Group>
      <Path
        path={path}
        color={stroke.color}
        opacity={stroke.opacity * 0.82}
        strokeCap="round"
        strokeJoin="round"
        strokeWidth={stroke.size * 1.08}
        style="stroke"
      />
      {stroke.points.slice(-24).map((point, index) => (
        <Circle color={stroke.color} cx={point.x} cy={point.y} key={`${stroke.id}-${index}`} opacity={stroke.opacity * 0.22} r={point.size * 0.2} />
      ))}
    </Group>
  );
}, (previous, next) => previous.stroke === next.stroke && previous.paperBackground === next.paperBackground);

export function StudioScreen({
  calmMode,
  premiumPreview,
  project,
  settings,
  onBack,
  onOpenSettings,
  onProjectChange,
  onSettingsChange
}: Props) {
  const canvasRef = useCanvasRef();
  const linenImage = useImage(require("../../assets/linen.png"));
  const canvasImage = useImage(require("../../assets/canvas.png"));
  const importedImage = useImage(project.importedImageUri ?? "");
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: MIN_CANVAS_WIDTH, height: MIN_CANVAS_WIDTH / CANVAS_ASPECT_RATIO });
  const [liveStroke, setLiveStroke] = useState<Stroke | null>(null);
  const activeStrokeRef = useRef<Stroke | null>(null);
  const lastPointRef = useRef<DrawPoint | null>(null);
  const rafRef = useRef<number | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const textureImage = settings.texture === "linen" ? linenImage : settings.texture === "canvas" ? canvasImage : null;
  const textureMeta = TEXTURES.find((texture) => texture.id === settings.texture) ?? TEXTURES[0];
  const paperBackground = textureMeta.background;
  const latestProject = useMemo(
    () => ({
      ...project,
      texture: settings.texture
    }),
    [project, settings.texture]
  );

  const updateSettings = useCallback(
    (patch: Partial<BrushSettings>) => {
      onSettingsChange({ ...settings, ...patch });
    },
    [onSettingsChange, settings]
  );

  const captureToUri = useCallback(
    async (uri: string) => {
      const image = canvasRef.current?.makeImageSnapshot();
      const base64 = image?.encodeToBase64();
      if (!base64) {
        throw new Error("The painting is still getting ready.");
      }
      await writePng(uri, base64);
      return uri;
    },
    [canvasRef]
  );

  const savePreview = useCallback(
    async (nextProject: DrawingProject) => {
      try {
        const uri = await captureToUri(previewPath(nextProject.id));
        onProjectChange({ ...nextProject, previewUri: `${uri}?updated=${Date.now()}` });
      } catch {
        onProjectChange(nextProject);
      }
    },
    [captureToUri, onProjectChange]
  );

  const schedulePreviewSave = useCallback(
    (nextProject: DrawingProject) => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }

      previewTimerRef.current = setTimeout(() => {
        previewTimerRef.current = null;
        void savePreview(nextProject);
      }, 420);
    },
    [savePreview]
  );

  useEffect(() => {
    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const scheduleLiveStrokeRender = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setLiveStroke(
        activeStrokeRef.current
          ? {
              ...activeStrokeRef.current,
              points: activeStrokeRef.current.points,
              sprayDots: activeStrokeRef.current.sprayDots
            }
          : null
      );
    });
  }, []);

  const addStrokePoint = useCallback(
    (x: number, y: number) => {
      const stroke = activeStrokeRef.current;
      if (!stroke) {
        return;
      }

      const point = makePoint(clamp(x, 0, canvasSize.width), clamp(y, 0, canvasSize.height), settings);
      const previous = lastPointRef.current;
      const points: DrawPoint[] = [];

      if (previous) {
        const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
        const steps = Math.max(1, Math.floor(distance / pointSpacing(settings)));
        for (let index = 1; index <= steps; index += 1) {
          const t = index / steps;
          points.push(
            makePoint(
              previous.x + (point.x - previous.x) * t,
              previous.y + (point.y - previous.y) * t,
              settings
            )
          );
        }
      } else {
        points.push(point);
      }

      stroke.points.push(...points);
      if (stroke.brush === "spray") {
        const sprayDots = stroke.sprayDots ?? [];
        for (const sprayedPoint of points) {
          sprayDots.push(...makeSprayDots(sprayedPoint));
        }
        stroke.sprayDots = sprayDots;
      }

      lastPointRef.current = point;
      scheduleLiveStrokeRender();
    },
    [canvasSize.height, canvasSize.width, scheduleLiveStrokeRender, settings]
  );

  const finishStroke = useCallback(() => {
    const stroke = activeStrokeRef.current;
    activeStrokeRef.current = null;
    lastPointRef.current = null;
    setLiveStroke(null);

    if (!stroke || stroke.points.length === 0) {
      return;
    }

    const nextProject: DrawingProject = {
      ...latestProject,
      strokes: [...latestProject.strokes, stroke],
      updatedAt: Date.now()
    };
    onProjectChange(nextProject);
    schedulePreviewSave(nextProject);
  }, [latestProject, onProjectChange, schedulePreviewSave]);

  const startStroke = useCallback(
    (x: number, y: number) => {
      const stroke: Stroke = {
        id: makeId("stroke"),
        brush: settings.brush,
        color: settings.color,
        opacity: settings.opacity,
        size: settings.size,
        variation: settings.variation,
        points: [],
        sprayDots: settings.brush === "spray" ? [] : undefined
      };
      activeStrokeRef.current = stroke;
      lastPointRef.current = null;
      addStrokePoint(x, y);
    },
    [addStrokePoint, settings]
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          startStroke(event.nativeEvent.locationX, event.nativeEvent.locationY);
        },
        onPanResponderMove: (event) => {
          addStrokePoint(event.nativeEvent.locationX, event.nativeEvent.locationY);
        },
        onPanResponderRelease: finishStroke,
        onPanResponderTerminate: finishStroke,
        onStartShouldSetPanResponder: () => true
      }),
    [addStrokePoint, finishStroke, startStroke]
  );

  const undo = useCallback(() => {
    if (latestProject.strokes.length === 0) {
      return;
    }
    const nextProject = {
      ...latestProject,
      strokes: latestProject.strokes.slice(0, -1),
      updatedAt: Date.now()
    };
    onProjectChange(nextProject);
    schedulePreviewSave(nextProject);
  }, [latestProject, onProjectChange, schedulePreviewSave]);

  const clear = useCallback(() => {
    Alert.alert("Clear painting?", "This removes every mark from this artwork.", [
      { text: "Keep drawing", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          const nextProject = { ...latestProject, strokes: [], updatedAt: Date.now() };
          onProjectChange(nextProject);
          schedulePreviewSave(nextProject);
        }
      }
    ]);
  }, [latestProject, onProjectChange, schedulePreviewSave]);

  const importFromPhotos = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: false,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1
    });
    if (result.canceled || !result.assets[0]?.uri) {
      return;
    }
    const importedUri = await copyImportAsync(result.assets[0].uri, latestProject.id);
    const nextProject = { ...latestProject, importedImageUri: importedUri, updatedAt: Date.now() };
    onProjectChange(nextProject);
  }, [latestProject, onProjectChange]);

  const importFromFiles = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: "image/*"
    });
    if (result.canceled || !result.assets[0]?.uri) {
      return;
    }
    const importedUri = await copyImportAsync(result.assets[0].uri, latestProject.id);
    const nextProject = { ...latestProject, importedImageUri: importedUri, updatedAt: Date.now() };
    onProjectChange(nextProject);
  }, [latestProject, onProjectChange]);

  const exportPng = useCallback(async () => {
    try {
      const uri = await captureToUri(exportPath(latestProject.id));
      Alert.alert("Saved PNG", uri);
    } catch (error) {
      Alert.alert("Export failed", error instanceof Error ? error.message : "Please try again.");
    }
  }, [captureToUri, latestProject.id]);

  const sharePng = useCallback(async () => {
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert("Sharing unavailable", "This device cannot open the share sheet right now.");
        return;
      }
      const uri = await captureToUri(exportPath(latestProject.id));
      await Sharing.shareAsync(uri, {
        dialogTitle: "Share Happy Paint artwork",
        mimeType: "image/png"
      });
    } catch (error) {
      Alert.alert("Share failed", error instanceof Error ? error.message : "Please try again.");
    }
  }, [captureToUri, latestProject.id]);

  const saveToPhotos = useCallback(async () => {
    try {
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Photos permission needed", "Allow photo access to save your painting.");
        return;
      }
      const uri = await captureToUri(exportPath(latestProject.id));
      await MediaLibrary.saveToLibraryAsync(uri);
      Alert.alert("Saved to photos", "Your painting is now in the device photo library.");
    } catch (error) {
      Alert.alert("Save failed", error instanceof Error ? error.message : "Please try again.");
    }
  }, [captureToUri, latestProject.id]);

  return (
    <ScrollView contentContainerStyle={[styles.screen, calmMode && styles.calmScreen]}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Gallery" onPress={onBack} />
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{project.title}</Text>
          <Text style={styles.subtitle}>Autosaves while you paint</Text>
        </View>
        <IconButton icon={SlidersHorizontal} label="Settings" onPress={onOpenSettings} />
      </View>

      <View
        onLayout={(event) => {
          const width = Math.max(MIN_CANVAS_WIDTH, event.nativeEvent.layout.width);
          setCanvasSize({ width, height: width / CANVAS_ASPECT_RATIO });
        }}
        style={styles.canvasShell}
      >
        <View style={[styles.canvasFrame, { height: canvasSize.height }]} {...panResponder.panHandlers}>
          <Canvas ref={canvasRef} style={styles.canvas}>
            <Rect color={paperBackground} height={canvasSize.height} width={canvasSize.width} x={0} y={0} />
            {textureImage ? (
              <SkiaImage
                fit="cover"
                height={canvasSize.height}
                image={textureImage}
                opacity={0.42}
                width={canvasSize.width}
                x={0}
                y={0}
              />
            ) : null}
            {importedImage ? (
              <SkiaImage
                fit="contain"
                height={canvasSize.height}
                image={importedImage}
                opacity={0.72}
                width={canvasSize.width}
                x={0}
                y={0}
              />
            ) : null}
            {latestProject.strokes.map((stroke) => (
              <StrokeNode key={stroke.id} paperBackground={paperBackground} stroke={stroke} />
            ))}
            {liveStroke ? <StrokeNode paperBackground={paperBackground} stroke={liveStroke} /> : null}
          </Canvas>
        </View>
      </View>

      <View style={styles.toolbar}>
        <IconButton icon={RotateCcw} label="Undo" onPress={undo} disabled={latestProject.strokes.length === 0} />
        <IconButton icon={Trash2} label="Clear" onPress={clear} tone="danger" />
        <IconButton icon={Share2} label="Share" onPress={sharePng} />
        <IconButton icon={Save} label="Export" onPress={exportPng} />
        <IconButton icon={Download} label="Photos" onPress={saveToPhotos} />
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <Sparkles size={20} color="#0f172a" />
          <Text style={styles.panelTitle}>Brush</Text>
        </View>

        <View style={styles.segmentRow}>
          {BRUSHES.map((brush) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: settings.brush === brush.id }}
              key={brush.id}
              onPress={() => {
                if (brush.tier === "studio" && !premiumPreview) {
                  Alert.alert("Drops preview", "Turn on Drops preview in Settings to try this pack placeholder.");
                  return;
                }
                updateSettings({ brush: brush.id as BrushId });
              }}
              style={[styles.segment, settings.brush === brush.id && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, settings.brush === brush.id && styles.segmentTextActive]}>
                {brush.label}
                {brush.tier === "studio" && !premiumPreview ? " +" : ""}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.controlLabel}>Color</Text>
        <View style={styles.swatches}>
          {COLORS.map((color) => (
            <Pressable
              accessibilityLabel={`Use ${color}`}
              accessibilityRole="button"
              key={color}
              onPress={() => updateSettings({ color })}
              style={[
                styles.swatch,
                { backgroundColor: color },
                settings.color === color && styles.swatchActive,
                color === "#ffffff" && styles.whiteSwatch
              ]}
            />
          ))}
        </View>

        <SliderControl label="Size" maximum={72} minimum={2} step={1} value={settings.size} onChange={(size) => updateSettings({ size })} />
        <SliderControl
          label="Variation"
          maximum={0.8}
          minimum={0}
          step={0.05}
          value={settings.variation}
          onChange={(variation) => updateSettings({ variation })}
        />
        <SliderControl
          label="Opacity"
          maximum={1}
          minimum={0.15}
          step={0.05}
          value={settings.opacity}
          onChange={(opacity) => updateSettings({ opacity })}
        />
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <FileImage size={20} color="#0f172a" />
          <Text style={styles.panelTitle}>Paper and import</Text>
        </View>
        <View style={styles.segmentRow}>
          {TEXTURES.map((texture) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: settings.texture === texture.id }}
              key={texture.id}
              onPress={() => {
                if (texture.tier === "studio" && !premiumPreview) {
                  Alert.alert("Drops preview", "Turn on Drops preview in Settings to try this paper placeholder.");
                  return;
                }
                updateSettings({ texture: texture.id as TextureId });
              }}
              style={[styles.segment, settings.texture === texture.id && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, settings.texture === texture.id && styles.segmentTextActive]}>
                {texture.label}
                {texture.tier === "studio" && !premiumPreview ? " +" : ""}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.toolbar}>
          <IconButton icon={ImagePlus} label="Photo" onPress={importFromPhotos} />
          <IconButton icon={FolderOpen} label="File" onPress={importFromFiles} />
          <IconButton
            icon={Eraser}
            label="Remove import"
            onPress={() => onProjectChange({ ...latestProject, importedImageUri: undefined, updatedAt: Date.now() })}
            disabled={!latestProject.importedImageUri}
          />
        </View>
      </View>
    </ScrollView>
  );
}

function SliderControl({
  label,
  maximum,
  minimum,
  onChange,
  step,
  value
}: {
  label: string;
  maximum: number;
  minimum: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  const displayValue = maximum <= 1 ? Math.round(value * 100) : Math.round(value);

  return (
    <View style={styles.sliderRow}>
      <View style={styles.sliderHeader}>
        <Text style={styles.controlLabel}>{label}</Text>
        <Text style={styles.valueLabel}>{displayValue}</Text>
      </View>
      <Slider
        maximumTrackTintColor="#cbd5e1"
        maximumValue={maximum}
        minimumTrackTintColor="#0f766e"
        minimumValue={minimum}
        onSlidingComplete={onChange}
        step={step}
        thumbTintColor="#0f766e"
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  calmScreen: {
    gap: 18
  },
  canvas: {
    flex: 1
  },
  canvasFrame: {
    backgroundColor: "#ffffff",
    borderColor: "#1f2937",
    borderRadius: 8,
    borderWidth: 2,
    overflow: "hidden",
    width: "100%"
  },
  canvasShell: {
    width: "100%"
  },
  controlLabel: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "900",
    marginBottom: 8,
    marginTop: 10
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  panel: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    padding: 12
  },
  panelHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginBottom: 10
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
    minWidth: 76,
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
  sliderHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  sliderRow: {
    marginTop: 4
  },
  subtitle: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  swatch: {
    borderColor: "#ffffff",
    borderRadius: 18,
    borderWidth: 3,
    height: 36,
    width: 36
  },
  swatchActive: {
    borderColor: "#0f172a",
    transform: [{ scale: 1.08 }]
  },
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 6
  },
  title: {
    color: "#0f172a",
    fontSize: 20,
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
  },
  valueLabel: {
    color: "#0f766e",
    fontSize: 13,
    fontWeight: "900"
  },
  whiteSwatch: {
    borderColor: "#cbd5e1"
  }
});
