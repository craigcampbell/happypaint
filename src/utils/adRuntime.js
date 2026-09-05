export const CHAT_AD_UNIT = import.meta.env.VITE_GAM_AD_UNIT_CHAT || "";
export const BREAK_AD_UNIT = import.meta.env.VITE_GAM_AD_UNIT_INTERSTITIAL || "";
export const ADS_BUILD_ENABLED = import.meta.env.VITE_ADS_ENABLED === "true";
export const BREAK_MINUTES = Math.max(10, Number(import.meta.env.VITE_AD_BREAK_MINUTES) || 20);
export const BREAK_MAX_PER_HOUR = Math.max(
  1,
  Math.min(2, Number(import.meta.env.VITE_AD_BREAK_MAX_PER_HOUR) || 2),
);
export const breakSignals = new Set();

let gptRequested = false;
let eligibilityPromise = null;

// A filled ad-unit path is deliberately not enough to start contacting Google.
// Production also has to opt in at build time AND the runtime server must allow
// this request's country. Any missing header, configuration, or network failure
// stays ad-free.
export function getAdEligibility() {
  if (!ADS_BUILD_ENABLED) return Promise.resolve(false);
  if (!eligibilityPromise) {
    eligibilityPromise = fetch("/api/ads/eligibility", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data?.eligible === true)
      .catch(() => false);
  }
  return eligibilityPromise;
}

export function ensureGpt() {
  if (typeof window === "undefined" || !ADS_BUILD_ENABLED) return null;
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
