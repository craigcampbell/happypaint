// Paint Orchestra sound mapping and Web Audio lifecycle.
//
// This module deliberately has no React or canvas dependencies. Drawing code can
// call playStroke() for local or relayed points; unsupported/disabled audio is a
// silent no-op, so sound can never interrupt painting.

export const PENTATONIC_INTERVALS = Object.freeze([0, 2, 4, 7, 9]);

const DEFAULT_ROOT_MIDI = 48; // C3
const DEFAULT_VOLUME = 0.55;
const DEFAULT_THROTTLE_MS = 65;
const DEFAULT_MAX_VOICES = 8;

const INSTRUMENTS = Object.freeze({
  marimba: Object.freeze({
    id: "marimba",
    label: "Marimba",
    wave: "sine",
    attack: 0.004,
    release: 0.18,
    octave: 0,
  }),
  pluck: Object.freeze({
    id: "pluck",
    label: "Plucked strings",
    wave: "triangle",
    attack: 0.003,
    release: 0.12,
    octave: 0,
  }),
  pad: Object.freeze({
    id: "pad",
    label: "Soft pads",
    wave: "sine",
    attack: 0.045,
    release: 0.42,
    octave: 0,
  }),
  shaker: Object.freeze({
    id: "shaker",
    label: "Shaker",
    wave: "sawtooth",
    attack: 0.002,
    release: 0.055,
    octave: 1,
  }),
  bass: Object.freeze({
    id: "bass",
    label: "Bass",
    wave: "square",
    attack: 0.008,
    release: 0.24,
    octave: -1,
  }),
  mutedPercussion: Object.freeze({
    id: "muted-percussion",
    label: "Muted percussion",
    wave: "triangle",
    attack: 0.002,
    release: 0.07,
    octave: -1,
  }),
  chime: Object.freeze({
    id: "chime",
    label: "Chimes",
    wave: "sine",
    attack: 0.003,
    release: 0.3,
    octave: 1,
  }),
});

export const BRUSH_INSTRUMENTS = Object.freeze({
  marker: INSTRUMENTS.marimba,
  crayon: INSTRUMENTS.pluck,
  pencil: INSTRUMENTS.pluck,
  paint: INSTRUMENTS.marimba,
  oil: INSTRUMENTS.bass,
  acrylic: INSTRUMENTS.marimba,
  watercolor: INSTRUMENTS.pad,
  gouache: INSTRUMENTS.pad,
  ink: INSTRUMENTS.pluck,
  spray: INSTRUMENTS.shaker,
  eraser: INSTRUMENTS.mutedPercussion,
  smudge: INSTRUMENTS.mutedPercussion,
  glow: INSTRUMENTS.chime,
});

export function clamp01(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return Math.max(0, Math.min(1, fallback));
  }
  return Math.max(0, Math.min(1, number));
}

export function pentatonicMidiAt(step, rootMidi = DEFAULT_ROOT_MIDI) {
  const safeStep = Math.max(0, Math.round(Number(step) || 0));
  const octave = Math.floor(safeStep / PENTATONIC_INTERVALS.length);
  const degree = safeStep % PENTATONIC_INTERVALS.length;
  return Math.round(Number(rootMidi) || DEFAULT_ROOT_MIDI)
    + octave * 12
    + PENTATONIC_INTERVALS[degree];
}

// The horizontal axis supplies ten scale steps and drawing higher on the canvas
// supplies up to five more. The resulting C3-C6 range stays musical because
// every selected pitch belongs to the same major pentatonic scale.
export function mapPositionToMidi(x, y, rootMidi = DEFAULT_ROOT_MIDI) {
  const horizontalStep = clamp01(x, 0.5) * 10;
  const verticalStep = (1 - clamp01(y, 0.5)) * 5;
  return pentatonicMidiAt(Math.round(horizontalStep + verticalStep), rootMidi);
}

export function midiToFrequency(midi) {
  const safeMidi = Number.isFinite(Number(midi)) ? Number(midi) : 69;
  return 440 * (2 ** ((safeMidi - 69) / 12));
}

