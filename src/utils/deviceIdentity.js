// One capability shared by gallery, guest sketchbooks, Wall and socket auth.
// Keep the existing storage key (also covered by the account-deletion wipe).
const DEVICE_KEY_STORAGE = "drawesome:userkey:v1";
let ephemeralKey = "";

export function getDeviceKey() {
  try {
    const stored = window.localStorage.getItem(DEVICE_KEY_STORAGE);
    // Legacy capabilities are opaque: never trim, validate prefixes or rotate.
    if (stored) return stored;
  } catch {
    // Storage may be blocked; all consumers still share one in-memory key.
  }
  if (!ephemeralKey) {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === "function") {
      ephemeralKey = `dk_${crypto.randomUUID()}`;
    } else if (typeof crypto?.getRandomValues === "function") {
      // randomUUID needs a secure context; getRandomValues also works on HTTP.
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      ephemeralKey = `dk_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    } else {
      // Never mint an ownership credential using weak randomness.
      return "";
    }
  }
  const key = ephemeralKey;
  try {
    window.localStorage.setItem(DEVICE_KEY_STORAGE, key);
    // Once durable, storage is authoritative, including a deletion wipe.
    ephemeralKey = "";
  } catch {
    // Anonymous drawing remains usable with an ephemeral identity.
  }
  return key;
}
