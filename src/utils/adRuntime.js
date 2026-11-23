// Keep the deployed unit path when moving the display placement out of chat.
export const ROOM_AD_UNIT = (import.meta.env.VITE_GAM_AD_UNIT_CHAT || "").trim();
export const BREAK_AD_UNIT = import.meta.env.VITE_GAM_AD_UNIT_INTERSTITIAL || "";
export const BREAK_MINUTES = Math.max(1, Number(import.meta.env.VITE_AD_BREAK_MINUTES) || 10);
export const breakSignals = new Set();

// Google AdSense, the simpler alternative to an Ad Manager unit. A Google Ad
// Manager room unit wins when both are set. Empty = no script, no ad UI.
const adsenseClient = (import.meta.env.VITE_ADSENSE_CLIENT || "").trim();
export const ADSENSE_CLIENT = /^ca-pub-\d{16}$/.test(adsenseClient) ? adsenseClient : "";
const adsenseSlot = (value) => (ADSENSE_CLIENT && /^\d{6,20}$/.test((value || "").trim()) ? value.trim() : "");
export const ADSENSE_SLOT_ROOM = adsenseSlot(import.meta.env.VITE_ADSENSE_SLOT_ROOM);
export const ADSENSE_SLOT_SITE = adsenseSlot(import.meta.env.VITE_ADSENSE_SLOT_SITE);

let adsenseRequested = false;

// Loads AdSense once and asks for non-personalized ads on every request. The
// child treatment itself rides each unit (data-tag-for-age-treatment="1").
export function ensureAdsense() {
  if (typeof window === "undefined" || !ADSENSE_CLIENT) return null;
  window.adsbygoogle = window.adsbygoogle || [];
  window.adsbygoogle.requestNonPersonalizedAds = 1;
  if (!adsenseRequested) {
    adsenseRequested = true;
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
    script.crossOrigin = "anonymous";
    document.head.appendChild(script);
  }
  return window.adsbygoogle;
}

let gptRequested = false;

export function ensureGpt() {
  if (typeof window === "undefined") return null;
  window.googletag = window.googletag || { cmd: [] };
  if (!gptRequested) {
    gptRequested = true;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
    script.crossOrigin = "anonymous";
    document.head.appendChild(script);
  }
  return window.googletag;
}

export function applyChildSafeSettings(googletag) {
  googletag.pubads().setPrivacySettings({
    childDirectedTreatment: true,
    underAgeOfConsent: true,
    nonPersonalizedAds: true,
    restrictDataProcessing: true,
  });
}

export function signalNaturalAdBreak(reason = "natural_break") {
  for (const listener of breakSignals) listener(reason);
}