// Pointer velocity is expected in canvas pixels/ms (0..2 is the useful range).
// Pressure is optional and normalized by PointerEvent already. A small floor
// keeps slow, deliberate strokes audible without allowing loud spikes.
export function normalizeStrokeIntensity(
  velocity,
  pressure,
  { maxVelocity = 2, minimum = 0.12 } = {},
) {
  const safeMaximum = Math.max(0.001, Number(maxVelocity) || 2);
  const speedAmount = clamp01((Number(velocity) || 0) / safeMaximum);
  const curvedSpeed = speedAmount ** 0.65;
  const hasPressure = Number.isFinite(Number(pressure));
  const combined = hasPressure
    ? curvedSpeed * 0.72 + clamp01(pressure, 0.5) * 0.28
    : curvedSpeed;
  const floor = clamp01(minimum, 0.12);
  return floor + combined * (1 - floor);
}

export function getInstrumentForBrush(brushId) {
  const id = typeof brushId === "string" ? brushId.toLowerCase() : "";
  return BRUSH_INSTRUMENTS[id] || INSTRUMENTS.marimba;
}

export function mapStrokeToSound({
  x = 0.5,
  y = 0.5,
  velocity = 0,
  pressure,
  brushId = "marker",
  rootMidi = DEFAULT_ROOT_MIDI,
} = {}) {
  const instrument = getInstrumentForBrush(brushId);
  const baseMidi = mapPositionToMidi(x, y, rootMidi);
  const midi = Math.max(24, Math.min(108, baseMidi + instrument.octave * 12));
  return {
    midi,
    frequency: midiToFrequency(midi),
    intensity: normalizeStrokeIntensity(velocity, pressure),
    instrument,
  };
}

export function shouldThrottle(lastPlayedAt, now, intervalMs = DEFAULT_THROTTLE_MS) {
  if (!Number.isFinite(lastPlayedAt) || !Number.isFinite(now)) {
    return false;
  }
  const elapsed = now - lastPlayedAt;
  return elapsed >= 0 && elapsed < Math.max(0, Number(intervalMs) || 0);
}

