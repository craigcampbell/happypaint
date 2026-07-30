export default function PaintOrchestraPanel({
  enabled = false,
  muted = false,
  volume = 0.55,
  supported = true,
  onEnabledChange,
  onMutedChange,
  onVolumeChange,
}) {
  const volumePercent = Math.round(Math.max(0, Math.min(1, Number(volume) || 0)) * 100);

  return (
    <section className="paint-orchestra-panel" aria-labelledby="paint-orchestra-title">
      <div className="panel-title-row">
        <div>
          <h3 id="paint-orchestra-title">Paint Orchestra</h3>
          <p>Turn brush strokes into a gentle shared soundtrack.</p>
        </div>
        <button
          type="button"
          aria-pressed={enabled}
          disabled={!supported}
          onClick={() => onEnabledChange?.(!enabled)}
        >
          {enabled ? "Turn off sound" : "Hear the painting"}
        </button>
      </div>

      {!supported ? (
        <p role="status">Sound is not available in this browser. You can keep painting normally.</p>
      ) : (
        <p role="status" aria-live="polite">
          {enabled ? "Painting sounds are on." : "Sound stays off until you choose to turn it on."}
        </p>
      )}

      <fieldset disabled={!enabled || !supported}>
        <legend>Sound controls</legend>
        <label>
          <input
            type="checkbox"
            checked={muted}
            onChange={(event) => onMutedChange?.(event.target.checked)}
          />
          Mute painting sounds
        </label>
        <label>
          Volume
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={volumePercent}
            aria-valuetext={`${volumePercent} percent`}
            onChange={(event) => onVolumeChange?.(Number(event.target.value) / 100)}
          />
          <output aria-live="off">{volumePercent}%</output>
        </label>
      </fieldset>

      <p>
        Marker plays marimba, watercolor plays soft pads, crayon plucks strings,
        spray adds a shaker, and oil adds bass.
      </p>
    </section>
  );
}
