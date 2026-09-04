import { useEffect, useId, useRef } from "react";
import {
  applyChildSafeSettings,
  BREAK_AD_UNIT,
  BREAK_MINUTES,
  breakSignals,
  CHAT_AD_UNIT,
  ensureGpt,
} from "./adRuntime";

// Session-wide rather than per-room: switching rooms must not reset the ten-
// minute clock or the three-per-hour ceiling.
const sessionStartedAt = Date.now();
const sessionShownAt = [];

export function ChatSponsorSlot({ enabled }) {
  const reactId = useId();
  const idRef = useRef(`drawesome-chat-ad-${reactId.replace(/[^a-z0-9_-]/gi, "")}`);

  useEffect(() => {
    if (!enabled || !CHAT_AD_UNIT) return undefined;
    const googletag = ensureGpt();
    let slot = null;
    let disposed = false;
    googletag.cmd.push(() => {
      if (disposed) return;
      applyChildSafeSettings(googletag);
      slot = googletag
        .defineSlot(CHAT_AD_UNIT, [[300, 50], [300, 100], [320, 50]], idRef.current)
        ?.addService(googletag.pubads());
      if (!slot) return;
      googletag.pubads().collapseEmptyDivs(true);
      googletag.enableServices();
      googletag.display(idRef.current);
    });
    return () => {
      disposed = true;
      googletag.cmd.push(() => {
        if (slot) googletag.destroySlots([slot]);
      });
    };
  }, [enabled]);

  if (!enabled || !CHAT_AD_UNIT) return null;
  return (
    <aside className="chat-sponsor" aria-label="Sponsored message">
      <span className="chat-sponsor-label">Sponsored · <a href="/family">Family is ad-free</a></span>
      <div id={idRef.current} className="chat-sponsor-slot" />
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
