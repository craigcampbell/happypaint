import test from "node:test";
import assert from "node:assert/strict";
import {
  BRUSH_INSTRUMENTS,
  PaintOrchestra,
  getInstrumentForBrush,
  mapPositionToMidi,
  mapStrokeToSound,
  midiToFrequency,
  normalizeStrokeIntensity,
  pentatonicMidiAt,
  shouldThrottle,
} from "./paintOrchestra.js";

test("pentatonic notes stay on the declared scale", () => {
  const pitchClasses = new Set([0, 2, 4, 7, 9]);
  for (let step = 0; step <= 20; step += 1) {
    assert.ok(pitchClasses.has(pentatonicMidiAt(step) % 12));
  }
});

test("normalized canvas position maps to a bounded, rising pitch", () => {
  assert.equal(mapPositionToMidi(0, 1), 48);
  assert.equal(mapPositionToMidi(1, 0), 84);
  assert.ok(mapPositionToMidi(0.75, 0.25) > mapPositionToMidi(0.25, 0.75));
  assert.equal(mapPositionToMidi(-10, 10), 48);
  assert.equal(mapPositionToMidi(10, -10), 84);
});

test("MIDI conversion uses A4 = 440Hz", () => {
  assert.equal(midiToFrequency(69), 440);
  assert.ok(Math.abs(midiToFrequency(60) - 261.6256) < 0.001);
});

test("velocity and pressure normalize without loudness spikes", () => {
  assert.equal(normalizeStrokeIntensity(0), 0.12);
  assert.equal(normalizeStrokeIntensity(100), 1);
  const gentle = normalizeStrokeIntensity(0.25, 0.2);
  const energetic = normalizeStrokeIntensity(1.5, 0.8);
  assert.ok(gentle >= 0.12 && gentle < energetic);
  assert.ok(energetic <= 1);
});

test("known brush families resolve and custom brushes get a safe default", () => {
  assert.equal(getInstrumentForBrush("watercolor").id, "pad");
  assert.equal(getInstrumentForBrush("SPRAY").id, "shaker");
  assert.equal(getInstrumentForBrush("oil").id, "bass");
  assert.equal(getInstrumentForBrush("custom-rainbow").id, "marimba");
  assert.ok(Object.isFrozen(BRUSH_INSTRUMENTS));
});

test("stroke mapping applies the brush register and returns finite sound values", () => {
  const marker = mapStrokeToSound({ x: 0.5, y: 0.5, brushId: "marker", velocity: 0.4 });
  const bass = mapStrokeToSound({ x: 0.5, y: 0.5, brushId: "oil", velocity: 0.4 });
  assert.equal(marker.midi - bass.midi, 12);
  assert.ok(Number.isFinite(marker.frequency));
  assert.ok(marker.intensity > 0 && marker.intensity <= 1);
});

test("throttle is deterministic and permits a clock reset", () => {
  assert.equal(shouldThrottle(100, 120, 65), true);
  assert.equal(shouldThrottle(100, 165, 65), false);
  assert.equal(shouldThrottle(100, 90, 65), false);
  assert.equal(shouldThrottle(undefined, 10, 65), false);
});

test("manager stays silent before opt-in and fails closed without Web Audio", async () => {
  let time = 0;
  const orchestra = new PaintOrchestra({
    audioContextFactory: () => null,
    now: () => time,
  });
  assert.equal(orchestra.playStroke({}), false);
  assert.equal(await orchestra.setEnabled(true), false);
  assert.equal(orchestra.enabled, false);
  orchestra.setMuted(true);
  orchestra.setVolume(2);
  assert.equal(orchestra.muted, true);
  assert.equal(orchestra.volume, 1);
  time += 100;
  assert.equal(orchestra.playStroke({}), false);
  await orchestra.dispose();
});

test("manager enables only on request, throttles sources, caps voices, and disposes", async () => {
  let time = 100;
  let contextsCreated = 0;
  let resumed = 0;
  let closed = 0;
  const oscillators = [];
  const makeParam = () => ({
    value: 0,
    setValueAtTime(value) {
      this.value = value;
    },
    exponentialRampToValueAtTime(value) {
      this.value = value;
    },
  });
  const context = {
    state: "suspended",
    currentTime: 1,
    destination: {},
    createGain() {
      return { gain: makeParam(), connect() {}, disconnect() {} };
    },
    createOscillator() {
      const oscillator = {
        frequency: makeParam(),
        connect() {},
        disconnect() {},
        start() {},
        stop() {
          this.stopped = true;
        },
      };
      oscillators.push(oscillator);
      return oscillator;
    },
    async resume() {
      resumed += 1;
      this.state = "running";
    },
    async close() {
      closed += 1;
      this.state = "closed";
    },
  };
  const orchestra = new PaintOrchestra({
    audioContextFactory: () => {
      contextsCreated += 1;
      return context;
    },
    now: () => time,
    throttleMs: 50,
    maxVoices: 2,
  });

  assert.equal(contextsCreated, 0);
  assert.equal(orchestra.playStroke({ sourceId: "a" }), false);
  assert.equal(await orchestra.setEnabled(true), true);
  assert.equal(contextsCreated, 1);
  assert.equal(resumed, 1);
  assert.equal(orchestra.masterGain.gain.value, 0.55);

  assert.equal(orchestra.playStroke({ sourceId: "a" }), true);
  assert.equal(orchestra.playStroke({ sourceId: "a" }), false);
  assert.equal(orchestra.playStroke({ sourceId: "b" }), true);
  time += 50;
  assert.equal(orchestra.playStroke({ sourceId: "a" }), true);
  assert.equal(orchestra.voices.length, 2);
  assert.equal(oscillators[0].stopped, true);

  orchestra.setMuted(true);
  assert.equal(orchestra.masterGain.gain.value, 0);
  assert.equal(orchestra.playStroke({ sourceId: "c" }), false);
  await orchestra.dispose();
  assert.equal(closed, 1);
  assert.equal(orchestra.voices.length, 0);
});