function browserAudioContextFactory() {
  if (typeof window === "undefined") {
    return null;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  return AudioContextClass ? new AudioContextClass() : null;
}

function setAudioParam(param, value, atTime) {
  if (!param) {
    return;
  }
  if (typeof param.setValueAtTime === "function") {
    param.setValueAtTime(value, atTime);
  } else {
    param.value = value;
  }
}

function rampAudioParam(param, value, atTime) {
  if (!param) {
    return;
  }
  if (typeof param.exponentialRampToValueAtTime === "function") {
    param.exponentialRampToValueAtTime(Math.max(0.0001, value), atTime);
  } else {
    param.value = value;
  }
}

export class PaintOrchestra {
  constructor({
    audioContextFactory = browserAudioContextFactory,
    now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    throttleMs = DEFAULT_THROTTLE_MS,
    maxVoices = DEFAULT_MAX_VOICES,
    volume = DEFAULT_VOLUME,
  } = {}) {
    this.audioContextFactory = audioContextFactory;
    this.now = now;
    this.throttleMs = Math.max(0, Number(throttleMs) || 0);
    this.maxVoices = Math.max(1, Math.min(16, Math.round(Number(maxVoices) || DEFAULT_MAX_VOICES)));
    this.enabled = false;
    this.muted = false;
    this.volume = clamp01(volume, DEFAULT_VOLUME);
    this.context = null;
    this.masterGain = null;
    this.voices = [];
    this.lastPlayedBySource = new Map();
    this.disposed = false;
  }

  isSupported() {
    if (this.context) {
      return true;
    }
    if (this.audioContextFactory !== browserAudioContextFactory) {
      return typeof this.audioContextFactory === "function";
    }
    return typeof window !== "undefined"
      && Boolean(window.AudioContext || window.webkitAudioContext);
  }

  async setEnabled(nextEnabled) {
    if (this.disposed) {
      return false;
    }
    if (!nextEnabled) {
      this.enabled = false;
      this.stopAllVoices();
      this.updateMasterGain();
      return true;
    }

    try {
      if (!this.context) {
        const context = this.audioContextFactory?.();
        if (!context) {
          return false;
        }
        const masterGain = context.createGain();
        masterGain.connect(context.destination);
        this.context = context;
        this.masterGain = masterGain;
        this.updateMasterGain();
      }
      if (this.context.state === "suspended" && typeof this.context.resume === "function") {
        await this.context.resume();
      }
      this.enabled = true;
      this.updateMasterGain();
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  setMuted(nextMuted) {
    this.muted = Boolean(nextMuted);
    this.updateMasterGain();
  }

  setVolume(nextVolume) {
    this.volume = clamp01(nextVolume, DEFAULT_VOLUME);
    this.updateMasterGain();
  }

  updateMasterGain() {
    if (!this.context || !this.masterGain) {
      return;
    }
    try {
      setAudioParam(
        this.masterGain.gain,
        this.muted || !this.enabled ? 0 : this.volume,
        this.context.currentTime,
      );
    } catch {
      // A closed or partially implemented AudioContext is simply silent.
    }
  }

  playStroke(stroke = {}) {
    if (this.disposed || !this.enabled || this.muted || this.volume <= 0 || !this.context) {
      return false;
    }

    const sourceId = String(stroke.sourceId || "local");
    const now = Number(this.now());
    const lastPlayedAt = this.lastPlayedBySource.get(sourceId);
    if (shouldThrottle(lastPlayedAt, now, this.throttleMs)) {
      return false;
    }
    this.lastPlayedBySource.set(sourceId, now);

    try {
      this.playVoice(mapStrokeToSound(stroke));
      return true;
    } catch {
      return false;
    }
  }

  playVoice(sound) {
    const context = this.context;
    if (!context) {
      return;
    }

    while (this.voices.length >= this.maxVoices) {
      this.stopVoice(this.voices[0]);
    }

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startedAt = context.currentTime;
    const attackEndsAt = startedAt + sound.instrument.attack;
    const releaseEndsAt = attackEndsAt + sound.instrument.release;
    const peak = Math.max(0.015, Math.min(0.24, sound.intensity * 0.2));

    oscillator.type = sound.instrument.wave;
    setAudioParam(oscillator.frequency, sound.frequency, startedAt);
    setAudioParam(gain.gain, 0.0001, startedAt);
    rampAudioParam(gain.gain, peak, attackEndsAt);
    rampAudioParam(gain.gain, 0.0001, releaseEndsAt);
    oscillator.connect(gain);
    gain.connect(this.masterGain);

    const voice = { oscillator, gain, stopped: false };
    this.voices.push(voice);
    oscillator.onended = () => this.removeVoice(voice);
    oscillator.start(startedAt);
    oscillator.stop(releaseEndsAt + 0.01);
  }

  removeVoice(voice) {
    const index = this.voices.indexOf(voice);
    if (index >= 0) {
      this.voices.splice(index, 1);
    }
    try {
      voice.oscillator.disconnect();
      voice.gain.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  stopVoice(voice) {
    if (!voice || voice.stopped) {
      return;
    }
    voice.stopped = true;
    try {
      voice.oscillator.stop();
    } catch {
      // The oscillator may already have ended.
    }
    this.removeVoice(voice);
  }

  stopAllVoices() {
    for (const voice of [...this.voices]) {
      this.stopVoice(voice);
    }
    this.lastPlayedBySource.clear();
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.enabled = false;
    this.disposed = true;
    this.stopAllVoices();
    const context = this.context;
    this.context = null;
    this.masterGain = null;
    try {
      if (context && typeof context.close === "function" && context.state !== "closed") {
        await context.close();
      }
    } catch {
      // Disposal must remain safe during page teardown.
    }
  }
}

export function createPaintOrchestra(options) {
  return new PaintOrchestra(options);
}
