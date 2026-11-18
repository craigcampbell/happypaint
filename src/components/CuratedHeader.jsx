import { useId, useRef, useState } from 'react';
import './discovery.css';
import './artwall-home.css';
import './curator.css';
import './print-masthead.css';
function HeaderLink({ href, onNavigate, preview, className, children }) {
  return <a href={href} className={className} onClick={(event) => {
    if (preview) { event.preventDefault(); return; }
    if (onNavigate && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onNavigate(href); }
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


const PRINTS = [
  {
    file: 'ink-cat', link: 'Sketch this cat',
    alt: 'An ink-black cat rides a giant yellow pencil across a blue sky.',
    prompt: 'Draw a cat that gets around on a giant pencil. Where is it going?',
  },
  {
    file: 'record-monster', link: 'Sketch this DJ',
    alt: 'A red monster in headphones spins a record on a blue turntable.',
    prompt: 'A monster is DJing its first party. Draw who shows up to dance.',
  },
  {
    file: 'sky-fish', link: 'Sketch this fish',
    alt: 'A flying blue fish delivers mail among postage-stamp clouds.',
    prompt: 'A flying fish delivers letters to the clouds. Draw its next stop.',
  },
];

function PromptPrints({ onNavigate, preview }) {
  const strip = useRef(null);
  const [index, setIndex] = useState(0);
  const print = PRINTS[index];

  const turnPage = (step) => {
    const next = (index + step + PRINTS.length) % PRINTS.length;
    strip.current.scrollTo({ left: next * strip.current.clientWidth, behavior: 'instant' });
  };

  return <figure className="print-sheet" aria-label="Illustrated drawing prompts">
    <div className="print-picture print-strip" ref={strip} onScroll={({ currentTarget }) => {
      const page = Math.round(currentTarget.scrollLeft / currentTarget.clientWidth);
      setIndex(Math.max(0, Math.min(PRINTS.length - 1, page)));
    }}>
      {PRINTS.map((item, i) => <img key={item.file} src={`/home-print/${item.file}.webp`}
        width="1120" height="896" alt={item.alt} aria-hidden={i !== index}
        draggable={false} fetchPriority={i === 0 ? 'high' : 'low'} loading={i === 0 ? 'eager' : 'lazy'} />)}
    </div>
    <figcaption>
      <HeaderLink href={`/draw?prompt=${encodeURIComponent(print.prompt)}`} onNavigate={onNavigate} preview={preview}
        className="print-sketch">{print.link} <span aria-hidden="true">↗</span></HeaderLink>
      <div className="print-pager">
        <button type="button" onClick={() => turnPage(-1)} aria-label="Previous print">←</button>
        <span aria-live="polite" aria-atomic="true"><span className="print-sr">Print </span>{index + 1} / {PRINTS.length}</span>
        <button type="button" onClick={() => turnPage(1)} aria-label="Next print">→</button>
      </div>
    </figcaption>
  </figure>;
}

function HomeMasthead({ content, onNavigate, preview, heading, id, orbit }) {
  return <header className="curated-header print-masthead" data-palette={content.palette} data-art={content.art}
    data-default-title={content.title === 'MAKE A\nBEAUTIFUL\nMESS.'} data-short-note={content.note.length <= 28} aria-labelledby={id}>
    <div className="print-layout">
      <div className="print-lead">
        {content.kicker && <p className="print-kicker">{content.kicker}</p>}
        <div className="print-headline">
          {heading}
          {content.note && <span className="print-note">{content.note}</span>}
        </div>
        {content.description && <p className="print-deck">{content.description}</p>}
        <div className="print-actions">
          <HeaderLink preview={preview} href={content.ctaHref} onNavigate={onNavigate} className="artwall-draw">{content.ctaLabel}<span aria-hidden="true">↗</span></HeaderLink>
          {!preview && <a href="#home-art-title" className="print-browse">Browse the wall <span aria-hidden="true">↓</span></a>}
        </div>
        {content.ctaHref === '/draw' && <p className="print-privacy">Free private canvas · No account needed</p>}
      </div>
      {content.art === 'ink' && <PromptPrints onNavigate={onNavigate} preview={preview} />}
      {content.art === 'orbit' && <div className="print-sheet"><div className="print-picture">{orbit}</div></div>}
    </div>
  </header>;
}

export default function CuratedHeader({ page, content, onNavigate, preview = false }) {
  const id = useId();
  const heading = <h1 id={id} aria-label={content.title.split('\n').join(' ')}>{content.title.split('\n').map((line, index) => <span key={index}>{line.endsWith('.') ? <>{line.slice(0, -1)}<span className="artwall-period">.</span></> : line}</span>)}</h1>;
  const orbit = <svg className="artwall-ink-play curator-orbit" viewBox="0 0 500 500" aria-hidden="true"><circle cx="250" cy="250" r="175" fill="#e9f35a" /><ellipse cx="250" cy="250" rx="225" ry="70" fill="none" stroke="currentColor" strokeWidth="9" transform="rotate(-30 250 250)" /><circle cx="400" cy="140" r="32" fill="#e7472d" /></svg>;
  if (page === 'home') return <HomeMasthead content={content} onNavigate={onNavigate}
    preview={preview} heading={heading} id={id} orbit={orbit} />;

  return <header className="discovery-heading curated-header" data-palette={content.palette} data-art={content.art} aria-labelledby={id}>
    <p className="discovery-eyebrow">{content.kicker}</p>
    <div className="curator-poster">{heading}{content.art === 'ink' ? <InkPlay /> : content.art === 'orbit' ? orbit : null}</div>
    <p>{content.description}</p><p className="curator-note">{content.note}</p>
    <HeaderLink preview={preview} href={content.ctaHref} onNavigate={onNavigate} className="curator-cta">{content.ctaLabel} <span aria-hidden="true">↗</span></HeaderLink>
  </header>;
}
