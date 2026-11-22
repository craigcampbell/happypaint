import { useId } from 'react';
import { NavInkMark } from './NavDoodles';
import { QUICK_JOIN_PATH } from '../data/curatorContent';
import PaintingReplay from './PaintingReplay';
import './discovery.css';
import './artwall-home.css';
import './curator.css';
import './print-masthead.css';
function HeaderLink({ href, onNavigate, preview, className, children, ink }) {
  return <a data-nav-ink={ink ? "" : undefined} href={href} className={className} onClick={(event) => {
    if (preview) { event.preventDefault(); return; }
    if (onNavigate && href !== QUICK_JOIN_PATH && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onNavigate(href); }
  }}>{children}</a>;
}
function InkPlay() {
  const patternId = useId();
  return <svg className="artwall-ink-play" viewBox="0 0 540 500" fill="none" aria-hidden="true" focusable="false">
    <defs><pattern id={patternId} width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="2.5" fill="#181916" /></pattern></defs>
    <path d="M290 18 319 90 382 43 380 125 470 106 429 179 512 221 426 248 478 328 386 308 382 399 322 344 276 421 256 333 168 361 203 281 120 243 209 207 164 129 250 149Z" fill="#e9f35a" />
    <ellipse cx="369" cy="289" rx="127" ry="139" transform="rotate(28 369 289)" fill={`url(#${patternId})`} />
    <path d="M97 150C40 99 115 45 159 85C201 124 164 198 121 260C88 310 118 357 162 342C209 325 233 270 235 212C238 131 303 127 308 191C312 258 225 391 161 418" stroke="#e7472d" strokeWidth="47" strokeLinecap="round" />
    <path d="M61 291C154 214 349 354 439 194M59 318C175 248 340 376 468 207M78 345C175 286 371 382 480 236" stroke="#181916" strokeWidth="5" strokeLinecap="round" />
    <path d="m392 44 35-22m-14 48 48-4m-64-30 8-29" stroke="#181916" strokeWidth="6" strokeLinecap="round" />
    <path d="M34 392c40-20 63-8 77 22s40 38 63 13" stroke="#8dbbd0" strokeWidth="22" strokeLinecap="square" />
    <circle cx="66" cy="195" r="9" fill="#181916" /><circle cx="47" cy="221" r="4" fill="#181916" /><circle cx="449" cy="420" r="12" fill="#e7472d" />
    <path d="m294 433 12 34 14-33m-20 20 25 3" stroke="#181916" strokeWidth="4" strokeLinecap="round" />
  </svg>;
}

function InkFlourishes() {
  return <svg className="masthead-ink" viewBox="0 0 1100 560" preserveAspectRatio="none" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
    <path className="ink-flight" d="M440 -16c-23 32-32 70-7 86 30 19 70-2 64-21-5-17-41-11-55 8-28 39 38 82 91 43 27-20 36-49 87-49" />
    <path d="m606 43 16 7-12 12 M1012 458l7-18 8 14 16-6-7 16 12 10-19 2-5 17-7-16-17 3 10-13-10-10Z" />
    <path d="M495 524c32-16 54-42 47-52-9-12-37 1-31 19 8 23 70 18 101-6m-17 1 19-4-8 14" />
  </svg>;
}

function HomeMasthead({ content, onNavigate, preview, heading, id, orbit }) {
  return <header className="curated-header print-masthead" data-palette={content.palette} data-art={content.art}
    data-default-title={content.title === 'Come draw\nwith us.'} aria-labelledby={id}>
    <div className="print-layout">
      <InkFlourishes />
      <div className="print-intro">
        {content.kicker && <p className="print-kicker">{content.kicker}</p>}
        <div className="print-headline">{heading}</div>
      </div>
      {content.art === 'ink' && <PaintingReplay preview={preview} />}
      {content.art === 'orbit' && <div className="print-sheet"><div className="print-picture">{orbit}</div></div>}
      <div className="print-invitation">
        {content.description && <p className="print-deck">{content.description}</p>}
        <div className="print-actions">
          <HeaderLink ink preview={preview} href={content.ctaHref} onNavigate={onNavigate} className="artwall-draw">{content.ctaLabel}<span aria-hidden="true">↗</span><NavInkMark kind="rays" /></HeaderLink>
          <HeaderLink ink href="/friends" className="print-browse" preview={preview} onNavigate={onNavigate}>Start an Art Jam with friends<NavInkMark kind="underline" /></HeaderLink>
        </div>
        {content.note && <p className="print-note">{content.note}</p>}
      </div>
    </div>
  </header>;
}

export default function CuratedHeader({ page, content, onNavigate, preview = false }) {
  const id = useId();
  const heading = <h1 id={id} aria-label={content.title.split('\n').join(' ')}>{content.title.split('\n').map((line, index) => <span key={index}>{line.endsWith('.') ? <>{line.slice(0, -1)}<span className="artwall-period">.</span></> : line}</span>)}</h1>;
  const orbit = <svg className="artwall-ink-play curator-orbit" viewBox="0 0 500 500" aria-hidden="true"><circle cx="250" cy="250" r="175" fill="#e9f35a" /><ellipse cx="250" cy="250" rx="225" ry="70" fill="none" stroke="currentColor" strokeWidth="9" transform="rotate(-30 250 250)" /><circle cx="400" cy="140" r="32" fill="#e7472d" /></svg>;
  if (page === 'home') return <HomeMasthead content={content} onNavigate={onNavigate}
    preview={preview} heading={heading} id={id} orbit={orbit} />;

  return <header className="discovery-heading curated-header directory-cover" data-palette={content.palette} data-art={content.art} aria-labelledby={id}>
    <div className="directory-cover-copy">
      {content.kicker && <p className="discovery-eyebrow">{content.kicker}</p>}
      {heading}
      <p>{content.description}</p>{content.note && <p className="curator-note">{content.note}</p>}
      <HeaderLink preview={preview} href={content.ctaHref} onNavigate={onNavigate} className="curator-cta">{content.ctaLabel} <span aria-hidden="true">↗</span></HeaderLink>
    </div>
    {content.art !== 'none' && <div aria-hidden="true" className="directory-cover-print">
      {content.art === 'ink' ? <InkPlay /> : orbit}
    </div>}
  </header>;
}
