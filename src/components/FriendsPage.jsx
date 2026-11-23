import { useCallback, useEffect, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { DiscoveryLink } from "./DiscoveryPage";
import { getSession, isCloudConfigured, onAuthStateChange } from "../utils/auth";
import { createInviteCode, createInviteLink, normalizeInviteCode } from "../utils/social";
import { friendsApi } from "../utils/friendsApi";
import "./friends-page.css";

// An invite link (/friends?add=CODE) carries the inviter's friend code through
// sign-up and pre-fills the request, so "use my code" is one tap.
const invitedBy = () => {
  const code = (new URLSearchParams(window.location.search).get("add") || "").toUpperCase();
  return /^[A-HJ-NP-Z2-9]{12}$/.test(code) ? code : "";
};
const returnTo = () => encodeURIComponent("/friends" + (invitedBy() ? "?add=" + invitedBy() : ""));
const signupPath = () => "/signup?return=" + returnTo();
const loginPath = () => "/signup?mode=login&return=" + returnTo();

function CopyValue({ value, label, description }) {
  const [status, setStatus] = useState("");
  const [fallback, setFallback] = useState(false);
  const input = useRef(null);
  useEffect(() => {
    if (fallback) {
      input.current?.focus();
      input.current?.select();
    }
  }, [fallback]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFallback(false);
      setStatus(description);
    } catch {
      setFallback(true);
      input.current?.select();
      setStatus("Select and copy the text below.");
    }
  }
  return <div className="friends-copy">
    <button type="button" className="friends-secondary" onClick={copy}>{label}</button>
    {status && <span role="status">{status}</span>}
    {fallback && <input ref={input} aria-label={label} readOnly value={value} />}
  </div>;
}

function RoomTools({ onNavigate, local }) {
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState("");
  const roomCode = normalizeInviteCode(code);
  return <aside className="friends-room-tools" aria-label="Drawing rooms">
    {local && <div className="friends-room-section">
      <h2>Start an Art Jam</h2>
      <p>Make a room code and share its link with someone you know.</p>
      {invite ? <div className="friends-invite">
        <strong className="friends-code">{invite}</strong>
        <CopyValue value={createInviteLink(invite)} label="Copy room link" description="Room link copied." />
        <div className="friends-actions"><DiscoveryLink href={'/join/' + invite} onNavigate={onNavigate} className="friends-primary">Open your room <span aria-hidden="true">↗</span></DiscoveryLink>
          <DiscoveryLink href={'/join/' + invite + '?color=1'} onNavigate={onNavigate} className="friends-secondary">Color together <span aria-hidden="true">↗</span></DiscoveryLink></div>
      </div> : <button className="friends-primary" type="button" onClick={() => setInvite(createInviteCode())}>Make a room code <span aria-hidden="true">＋</span></button>}
    </div>}
    <div className="friends-room-section">
      <h2>Join an Art Jam</h2>
      <form onSubmit={event => { event.preventDefault(); if (roomCode) onNavigate('/join/' + roomCode); }}>
        <label htmlFor="friends-room-code">Room code</label>
        <div className="friends-input-action">
          <input id="friends-room-code" type="text" value={code} maxLength={8} onChange={event => setCode(normalizeInviteCode(event.target.value))} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="Enter code" required />
          <button type="submit" className="friends-secondary" disabled={!roomCode}>Join</button>
        </div>
      </form>
      <DiscoveryLink href="/rooms" onNavigate={onNavigate} className="friends-text-link">Browse public rooms <span aria-hidden="true">↗</span></DiscoveryLink>
    </div>
  </aside>;
}

function AccountInvitation({ onNavigate, expired = false }) {
  return <section className="friends-account-invite" aria-labelledby="friends-account-title">
    <h2 id="friends-account-title">{expired ? "Sign in again" : invitedBy() ? "A friend invited you to draw" : "Start a friends list"}</h2>
    <p>{expired ? "Sign in to reconnect with your friends and see their requests." : invitedBy() ? "Create a free account or sign in, and their friend code will be waiting for you to send the request." : "Choose a nickname, swap friend codes with someone you know, and meet in a drawing room."}</p>
    <div className="friends-actions">
      {!expired && <DiscoveryLink className="friends-primary" href={signupPath()} onNavigate={onNavigate}>Create an account</DiscoveryLink>}
      <DiscoveryLink className={expired ? "friends-primary" : "friends-secondary"} href={loginPath() + (expired ? "&reauth=1" : "")} onNavigate={onNavigate}>Sign in</DiscoveryLink>
    </div>
  </section>;
}

