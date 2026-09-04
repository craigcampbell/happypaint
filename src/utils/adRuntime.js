export const CHAT_AD_UNIT = import.meta.env.VITE_GAM_AD_UNIT_CHAT || "";
export const BREAK_AD_UNIT = import.meta.env.VITE_GAM_AD_UNIT_INTERSTITIAL || "";
export const BREAK_MINUTES = Math.max(1, Number(import.meta.env.VITE_AD_BREAK_MINUTES) || 10);
export const breakSignals = new Set();

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
