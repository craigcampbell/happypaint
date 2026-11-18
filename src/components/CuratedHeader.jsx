import { useId } from 'react';
import './discovery.css';
import './artwall-home.css';
import './curator.css';
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


export default function CuratedHeader({ page, content, onNavigate, preview = false }) {
  const id = useId();
  const home = page === 'home';
  const lines = content.title.split('\n');
  const defaultTitle = content.title === 'MAKE A\nBEAUTIFUL\nMESS.';
  const art = content.art === 'ink' ? <InkPlay /> : content.art === 'orbit' ? <svg className="artwall-ink-play curator-orbit" viewBox="0 0 500 500" aria-hidden="true"><circle cx="250" cy="250" r="175" fill="#e9f35a" /><ellipse cx="250" cy="250" rx="225" ry="70" fill="none" stroke="currentColor" strokeWidth="9" transform="rotate(-30 250 250)" /><circle cx="400" cy="140" r="32" fill="#e7472d" /></svg> : null;
  const link = <HeaderLink preview={preview} href={content.ctaHref} onNavigate={onNavigate} className={home ? 'artwall-draw' : 'curator-cta'}>{content.ctaLabel} <span aria-hidden="true">↗</span></HeaderLink>;
  return <header className={`${home ? 'artwall-masthead' : 'discovery-heading'} curated-header`} data-palette={content.palette} data-art={content.art} data-default-title={defaultTitle} aria-labelledby={id}>
    <p className={home ? 'artwall-edition' : 'discovery-eyebrow'}>{content.kicker}</p>
    <div className={home ? 'artwall-poster' : 'curator-poster'}>
      <h1 id={id}>{lines.map((line, index) => <span key={index}>{line.endsWith('.') ? <>{line.slice(0, -1)}<span className="artwall-period">.</span></> : line}</span>)}</h1>
      {art}
      {home ? <span className="artwall-margin-note" aria-hidden="true">{content.note === 'no perfect lines required.' ? <>no perfect lines<br />required.</> : content.note}</span> : null}
    </div>
    {home ? <><div className="artwall-hero-bottom"><div className="artwall-intro"><p>{content.description}</p><p>Draw, paint, or animate. No account needed.</p></div><div className="artwall-start-actions">{link}{content.ctaHref === '/draw' ? <span>Starts private. Sharing is your choice.</span> : null}</div></div>{!preview ? <a className="artwall-scroll-link" href="#home-art-title">Or wander through the artwork <span aria-hidden="true">↓</span></a> : null}</> : <><p>{content.description}</p><p className="curator-note">{content.note}</p>{link}</>}
  </header>;
}
