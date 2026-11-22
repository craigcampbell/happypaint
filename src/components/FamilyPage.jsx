import { useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { getSession, isCloudConfigured, onAuthStateChange } from "../utils/auth";
import { createInviteCode } from "../utils/social";
import { isCanceled } from "../utils/cancellation";

export default function FamilyPage({ onNavigate }) {
  const [session, setSession] = useState(null);
  const [config, setConfig] = useState(null);
  const [billing, setBilling] = useState(null);
  const [interval, setInterval] = useState("monthly");
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    getSession().then((value) => active && setSession(value));
    fetch("/api/billing/config", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((value) => active && setConfig(value || { configured: false, plans: {} }))
      .catch(() => active && setConfig({ configured: false, plans: {} }));
    const unsubscribe = onAuthStateChange((value) => active && setSession(value));
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setBilling(null); return; }
    let active = true;
    const load = () => fetch("/api/billing/me", {
        cache: "no-store",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((value) => active && setBilling(value))
        .catch(() => active && setBilling(null));
    load();
    // Stripe redirects before its webhook is guaranteed to finish. On a
    // successful return, reconcile the exact Checkout Session immediately and
    // briefly poll as a fallback for asynchronous payment methods.
    const params = new URLSearchParams(window.location.search);
    const successfulReturn = params.get("checkout") === "success";
    const checkoutSessionId = params.get("session_id");
    if (successfulReturn && checkoutSessionId) {
      fetch("/api/billing/checkout/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ sessionId: checkoutSessionId }),
      })
        .then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => null) }))
        .then(({ ok, data }) => {
          if (!active || !ok || !data) return;
          setBilling(data);
          if (data.active) setMessage("Family is active, welcome!");
        })
        .catch(() => {});
    }
    let attempts = 0;
    const timer = successfulReturn ? window.setInterval(() => {
      attempts += 1;
      load();
      if (attempts >= 10) window.clearInterval(timer);
    }, 1000) : 0;
    return () => { active = false; window.clearInterval(timer); };
  }, [session]);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("checkout");
    if (result === "success") setMessage("Family is activating, welcome! It may take a few seconds to update.");
    // Accepts the legacy ?checkout=cancelled spelling on old Stripe cancel URLs.
    if (isCanceled(result)) setMessage("Nothing was charged. You can come back whenever you're ready.");
  }, []);

  const callBilling = async (path, body) => {
    if (!session?.access_token) { onNavigate("/signup?return=/family"); return; }
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(data.error || "Couldn't open billing");
        error.code = data.error;
        throw error;
      }
      if (data.url) window.location.href = data.url;
    } catch (error) {
      if (error.code === "subscription_exists") {
        const current = await fetch("/api/billing/me", {
          cache: "no-store",
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
        if (current) setBilling(current);
      }
      const friendly = {
        billing_not_configured: "Subscriptions are not connected yet.",
        subscription_exists: "This account already has a subscription. Manage it below.",
        checkout_in_progress: "A checkout is already open for this account. Finish or cancel it before changing plans.",
        slow_down: "Please wait a moment before trying again.",
        portal_failed: "Billing management is temporarily unavailable. Please try again.",
        checkout_failed: "Secure checkout is temporarily unavailable. Please try again.",
      };
      setMessage(friendly[error.code] || "Billing is temporarily unavailable. Please try again.");
      setBusy(false);
    }
  };

  const price = config?.display?.[interval];
  const configuredForPlan = Boolean(isCloudConfigured && price && config?.configured && config?.plans?.[interval]);
  const [priceAmount, priceUnit] = price ? price.split("/") : [];
  const openRoom = () => onNavigate(`/join/${createInviteCode()}`);
  const yearlySavings = Number(config?.yearlySavingsPercent);

  return (
    <div className="family-page">
      <SiteNav onNavigate={onNavigate} current="/family" />
      <main className="family-main">
        <section className="family-hero" aria-labelledby="family-title">
          <div>
            <p className="family-kicker">Drawesome Family</p>
            <h1 id="family-title">Send a little <em>art.</em></h1>
            <p className="family-lead">Turn a drawing you made together into a postcard for someone you love.</p>
            <a href="#family-membership" className="family-jump">
              {billing?.active ? "Your Family membership" : "Explore the Family plan"}
              {!billing?.active && config?.configured && isCloudConfigured && config.display?.monthly ? ` · ${config.display.monthly}` : ""} ↓
            </a>
          </div>
          <figure className="family-example">
            <img src="/media/family-postcard.webp" width="960" height="640" alt="A blue whale rises above ocean waves on a postcard with a note for Nana." />
            <figcaption>From a shared canvas to a postcard.</figcaption>
          </figure>
        </section>

        <section className="family-offer" aria-labelledby="family-plan-title">
          <div className="family-benefits">
            <h2 id="family-plan-title">Inside the Family plan</h2>
            <dl>
              {isCloudConfigured && config?.aiColoringEnabled && <>
                <dt>Make your own coloring pages</dt>
                <dd>Ask for a scene like “a red panda running a bakery on the moon.” In a private drawing room you own, open Coloring sheets to generate up to five pages per calendar month. Download a page to print or put it on the canvas for everyone to color.</dd>
              </>}
              <dt>Art postcards</dt>
              <dd>Open Invite in your room, choose <strong>Make an art postcard</strong> and add a note. Save the PNG to attach to an email, or share it through a supported app on your device.</dd>
              <dt>Ad-free painting for you</dt>
              <dd>Sign in with your Family account to paint ad-free in any drawing room you visit.</dd>
              <dt>One plan for the room</dt>
              <dd>Everyone who draws in a private room you own can paint ad-free and make postcards. Your guests join for free.</dd>
            </dl>
          </div>

          <div className="family-card" id="family-membership">
            {billing?.active || billing?.manageable ? (
              <>
                <span className="family-active-badge">{billing.active ? "Family active" : "Billing needs attention"}</span>
                <h2>{billing.active ? "Your Family plan" : "Keep your Family plan running"}</h2>
                <p>{billing.active
                  ? "Start a private room and share its invite link. Your guests get the room’s Family benefits as soon as they join."
                  : "Update your payment method or review the subscription securely in Stripe."}</p>
                {billing.renewsAt ? <p className="family-renewal">{billing.cancelAtPeriodEnd ? "Ends" : "Renews"} {new Date(billing.renewsAt).toLocaleDateString()}</p> : null}
                {billing.active && <button type="button" className="primary-action" onClick={openRoom}>Open a Family room</button>}
                {billing.active && isCloudConfigured && config?.aiColoringEnabled && (
                  <button type="button" className="family-manage" onClick={() => onNavigate(`/join/${createInviteCode()}?color=1`)}>Open a room for coloring</button>
                )}
                <button type="button" className="family-manage" disabled={busy} onClick={() => callBilling("/api/billing/portal")}>Manage billing</button>
              </>
            ) : (
              <>
                <h2>Family membership</h2>
                {price && <>
                  <div className="family-price-toggle" role="group" aria-label="Billing frequency">
                    <button type="button" aria-pressed={interval === "monthly"} className={interval === "monthly" ? "is-on" : ""} onClick={() => setInterval("monthly")}>Monthly</button>
                    <button type="button" aria-pressed={interval === "yearly"} className={interval === "yearly" ? "is-on" : ""} onClick={() => setInterval("yearly")}>
                      Yearly{yearlySavings > 0 ? ` · save ${yearlySavings}%` : ""}
                    </button>
                  </div>
                  <p className="family-price"><strong>{priceAmount}</strong><span>/{priceUnit}</span></p>
                  <p className="family-price-note">Renews {interval}. A grown-up can manage or cancel renewal in Stripe.</p>
                </>}
                {session && configuredForPlan ? (
                  <label className="family-adult-check">
                    <input type="checkbox" checked={adultConfirmed} onChange={(event) => setAdultConfirmed(event.target.checked)} />
                    <span>I am an adult and authorize this subscription.</span>
                  </label>
                ) : null}
                <button
                  type="button"
                  className="primary-action family-buy"
                  disabled={busy || !configuredForPlan || (session && !adultConfirmed)}
                  onClick={() => session ? callBilling("/api/billing/checkout", {
                    interval,
                    adultConfirmed,
                    termsVersion: config?.termsVersion,
                  }) : onNavigate("/signup?return=/family")}
                >
                  {busy ? "Opening secure checkout…" : !config ? "Checking availability…" : !configuredForPlan ? "Subscriptions opening soon" : !session ? "Sign in as a parent" : "Start Drawesome Family"}
                </button>
                {!configuredForPlan ? (
                  <div className="family-setup-note" role="status">
                    <p>{config ? "Family checkout is currently unavailable. You can still draw together for free." : "You can start drawing while we check."}</p>
                    <button type="button" onClick={() => isCloudConfigured && !session ? onNavigate("/friends") : openRoom()}>Draw with friends for free</button>
                  </div>
                ) : null}
              </>
            )}
            {message ? <p className="account-status" role="status">{message}</p> : null}
          </div>
        </section>

        <section className="family-plain-language">
          <h2>What can we do for free?</h2>
          <p>Open a public room as a guest, paint on a shared canvas and save your drawing. Friends and family can meet by room code. On a site with accounts, sign in to enter a private room.</p>
          <a href="/rooms" onClick={event => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            onNavigate("/rooms");
          }}>Browse drawing rooms</a>
        </section>
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
