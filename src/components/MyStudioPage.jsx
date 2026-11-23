// "My studio" (/me): one page for what a person keeps on Drawesome. Their plan,
// the boards they've drawn on, the artwork they saved, and the friends they've
// invited with their code.
//
// Anonymous-first: with no account (or no PocketBase at all) it still shows
// this device's recent rooms and device-saved art. Signing in swaps in the
// account's copies. Everything here reads existing stores, so there is no new
// durable client data to add to the account-deletion wipe lists.

import { useCallback, useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import MyRooms from "./MyRooms";
import { SiteSponsorSlot } from "../utils/ads";
import { getSession, isCloudConfigured, onAuthStateChange } from "../utils/auth";
import { getDeviceKey } from "../utils/deviceIdentity";
import { friendsApi } from "../utils/friendsApi";
import { createInviteCode } from "../utils/social";
import "./my-studio.css";

function useCopy() {
  const [copied, setCopied] = useState("");
  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied("Copy it from here: " + value);
    }
  };
  return [copied, copy];
}

function Plan({ session, onNavigate }) {
  const [config, setConfig] = useState(null);
  const [billing, setBilling] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const token = session?.access_token || "";

  useEffect(() => {
    let active = true;
    fetch("/api/billing/config", { cache: "no-store" }).then(res => (res.ok ? res.json() : null))
      .then(value => { if (active) setConfig(value?.configured ? value : null); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    setBilling(null);
    if (!token) return undefined;
    let active = true;
    fetch("/api/billing/me", { cache: "no-store", headers: { Authorization: `Bearer ${token}` } })
      .then(res => (res.ok ? res.json() : null)).then(value => { if (active) setBilling(value); }).catch(() => {});
    return () => { active = false; };
  }, [token]);

  const manage = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/portal", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error("portal");
      window.location.href = data.url;
    } catch {
      setError("Billing couldn’t open just now. Please try again.");
      setBusy(false);
    }
  };

  const go = href => event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(href);
  };
  const hasPass = Boolean(billing?.active);
  return <>
    <section className={"studio-plan" + (hasPass ? " has-pass" : "")} aria-labelledby="studio-plan-title">
      <div>
        <p className="studio-label">Your plan</p>
        <h2 id="studio-plan-title">{hasPass ? "Jam Pass" : "Free"}</h2>
        {hasPass
          ? <p>No ads for you, or for anyone you invite to a room you host.{billing.renewsAt ? ` ${billing.cancelAtPeriodEnd ? "Ends" : "Renews"} ${new Date(billing.renewsAt).toLocaleDateString()}.` : ""}</p>
          : billing?.manageable
            ? <p>Your Jam Pass billing needs attention. Update your payment method to keep painting ad-free.</p>
            : <p>Draw in any room for free. Free rooms show one small ad.{config?.display?.monthly ? ` Jam Pass removes ads for you and your guests for ${config.display.monthly}.` : ""}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="studio-plan-actions">
        {hasPass || billing?.manageable
          ? <button type="button" className="studio-button" disabled={busy} onClick={manage}>{busy ? "Opening Stripe…" : "Manage billing"}</button>
          : <a className="studio-button is-loud" href="/jam-pass" onClick={go("/jam-pass")}>{config?.display?.monthly ? "Get Jam Pass" : "See Jam Pass"} <span aria-hidden="true">↗</span></a>}
        {hasPass && billing.aiColoringPaid === true && <a className="studio-link" href="/coloring-book" onClick={go("/coloring-book")}>My Coloring Book</a>}
      </div>
    </section>
    {/* Free plan only, and never while the plan is still loading for a signed-in person. */}
    {!hasPass && (!token || billing !== null) && <SiteSponsorSlot />}
  </>;
}

