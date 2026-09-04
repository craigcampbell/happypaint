import { useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { getSession, onAuthStateChange } from "../utils/auth";

export default function FamilyPage({ onNavigate }) {
  const [session, setSession] = useState(null);
  const [config, setConfig] = useState(null);
  const [billing, setBilling] = useState(null);
  const [interval, setInterval] = useState("yearly");
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    getSession().then((value) => active && setSession(value));
    fetch("/api/billing/config", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((value) => active && setConfig(value))
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
    // successful return, briefly poll so the page turns active on its own.
    const successfulReturn = new URLSearchParams(window.location.search).get("checkout") === "success";
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
    if (result === "success") setMessage("Family is activating — welcome! It may take a few seconds to update.");
    if (result === "cancelled") setMessage("Nothing was charged. You can come back whenever you're ready.");
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
      const friendlyErrors = {
        already_subscribed: "Family is already active. Refresh this page to manage it.",
        checkout_pending: "A checkout is already opening. Please wait a moment.",
        checkout_failed: "Stripe checkout couldn't open. Please try again.",
        portal_failed: "Billing management couldn't open. Please try again.",
        plan_misconfigured: "Subscriptions are being configured. Please check back soon.",
      };
      if (!res.ok) throw new Error(friendlyErrors[data.error] || data.detail || data.error || "Couldn't open billing");
      if (data.url) window.location.href = data.url;
    } catch (error) {
      setMessage(error.message === "billing_not_configured" ? "Subscriptions are not connected yet." : error.message);
      setBusy(false);
    }
  };

  const configuredForPlan = Boolean(config?.configured && config?.plans?.[interval]);
  const [priceAmount, priceUnit] = String(
    config?.display?.[interval] || (interval === "yearly" ? "$39/year" : "$4.99/month"),
  ).split("/");
  const yearlySavings = Number(config?.yearlySavingsPercent);

  return (
    <div className="family-page">
      <SiteNav onNavigate={onNavigate} current="/family" />
      <main className="family-main">
        <section className="family-hero">
          <p className="home-eyebrow">Drawesome Family</p>
          <h1>One creative space. All their friends.</h1>
          <p className="family-lead">
            A parent-owned, ad-free home for a child&apos;s drawings and private rooms. Friends join free from the invite link—no subscription and no account required.
          </p>
        </section>

        <section className="family-offer" aria-labelledby="family-plan-title">
          <div className="family-benefits">
            <h2 id="family-plan-title">What Family unlocks</h2>
            <ul>
              <li><span>✓</span><strong>Ad-free private rooms</strong><small>Everyone invited by your family paints without ads.</small></li>
              <li><span>✓</span><strong>Parent-owned space</strong><small>The subscription stays with the grown-up&apos;s account.</small></li>
              <li><span>✓</span><strong>Friends always join free</strong><small>Send a room code. Guests never hit a paywall.</small></li>
              <li><span>✓</span><strong>Keep the free studio free</strong><small>Your plan helps pay for canvases, rooms, and new brushes.</small></li>
            </ul>
          </div>

          <div className="family-card">
            {billing?.active ? (
              <>
                <span className="family-active-badge">Family active</span>
                <h2>Your spaces are ad-free</h2>
                <p>Invite as many friends as the room allows. They inherit your ad-free room automatically.</p>
                {billing.renewsAt ? <p className="family-renewal">{billing.cancelAtPeriodEnd ? "Ends" : "Renews"} {new Date(billing.renewsAt).toLocaleDateString()}</p> : null}
                <button type="button" className="primary-action" disabled={busy} onClick={() => callBilling("/api/billing/portal")}>Manage billing</button>
              </>
            ) : (
              <>
                <div className="family-price-toggle" role="group" aria-label="Billing frequency">
                  <button type="button" className={interval === "monthly" ? "is-on" : ""} onClick={() => setInterval("monthly")}>Monthly</button>
                  <button type="button" className={interval === "yearly" ? "is-on" : ""} onClick={() => setInterval("yearly")}>
                    Yearly{yearlySavings > 0 ? ` · save ${yearlySavings}%` : ""}
                  </button>
                </div>
                <p className="family-price"><strong>{priceAmount}</strong><span>/{priceUnit || (interval === "yearly" ? "year" : "month")}</span></p>
                <p className="family-price-note">Cancel anytime from the parent account.</p>
                {session ? (
                  <label className="family-adult-check">
                    <input type="checkbox" checked={adultConfirmed} onChange={(event) => setAdultConfirmed(event.target.checked)} />
                    <span>I am an adult and authorize this subscription.</span>
                  </label>
                ) : null}
                <button
                  type="button"
                  className="primary-action family-buy"
                  disabled={busy || (session && (!adultConfirmed || !configuredForPlan))}
                  onClick={() => session ? callBilling("/api/billing/checkout", { interval, adultConfirmed }) : onNavigate("/signup?return=/family")}
                >
                  {!session ? "Sign in as a parent" : !configuredForPlan ? "Subscriptions opening soon" : busy ? "Opening secure checkout…" : "Start Drawesome Family"}
                </button>
                {!configuredForPlan ? <p className="family-setup-note">The product is ready; connect Stripe price IDs on the server to open checkout.</p> : null}
              </>
            )}
            {message ? <p className="account-status">{message}</p> : null}
          </div>
        </section>

        <section className="family-plain-language">
          <h2>Built for a parent to own—not a kid to buy.</h2>
          <p>There are no paid coins, cash tips, or purchases inside the canvas. The free studio remains usable without an account. Family simply removes advertising from private spaces owned by the subscribed account.</p>
        </section>
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
