import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PageInkTrail from './PageInkTrail';
import NavDoodles from './NavDoodles';
import './page-ink-workspace.css';

const INKS = [
  { name: 'Graphite', value: '#24241f' },
  { name: 'Red', value: '#bc3226' },
  { name: 'Blue', value: '#254fb9' },
];

function PencilIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <path d="m3 21 1.4-6.1L16.7 2.7a1.8 1.8 0 0 1 2.5 0l2.1 2.1a1.8 1.8 0 0 1 0 2.5L9.1 19.6 3 21Z M4.4 14.9l4.7 4.7 M14.9 4.6l4.6 4.6 M6.8 17.4l10.4-10.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export default function PageInkWorkspace({ children }) {
  const [color, setColor] = useState(INKS[1].value);
  const [drawing, setDrawing] = useState(false);
  const [clearKey, setClearKey] = useState(0);
  const [slot, setSlot] = useState(null);
  const [passedSlot, setPassedSlot] = useState(false);
  const root = useRef(null);
  const toggle = useRef(null);
  useLayoutEffect(() => {
    const target = root.current?.querySelector('[data-home-ink-tools]');
    if (!target) return undefined;
    setSlot(target);
    if (!('IntersectionObserver' in window)) return undefined;
    const observer = new IntersectionObserver(([entry]) => setPassedSlot(entry.boundingClientRect.bottom <= 0));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!drawing) return undefined;
    const escape = event => {
      if (event.key === 'Escape') { setDrawing(false); toggle.current?.focus({ preventScroll: true }); }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [drawing]);

  const floating = !slot || passedSlot;
  const tray = <div className={'page-ink-tray' + (floating ? ' is-floating' : '')} data-ink-tools="" data-ink-ui="" role="group" aria-label="Page drawing tools">
    <button className="ink-switch" type="button" ref={toggle} aria-label="Draw on this page" aria-pressed={drawing} title={drawing ? 'Finish doodling' : 'Draw on this page'} onClick={() => setDrawing(value => !value)}>
      <PencilIcon /><span>{drawing ? 'Done' : 'Doodle here'}</span>
    </button>
    {(!floating || drawing) && <><span className="ink-tray-rule" aria-hidden="true" />
      {INKS.map(ink => <button type="button" key={ink.value} className="ink-color" style={{ '--chip': ink.value }} aria-label={ink.name + ' ink'} aria-pressed={color === ink.value} title={ink.name + ' ink'} onClick={() => { setColor(ink.value); setDrawing(true); }} />)}
      {drawing && <button className="ink-clear" type="button" aria-label="Clear page doodles" title="Clear page doodles" onClick={() => setClearKey(value => value + 1)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m3.4 14.2 8.8-10.1a1.6 1.6 0 0 1 2.3-.2l5.5 4.8a1.6 1.6 0 0 1 .1 2.2l-7.6 8.6H8.8l-5.2-4.1a.9.9 0 0 1-.2-1.2Zm4.8-5.4 7.9 7M11.7 19.5h9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>}
    </>}
  </div>;
  return <div className="page-ink-workspace" ref={root} data-drawing={drawing ? 'on' : 'off'}>
    {children}
    <NavDoodles color={color} />
    <PageInkTrail drawing={drawing} color={color} clearKey={clearKey} />
    {slot && !floating ? createPortal(tray, slot) : tray}
  </div>;
}
