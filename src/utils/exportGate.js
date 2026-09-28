// Export account gate (studio owner). Product UX gate — NOT DRM: exporting or
// sharing art off this device asks for a signed-in account so published
// artifacts have an accountable author. Anonymous drawing, spectating, local
// autosave/draft recovery and local Paint Space saves stay UNGATED.
//
// Verdicts:
//   { ok: true, session }                        — signed in: export away
//   { ok: false, reason: "sign-in", message }    — cloud configured, guest:
//                                                  offer the normal sign-in UX
//   { ok: false, reason: "local-only", message } — cloud NOT configured:
//                                                  explain; never silently bypass

import { getSession, isCloudConfigured } from "./auth.js";

export const EXPORT_GATE_SIGNIN_MESSAGE =
  "Sign in to export or share your art — your drawing stays right here while you do.";
export const EXPORT_GATE_LOCAL_ONLY_MESSAGE =
  "Exports need a signed-in account, and accounts aren't available on this server — your work stays saved on this device.";

export async function checkExportAllowed() {
  if (!isCloudConfigured) {
    return { ok: false, reason: "local-only", message: EXPORT_GATE_LOCAL_ONLY_MESSAGE };
  }
  const session = await getSession().catch(() => null);
  if (!session) {
    return { ok: false, reason: "sign-in", message: EXPORT_GATE_SIGNIN_MESSAGE };
  }
  return { ok: true, session };
}
