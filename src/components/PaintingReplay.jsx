import { useEffect, useRef, useState } from 'react';

const POSTER = '/media/paint-together.webp';
const DESCRIPTION = 'Pip and Fern, two drawing bots, paint a blue whale over sunset waves on one canvas.';

export default function PaintingReplay({ preview }) {
  const player = useRef(null);
  const wantsPlayback = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = player.current;
    if (!video) return undefined;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = !window.IntersectionObserver;
    wantsPlayback.current = !motion.matches;
    const update = () => {
      if (wantsPlayback.current && visible && !document.hidden) video.play().catch(() => {});
      else video.pause();
    };
    const motionChanged = () => {
      wantsPlayback.current = !motion.matches;
      update();
    };
    const observer = window.IntersectionObserver && new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    observer?.observe(video);
    document.addEventListener('visibilitychange', update);
    motion.addEventListener('change', motionChanged);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
      motion.removeEventListener('change', motionChanged);
      video.pause();
    };
  }, [failed, preview]);

  function toggle() {
    const video = player.current;
    wantsPlayback.current = video.paused;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  return <figure className="print-sheet painting-replay" data-no-ink="">
    <div className="print-binding" aria-hidden="true" />
    {preview || failed
      ? <img className="replay-picture" src={POSTER} width="960" height="640" alt={DESCRIPTION} />
      : <video className="replay-picture" ref={player} width="960" height="640"
          src="/media/paint-together.mp4" poster={POSTER} muted loop playsInline preload="none"
          aria-label={DESCRIPTION} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onError={() => setFailed(true)} />}
    <figcaption>
      <div className="replay-credit">
        <strong>Pip &amp; Fern</strong>
        <span>{failed ? 'Bot painting session · Still frame' : 'Bot painting session · 0:30'}</span>
      </div>
      {!preview && !failed && <button type="button" className="replay-toggle" onClick={toggle}
        aria-label={playing ? 'Pause painting replay' : 'Play painting replay'}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="currentColor">
          {playing ? <path d="M4 3h3.5v12H4zm6.5 0H14v12h-3.5z" /> : <path d="m5 2.6 10 6.4-10 6.4z" />}
        </svg>
      </button>}
    </figcaption>
  </figure>;
}