function SavedArt({ session }) {
  const token = session?.access_token || "";
  const [state, setState] = useState({ status: "loading", items: [], max: 0 });
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const headers = useCallback(() => (token ? { Authorization: `Bearer ${token}` } : { "X-Drawesome-Device-Key": getDeviceKey() }), [token]);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/artworks", { cache: "no-store", headers: headers() });
      if (!res.ok) throw new Error("load");
      const data = await res.json();
      setState({ status: "ready", items: Array.isArray(data.items) ? data.items : [], max: data.max || 0 });
    } catch {
      setState(current => ({ ...current, status: "error" }));
    }
  }, [headers]);
  useEffect(() => { setState({ status: "loading", items: [], max: 0 }); load(); }, [load]);

  const download = async (item) => {
    setBusy(item.id);
    setNote("");
    try {
      const res = await fetch(`/api/artworks/${encodeURIComponent(item.id)}`, { cache: "no-store", headers: headers() });
      const data = res.ok ? await res.json() : null;
      if (!data?.image?.startsWith("data:image/")) throw new Error("image");
      const link = document.createElement("a");
      link.href = data.image;
      link.download = (item.name || "drawesome-art").replace(/[^\w -]+/g, "").trim().slice(0, 60) + ".png";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      setNote("That picture couldn’t be downloaded. Please try again.");
    }
    setBusy("");
  };
  const remove = async (item) => {
    setBusy(item.id);
    setNote("");
    try {
      const res = await fetch(`/api/artworks/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(token ? {} : { userKey: getDeviceKey() }),
      });
      if (!res.ok) throw new Error("delete");
      setState(current => ({ ...current, items: current.items.filter(entry => entry.id !== item.id) }));
      setNote("Picture deleted.");
    } catch {
      setNote("That picture couldn’t be deleted. Please try again.");
    }
    setConfirm("");
    setBusy("");
  };

  return <section className="studio-section" aria-labelledby="studio-art-title">
    <div className="studio-heading">
      <h2 id="studio-art-title">Saved artwork</h2>
      {state.status === "ready" && state.max > 0 && <p>{state.items.length} of {state.max} saved</p>}
    </div>
    {note && <p className="studio-note" role="status">{note}</p>}
    {state.status === "loading" ? <p role="status">Finding your pictures…</p>
      : state.status === "error" ? <p role="status">Your pictures couldn’t load. <button type="button" className="studio-link" onClick={load}>Try again</button></p>
      : !state.items.length ? <p className="studio-empty">Nothing saved yet. In any room, open <strong>Tools</strong> and choose <strong>Save</strong>, and the picture lands here{token ? "" : " on this device"}.</p>
      : <ul className="studio-art">
        {state.items.map(item => <li key={item.id}>
          <div className="studio-art-picture">{item.thumb ? <img src={item.thumb} alt={item.name || "Saved drawing"} loading="lazy" /> : <span aria-hidden="true">🎨</span>}</div>
          <strong>{item.name || "My drawing"}</strong>
          {item.createdAt ? <span>{new Date(item.createdAt).toLocaleDateString()}</span> : null}
          {confirm === item.id
            ? <div className="studio-art-actions"><span>Delete for good?</span>
              <button type="button" className="studio-link" disabled={busy === item.id} onClick={() => remove(item)}>Yes, delete</button>
              <button type="button" className="studio-link" onClick={() => setConfirm("")}>Keep</button></div>
            : <div className="studio-art-actions">
              <button type="button" className="studio-link" disabled={busy === item.id} onClick={() => download(item)}>Download</button>
              <button type="button" className="studio-link is-quiet" onClick={() => setConfirm(item.id)}>Delete</button></div>}
        </li>)}
      </ul>}
  </section>;
}

function Invites({ session, onNavigate }) {
  const token = session?.access_token || "";
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();

  const load = useCallback(() => {
    if (!token) return;
    friendsApi(token).then(value => { setState(value); setError(""); }).catch(problem => setError(problem.status === 401 ? "expired" : problem.message));
  }, [token]);
  useEffect(() => { setState(null); setError(""); load(); }, [load]);

  const act = async (path, method, body) => {
    setBusy(true);
    try { setState(await friendsApi(token, path, { method, body })); setError(""); } catch (problem) { setError(problem.message); }
    setBusy(false);
  };
  const go = href => event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(href);
  };
  const heading = <div className="studio-heading"><h2 id="studio-invites-title">Friends &amp; invites</h2>
    {token && <a className="studio-link" href="/friends" onClick={go("/friends")}>Manage friends <span aria-hidden="true">↗</span></a>}</div>;

  if (!isCloudConfigured) return <section className="studio-section" aria-labelledby="studio-invites-title">
    {heading}
    <p className="studio-empty">Make a room code and send the link. Everyone who opens it paints on the same page.</p>
    <a className="studio-button" href="/friends" onClick={go("/friends")}>Make a room code</a>
  </section>;
  if (!token || error === "expired") return <section className="studio-section" aria-labelledby="studio-invites-title">
    {heading}
    <p className="studio-empty">Sign in to get your own friend code. Friends who use it get a private room with you that is always there.</p>
    <a className="studio-button" href="/signup?mode=login&return=%2Fme" onClick={go("/signup?mode=login&return=%2Fme")}>Sign in</a>
  </section>;

  const link = state?.self ? `${window.location.origin}/friends?add=${state.self.code}` : "";
  return <section className="studio-section" aria-labelledby="studio-invites-title">
    {heading}
    {error && <p role="alert">{error} <button type="button" className="studio-link" onClick={load}>Try again</button></p>}
    {!state && !error && <p role="status">Opening your friends list…</p>}
    {state && !state.self && <>
      <p className="studio-empty">Pick a nickname to get your friend code, then invite people with one link.</p>
      <a className="studio-button" href="/friends" onClick={go("/friends")}>Get my friend code</a>
    </>}
    {state?.self && <>
      <div className="studio-code">
        <div>
          <p className="studio-label">Your friend code</p>
          <strong>{state.self.code}</strong>
          <p>Friends see you as <b>{state.self.name}</b>. Send the invite link, or read them the code.</p>
        </div>
        <div className="studio-code-actions">
          <button type="button" className="studio-button is-loud" onClick={() => copy(link, "Invite link copied.")}>Copy invite link</button>
          <button type="button" className="studio-button" onClick={() => copy(state.self.code, "Friend code copied.")}>Copy code</button>
          {copied && <span role="status">{copied}</span>}
        </div>
      </div>
      <div className="studio-people">
        <div>
          <h3>Waiting for you <span>{state.incoming.length}</span></h3>
          {!state.incoming.length ? <p>No new requests.</p> : <ul>{state.incoming.map(person => <li key={person.code}>
            <b>{person.name}</b>
            <span className="studio-row-actions">
              <button type="button" className="studio-link" disabled={busy} onClick={() => act("/accept", "POST", { code: person.code })}>Accept</button>
              <button type="button" className="studio-link is-quiet" disabled={busy} onClick={() => act("/contact/" + encodeURIComponent(person.code), "DELETE")}>Decline</button>
            </span>
          </li>)}</ul>}
        </div>
        <div>
          <h3>Invites you sent <span>{state.outgoing.length}</span></h3>
          {!state.outgoing.length ? <p>None waiting.</p> : <ul>{state.outgoing.map(person => <li key={person.code}>
            <b>{person.name}</b>
            <button type="button" className="studio-link is-quiet" disabled={busy} onClick={() => act("/contact/" + encodeURIComponent(person.code), "DELETE")}>Cancel</button>
          </li>)}</ul>}
        </div>
        <div>
          <h3>Friends <span>{state.friends.length}</span></h3>
          {!state.friends.length ? <p>When someone accepts, your shared room shows up here.</p> : <ul>{state.friends.map(person => <li key={person.code}>
            <b>{person.name}</b>
            <a className="studio-link" href={"/join/" + encodeURIComponent(person.roomCode)} onClick={go("/join/" + encodeURIComponent(person.roomCode))}>Draw together <span aria-hidden="true">↗</span></a>
          </li>)}</ul>}
        </div>
      </div>
    </>}
  </section>;
}

export default function MyStudioPage({ onNavigate }) {
  const [session, setSession] = useState(isCloudConfigured ? undefined : null);
  useEffect(() => {
    if (!isCloudConfigured) return undefined;
    let active = true;
    let changed = false;
    const unsubscribe = onAuthStateChange(value => { changed = true; if (active) setSession(value); });
    getSession().then(value => { if (active && !changed) setSession(value); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const ready = session !== undefined;
  const name = session?.user?.name || session?.user?.user_metadata?.name || "";

  return <div className="site-page my-studio">
    <SiteNav onNavigate={onNavigate} current="/me" />
    <main className="studio-main" id="main-content">
      <header className="studio-top">
        <h1>My studio</h1>
        <p>{session ? `${name ? name + ", your" : "Your"} boards, saved artwork and friends, in one place.`
          : isCloudConfigured ? "Boards and artwork from this device. Sign in to keep them on every device and invite friends."
          : "Boards and artwork from this device."}</p>
        {ready && !session && isCloudConfigured && <a className="studio-button is-loud" href="/signup?mode=login&return=%2Fme"
          onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate("/signup?mode=login&return=%2Fme"); } }}>Sign in or create an account</a>}
      </header>
      {!ready ? <p role="status">Checking your account…</p> : <>
        <Plan session={session} onNavigate={onNavigate} />
        <section className="studio-section" aria-labelledby="studio-boards-title">
          <div className="studio-heading">
            <h2 id="studio-boards-title">My boards</h2>
            <button type="button" className="studio-button" onClick={() => onNavigate(`/join/${createInviteCode()}`)}>Start a new board <span aria-hidden="true">＋</span></button>
          </div>
          <MyRooms key={session?.access_token || "device"} variant="grid" token={session?.access_token || null} onJoin={code => onNavigate(`/join/${code}`)} />
        </section>
        <SavedArt key={"art-" + (session?.user?.id || "device")} session={session} />
        <Invites session={session} onNavigate={onNavigate} />
      </>}
    </main>
    <SiteFooter onNavigate={onNavigate} />
  </div>;
}
