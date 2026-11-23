import { useEffect, useId, useRef, useState } from "react";
import {
  ADSENSE_CLIENT,
  ADSENSE_SLOT_ROOM,
  ADSENSE_SLOT_SITE,
  applyChildSafeSettings,
  ensureAdsense,
  BREAK_AD_UNIT,
  BREAK_MINUTES,
  breakSignals,
  ROOM_AD_UNIT,
  ensureGpt,
} from "./adRuntime";

// Session-wide rather than per-room: switching rooms must not reset the ten-
// minute clock or the three-per-hour ceiling.
const sessionStartedAt = Date.now();
const sessionShownAt = [];

// One AdSense unit, tagged for child treatment. `onFilled` reports Google's
// own data-ad-status so an unfilled slot can stay collapsed.
function AdSenseUnit({ slot, fixed, onFilled }) {
  const unit = useRef(null);
  useEffect(() => {
    const node = unit.current;
    const queue = ensureAdsense();
    if (!node || !queue) return undefined;
    const report = () => onFilled?.(node.dataset.adStatus === "filled");
    const observer = new MutationObserver(report);
    observer.observe(node, { attributes: true, attributeFilter: ["data-ad-status"] });
    // A unit may be requested once; a remount in development must not re-push.
    if (!node.dataset.adsbygoogleStatus && !node.dataset.requested) {
      node.dataset.requested = "1";
      try { queue.push({}); } catch { /* blocked or already filled */ }
    }
    report();
    return () => observer.disconnect();
  }, [onFilled]);
  return <ins ref={unit} className="adsbygoogle" data-ad-client={ADSENSE_CLIENT} data-ad-slot={slot} data-tag-for-age-treatment="1"
    style={fixed ? { display: "inline-block", width: fixed[0], height: fixed[1] } : { display: "block" }}
    {...(fixed ? {} : { "data-ad-format": "auto", "data-full-width-responsive": "true" })} />;
}

const passLink = <a href="/jam-pass" target="_blank" rel="noopener">Paint ad-free with Jam Pass</a>;

function AdSenseRoomSlot() {
  const [filled, setFilled] = useState(false);
  return (
    <aside className={`room-sponsor${filled ? " is-filled" : ""}`} aria-label="Advertisement">
      <span className="room-sponsor-label">Advertisement · {passLink}</span>
      <AdSenseUnit slot={ADSENSE_SLOT_ROOM} fixed={[320, 50]} onFilled={setFilled} />
    </aside>
  );
}

// The free-plan placement on account pages. Renders nothing until AdSense is
// configured, and stays collapsed when Google has no ad to show.
export function SiteSponsorSlot() {
  const [filled, setFilled] = useState(false);
  if (!ADSENSE_SLOT_SITE) return null;
  return (
    <aside className={`site-sponsor${filled ? " is-filled" : ""}`} aria-label="Advertisement">
      <span className="site-sponsor-label">Advertisement · {passLink}</span>
      <AdSenseUnit slot={ADSENSE_SLOT_SITE} onFilled={setFilled} />
    </aside>
  );
}

export function RoomSponsorSlot() {
  if (!ROOM_AD_UNIT && ADSENSE_SLOT_ROOM) return <AdSenseRoomSlot />;
  return <GptRoomSlot />;
}

function GptRoomSlot() {
  const id = `drawesome-room-ad-${useId().replace(/[^a-z0-9_-]/gi, "")}`;
  const [filled, setFilled] = useState(false);

  useEffect(() => {
    if (!ROOM_AD_UNIT) return undefined;
    const googletag = ensureGpt();
    let slot = null;
    let disposed = false;
    const onRender = (event) => {
      if (!disposed && event.slot === slot) setFilled(!event.isEmpty);
    };
    googletag.cmd.push(() => {
      if (disposed) return;
      applyChildSafeSettings(googletag);
      slot = googletag.defineSlot(ROOM_AD_UNIT, [[300, 50], [300, 100], [320, 50]], id)
        ?.addService(googletag.pubads());
      if (!slot) return;
      googletag.pubads().addEventListener("slotRenderEnded", onRender);
      googletag.enableServices();
      googletag.display(id);
    });
    return () => {
      disposed = true;
      googletag.cmd.push(() => {
        if (!slot) return;
        googletag.pubads().removeEventListener("slotRenderEnded", onRender);
        googletag.destroySlots([slot]);
      });
    };
  }, [id]);

  if (!ROOM_AD_UNIT) return null;
  return (
    <aside className={`room-sponsor${filled ? " is-filled" : ""}`} aria-label="Advertisement">
      <span className="room-sponsor-label">Advertisement · {passLink}</span>
      <div id={id} />
    </aside>
  );
}

export function NaturalBreakAds({ enabled }) {
  useEffect(() => {
    if (!enabled || !BREAK_AD_UNIT) return undefined;
    const googletag = ensureGpt();
    let slot = null;
    let readyEvent = null;
    let disposed = false;
    let recreateTimer = 0;

    const createSlot = () => {
      if (disposed) return;
      readyEvent = null;
      slot = googletag
        .defineOutOfPageSlot(BREAK_AD_UNIT, googletag.enums.OutOfPageFormat.GAME_MANUAL_INTERSTITIAL)
        ?.addService(googletag.pubads());
      if (slot) googletag.display(slot);
    };

    const onReady = (event) => {
      if (event.slot === slot) readyEvent = event;
    };
    const onClosed = (event) => {
      if (event.slot !== slot) return;
      const closedSlot = slot;
      slot = null;
      readyEvent = null;
      googletag.destroySlots([closedSlot]);
      recreateTimer = window.setTimeout(() => googletag.cmd.push(createSlot), 1000);
    };
    const onBreak = () => {
      const now = Date.now();
      while (sessionShownAt.length && sessionShownAt[0] < now - 60 * 60_000) sessionShownAt.shift();
      if (now < sessionStartedAt + BREAK_MINUTES * 60_000 || sessionShownAt.length >= 3 || !readyEvent) return;
      const event = readyEvent;
      readyEvent = null;
      if (event.makeGameManualInterstitialVisible()) sessionShownAt.push(now);
    };

    breakSignals.add(onBreak);
    googletag.cmd.push(() => {
      if (disposed) return;
      applyChildSafeSettings(googletag);
      googletag.pubads().addEventListener("gameManualInterstitialSlotReady", onReady);
      googletag.pubads().addEventListener("gameManualInterstitialSlotClosed", onClosed);
      googletag.enableServices();
      createSlot();
    });

    return () => {
      disposed = true;
      breakSignals.delete(onBreak);
      window.clearTimeout(recreateTimer);
      googletag.cmd.push(() => {
        googletag.pubads().removeEventListener("gameManualInterstitialSlotReady", onReady);
        googletag.pubads().removeEventListener("gameManualInterstitialSlotClosed", onClosed);
        if (slot) googletag.destroySlots([slot]);
      });
    };
  }, [enabled]);

  return null;
}