function Contact({ person }) {
  return <div className="friends-identity">
    <strong>{person.name}</strong>
    <span>{person.code}</span>
  </div>;
}

function FriendList({ token, onNavigate }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState(invitedBy);
  const [removeCode, setRemoveCode] = useState("");
  const currentRead = useRef(null);
  const writing = useRef(false);
  const mounted = useRef(false);

  const showError = useCallback((problem) => {
    if (problem.status === 401) {
      setState(null);
      setExpired(true);
    } else {
      setError(problem instanceof TypeError ? "Friends couldn’t connect. Check your connection and try again." : problem.message);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (writing.current || currentRead.current || expired) return;
    const controller = new AbortController();
    currentRead.current = controller;
    try {
      const snapshot = await friendsApi(token, "", { signal: controller.signal });
      if (!controller.signal.aborted) { setState(snapshot); setError(""); }
    } catch (problem) {
      if (!controller.signal.aborted) showError(problem);
    } finally {
      if (currentRead.current === controller) currentRead.current = null;
    }
  }, [expired, showError, token]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const whileVisible = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", whileVisible);
    const timer = window.setInterval(whileVisible, 30000);
    return () => {
      mounted.current = false;
      currentRead.current?.abort();
      currentRead.current = null;
      window.removeEventListener("focus", whileVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  async function change(path, method, body, message) {
    if (writing.current) return;
    writing.current = true;
    currentRead.current?.abort();
    currentRead.current = null;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const snapshot = await friendsApi(token, path, { method, body });
      if (!mounted.current) return;
      setState(snapshot);
      setNotice(message);
      setCode("");
      setRemoveCode("");
    } catch (problem) {
      if (mounted.current) showError(problem);
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (expired) return <AccountInvitation onNavigate={onNavigate} expired />;
  const remove = (person, message) => change('/contact/' + encodeURIComponent(person.code), 'DELETE', null, message);
  return <div className="friends-list-panel" aria-busy={busy}>
    {error && <div className="friends-error" role="alert"><p>{error}</p><button type="button" className="friends-secondary" onClick={refresh} disabled={busy}>Refresh list</button></div>}
    {notice && <p className="friends-notice" role="status">{notice}</p>}
    {!state && !error && <p role="status">Opening your friends list…</p>}
    {state && !state.self && <section className="friends-account-invite">
      <h2>Pick your nickname</h2>
      <p>People you connect with will see this name. Use a nickname you’re happy to share.</p>
      <form onSubmit={event => { event.preventDefault(); if (name.trim()) change('/profile', 'POST', { name: name.trim() }, "Your friend code is ready."); }}>
        <label htmlFor="friends-name">Your nickname</label>
        <div className="friends-input-action">
          <input id="friends-name" value={name} onChange={event => setName(event.target.value)} autoComplete="off" maxLength={24} placeholder="Nickname" required />
          <button type="submit" className="friends-primary" disabled={busy || !name.trim()}>Get friend code</button>
        </div>
      </form>
    </section>}
    {state?.self && <>
      <section className="friends-code-card" aria-labelledby="friends-code-title">
        <div>
          <h2 id="friends-code-title">Your friend code</h2>
          <p>Share this with someone you know. They’ll see your nickname, <strong>{state.self.name}</strong>.</p>
        </div>
        <div className="friends-code-strip">
          <strong className="friends-code">{state.self.code}</strong>
          <CopyValue value={state.self.code} label="Copy friend code" description="Friend code copied." />
        </div>
      </section>
      <section className="friends-paper-section" aria-labelledby="friends-request-title">
        <h2 id="friends-request-title">Add a friend</h2>
        <form onSubmit={event => { event.preventDefault(); if (code.trim().length === 12) change('/request', 'POST', { code: code.trim().toUpperCase() }, "Friend request sent."); }}>
          <label htmlFor="friends-person-code">{code && code === invitedBy() ? "Your friend’s code is filled in. Send the request to connect." : "Their 12-character friend code"}</label>
          <div className="friends-input-action"><input id="friends-person-code" value={code} onChange={event => setCode(event.target.value.toUpperCase())} minLength={12} maxLength={12} autoComplete="off" spellCheck={false} autoCapitalize="characters" placeholder="Enter friend code" required />
            <button type="submit" className="friends-primary" disabled={busy || code.trim().length !== 12}>Send request</button>
          </div>
        </form>
      </section>
      <section className="friends-paper-section" aria-labelledby="friends-requests-title">
        <div className="friends-section-row"><h2 id="friends-requests-title">Friend requests</h2><button type="button" className="friends-secondary" onClick={refresh} disabled={busy}>Refresh</button></div>
        {!state.incoming.length && !state.outgoing.length && <p>No requests yet.</p>}
        {state.incoming.length > 0 && <><h3>Received</h3><ul className="friends-rows">{state.incoming.map(person => <li key={person.code}>
          <Contact person={person} />
          <div className="friends-actions"><button type="button" className="friends-primary" disabled={busy} onClick={() => change('/accept', 'POST', { code: person.code }, 'You and ' + person.name + ' are now friends.')}>Accept</button><button type="button" className="friends-quiet" disabled={busy} onClick={() => remove(person, 'Request declined.')}>Decline</button></div>
        </li>)}</ul></>}
        {state.outgoing.length > 0 && <><h3>Sent</h3><ul className="friends-rows">{state.outgoing.map(person => <li key={person.code}><Contact person={person} /><button type="button" className="friends-quiet" disabled={busy} onClick={() => remove(person, 'Request canceled.')}>Cancel request</button></li>)}</ul></>}
      </section>
      <section className="friends-paper-section" aria-labelledby="friends-saved-title">
        <h2 id="friends-saved-title">Your friends</h2>
        {!state.friends.length && <p>When a request is accepted, your shared drawing room will appear here.</p>}
        {state.friends.length > 0 && <ul className="friends-rows">{state.friends.map(person => <li key={person.code}>
          <Contact person={person} />
          {removeCode === person.code ? <div className="friends-confirm">
            <span>Remove {person.name} from your friends?</span>
            <div className="friends-actions"><button className="friends-secondary" type="button" disabled={busy} onClick={() => setRemoveCode("")}>Keep friend</button><button className="friends-quiet" type="button" disabled={busy} onClick={() => remove(person, "Friend removed.")}>Confirm removal</button></div>
          </div> : <div className="friends-actions">
            <DiscoveryLink href={'/join/' + encodeURIComponent(person.roomCode)} onNavigate={onNavigate} className="friends-primary" aria-label={'Start an Art Jam with ' + person.name}>Start an Art Jam <span aria-hidden="true">↗</span></DiscoveryLink>
            <DiscoveryLink href={'/join/' + encodeURIComponent(person.roomCode) + '?color=1'} onNavigate={onNavigate} className="friends-secondary" aria-label={'Color together with ' + person.name}>Color together <span aria-hidden="true">↗</span></DiscoveryLink>
            <button type="button" className="friends-quiet" disabled={busy} onClick={() => setRemoveCode(person.code)}>Remove</button>
          </div>}
        </li>)}</ul>}
      </section>
    </>}
  </div>;
}

export default function FriendsPage({ onNavigate }) {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    if (!isCloudConfigured) return undefined;
    let active = true;
    let changed = false;
    const unsubscribe = onAuthStateChange(value => { changed = true; if (active) setSession(value); });
    getSession().then(value => { if (active && !changed) setSession(value); });
    return () => { active = false; unsubscribe(); };
  }, []);

  return <div className="site-page discovery-page friends-page">
    <SiteNav onNavigate={onNavigate} current="/friends" />
    <main className="friends-main" id="main-content">
      <header className="friends-heading"><h1>Draw with friends</h1>
        <p>{isCloudConfigured ? "Swap friend codes to connect your accounts. Already have a room code? Use it below to open the shared canvas." : "Make one room code for your group. Send the link, open the room, and you can all paint on the same page."}</p>
      </header>
      <div className="friends-layout">
        <div className="friends-main-column">
          {isCloudConfigured ? session === undefined ? <p role="status">Checking your account…</p>
            : session?.access_token ? <FriendList key={session.access_token} token={session.access_token} onNavigate={onNavigate} />
            : <AccountInvitation onNavigate={onNavigate} /> : <RoomTools onNavigate={onNavigate} local />}
        </div>
        <div className="friends-side-column">
          {isCloudConfigured && <RoomTools onNavigate={onNavigate} />}
          <section className="friends-color-note"><h2>Color together</h2><p>Open the same drawing room, then choose <strong>Coloring sheets</strong> in the studio. Pick a sheet and you can both color it.</p></section>
        </div>
      </div>
    </main>
    <SiteFooter onNavigate={onNavigate} />
  </div>;
}
