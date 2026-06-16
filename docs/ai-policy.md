# Happy Paint AI Policy

Policy version: 2026-06-15
Current consent version string in use: `2026-06-15`

This is the AI safety, consent, and rollout policy for Happy Paint. Happy Paint is a youth-focused social drawing app with a primary audience of preteens and teens. AI in Happy Paint exists to help people make art, not to make art for them and not to replace the reason they came.

This document is a policy/spec, not code. It is written to stay consistent with the backend schema (`ai_consent`, `ai_generations`, `ai_credits`, `asset_moderation_queue`) and with `docs/product-research.md` (§"AI Assist, Not AI Replacement", §"Safety and Compliance Notes") and `docs/paint-economy.md` (§"AI assist credits").

## Principles

1. **AI assists, it does not replace.** Every AI feature should make a human-made drawing easier, faster, or more fun to start. It must never produce a finished artwork that competes with the user's own creation as the default outcome. If a feature would make the human contribution optional, it does not ship in v1.
2. **Kid-safety first.** The default audience is a minor. When safety and capability conflict, safety wins. Conservative defaults apply everywhere, and the most restrictive surface (`kid_safe`) gets the smallest AI surface.
3. **Transparency.** AI output is always labeled as AI-assisted. Users (and guardians) can see what was generated, when, with which helper, and under which consent version. Every generation is logged in `ai_generations` with `kind`, `input`, `output`, `model`, and `consent_version`.
4. **Guardian control for minors.** For under-13 accounts, AI is off until a guardian grants consent, and guardians can revoke it at any time. AI spend for minors is guardian-controlled.
5. **No training on user art without explicit consent.** Happy Paint does not train, fine-tune, or otherwise improve any model on user-created art, prompts, or generations unless the user (and guardian, for minors) has given explicit, separate, opt-in consent. Consent to use a helper is not consent to train on its inputs or outputs.

## Consent Model

AI is opt-in and versioned. Consent maps directly to the `ai_consent` table.

### What consent means

- **Versioned.** Each consent record is keyed by `(profile_id, version)`. `version` is a policy version string (currently `2026-06-15`). When the policy materially changes, we bump the version and re-collect consent. Old consent does not silently carry forward to new AI capabilities.
- **Per-feature opt-in surface.** Although the table stores a single policy version per profile, the consent UI presents AI as a set of named, plain-language helpers (palette, prompt cards, brush recipes, sketch cleanup, background thumbnails, captions, tiny-loop in-betweens). Granting consent for a policy version enables only the helpers described in that version's consent screen. Adding a new helper category that sends data off-device requires a new version and fresh consent.
- **Guardian-managed for under-13.** For a `child` profile (`profiles.profile_kind = 'child'`), the consent record must carry a `guardian_profile_id`. The schema enforces this at generation time: `ai_generations` inserts are rejected unless an active consent row exists and, for child profiles, that consent row has a guardian. Guardians may grant, view, and revoke a child's AI consent.
- **Revocation.** Consent is revocable by setting `ai_consent.revoked_at`. Once revoked, no new generations are permitted under that version (the insert policy requires `revoked_at is null`). Revocation is immediate and never gated, never sold, and never buried.

### What is stored

- `ai_consent`: `profile_id`, optional `guardian_profile_id`, `version`, `consented_at`, `revoked_at`. No raw personal data.
- `ai_generations`: the `input` and `output` payloads, the `model` used (null for local/deterministic helpers), the `consent_version` in force at generation time (audit trail), `kind`, and `moderation_status`. This is the auditable record of every AI interaction.
- We do not store more than is needed to render, moderate, audit, and (where the user asked) reuse a generation.

## Allowed AI v1 (Safe)

All v1 helpers below are deliberately narrow. **Local and deterministic generation is strongly preferred for v1**: it works offline, no user data leaves the device, there is no external model risk, and there is no per-call vendor cost. Where a helper can be done with on-device logic, curated internal data, or a fixed algorithm, it must be.

| Helper | `ai_generations.kind` | Where it runs (v1) | Notes |
| --- | --- | --- | --- |
| Palette from theme | `palette` | Local / deterministic | Maps a room theme or keywords to a harmonious color set using on-device rules and curated palettes. No external call. |
| Kid-safe prompt cards | `prompt_card` | Local, from approved categories | Draws from a curated, pre-approved prompt library and recombines safe fragments. Never free-form open generation in `kid_safe`. |
| Brush recipe from plain language | `brush_recipe` | Local / deterministic | "Scratchy pencil," "soft marker," "glitter gel pen" map to existing Happy Paint brush-recipe parameters. Produces settings, not images. |
| Sketch to line cleanup | `line_cleanup` | On-device if feasible; otherwise server-side **with consent** | Cleans a user's own strokes into cleaner line art. This is the most likely candidate to need server-side help; see Rollout v2. |
| Background suggestion thumbnails | `background` | Local / curated | Suggests simple background fills/gradients/patterns from a curated internal set as thumbnails the user can choose, not auto-applied scenes. |
| Caption / alt-text suggestions | `caption` | Local where possible | Suggests short captions and accessibility alt-text for completed art. User edits and approves before anything is attached. |
| Tiny-loop in-between suggestions | (logged as the relevant kind) | Local / deterministic | Suggests simple interpolated in-between frames for 2/4/8-frame loops. The artist still owns and edits each frame. |

Rules for all v1 helpers:

- They produce *ingredients* (palettes, recipes, suggestions, cleanups of the user's own marks), not finished standalone artwork.
- They are clearly labeled AI-assisted.
- Their output is logged in `ai_generations` and, if it could become shareable, is subject to moderation (see below).
- In `kid_safe` surfaces, only local/curated helpers are enabled in v1.

## Avoided / Delayed

These are explicitly out of scope for v1 and gated or excluded beyond it. This list mirrors `docs/product-research.md` §"AI Assist, Not AI Replacement".

- **Open-ended image generation in kid-safe rooms.** Free-form "make me any picture" prompts are unsafe to moderate at scale for minors and undercut the make-art principle. Excluded from `kid_safe`; only considered for older/guardian-approved users in later phases.
- **Face / person generation.** Generating realistic faces or people invites impersonation, deepfake, and grooming-adjacent risks. Not built.
- **Style-cloning of living artists.** Imitating a named living artist's style raises rights and consent concerns and is not a creation skill we want to teach. Not built.
- **Training on user art without consent.** Prohibited by Principle 5. No silent training, ever.
- **Copyrighted-character output as a default flow.** We do not ship flows whose obvious purpose is to emit copyrighted characters. This protects users and the platform from infringement exposure.

Each of these can only be reconsidered through a product-council safety review (see §Model & Vendor Posture), and never as a default in `kid_safe`.

## Generated-Asset Moderation

Any AI output that could become shareable, public, or part of a pack must pass moderation before it leaves the creating user's private space.

- Every generation is logged in `ai_generations` with `moderation_status` defaulting to `pending`. The status flows `pending -> approved` or `pending -> blocked`. `moderation_status` is server/admin-set only — clients cannot self-approve. The insert policy forces new rows to `pending`.
- A generation stays usable privately by its creator while `pending`, but cannot be published, shared into a room beyond the creator, or packaged until `approved`.
- When an AI-assisted output is promoted into a reusable Paint Space asset or pack, it joins the existing community asset pipeline via `asset_moderation_queue` (`target_kind` of `asset` or `pack`, `status` `pending -> approved | rejected | needs_changes`). AI provenance from `ai_generations` is carried into that review so moderators know an item is AI-assisted.
- `blocked` generations are retained for audit/abuse review but cannot be surfaced or reused.
- This is the same "safety queue for generated assets" called out in the product-research AI roadmap, aligned with the asset moderation queue used for community brushes, stamps, and packs.

## Age & Audience Gating

AI availability follows the room/surface audience model (`room_audience`: `kid_safe`, `friends`, `adult_18`) and the Paint Space age bands (`under_13`, `teen`, `adult`).

- **`kid_safe` surfaces:** only local/curated v1 helpers (palette, curated prompt cards, brush recipes, curated backgrounds, captions/alt-text, local tiny-loop in-betweens). No open-ended generation. No off-device generation unless explicitly consented and moderated, and never face/person/style-clone generation.
- **`friends` surfaces:** same v1 helpers, plus consented server-side sketch cleanup (Rollout v2) behind credits and moderation. Still no face/person or style-clone generation.
- **`adult_18` surfaces:** broader assist may be considered in Rollout v3 for verified adults, still excluding face/person generation, style-cloning of living artists, and training-without-consent. `adult_18` remains undiscoverable from child-safe surfaces (per the schema's discovery constraints).
- **Guardian gates:** for `child` profiles, AI is unavailable until a guardian grants consent (`ai_consent.guardian_profile_id`), and guardians control AI credit spend. For `under_13` Paint Spaces, AI-assisted outputs inherit the same non-public default as the space itself (private/friends only).

## Monetization

AI has a real per-use cost when it runs server-side, so it is metered with credits rather than hidden or unlimited. This aligns with `docs/paint-economy.md` (§"AI assist credits") and the Drops economy.

- **AI credits, not unlimited hidden cost.** Server-side AI consumes from a per-profile balance in `ai_credits` (`balance`, non-negative). v1 local/deterministic helpers do not consume credits because they cost nothing per call.
- **Basic non-AI creation stays free.** Drawing, layers, rooms, saving, sharing, blocking, reporting, and account deletion are never gated behind AI credits.
- **Guardian-controlled spend for minors.** For minors, AI credit purchase and spend are guardian-controlled, consistent with the economy's guardian-gated purchasing rules. Under-13 accounts cannot independently buy credits.
- **Sell credit bundles only after safety review.** AI credit bundles (sold for Drops) ship only after the AI safety model — consent, moderation, gating — is live and has passed product-council review. We do not sell credits ahead of the safety apparatus.
- **No predatory patterns.** No loot-box randomness, no scarcity pressure aimed at kids, no streaks that push AI spend. Credit balances and AI spend history are visible to guardians.

## Model & Vendor Posture

The shipped v1 favors local, deterministic helpers and makes **no external model calls**. The posture below applies if and when server-side models are introduced (Rollout v2+).

- **Data minimization.** Send the model only what the helper needs (e.g. the user's own strokes for line cleanup). No profile identifiers, contact data, or unrelated content.
- **No child-data training.** Vendor agreements must contractually prohibit training on Happy Paint inputs/outputs, with explicit no-training guarantees for children's data. This is a hard requirement, not a preference.
- **Retention limits.** Server-side prompt/output data is retained only as long as needed to deliver the result, run moderation, and meet audit/abuse obligations, then deleted. Vendors must not retain beyond our stated window.
- **Prompt/output logging policy.** Happy Paint logs generations in `ai_generations` for transparency, moderation, and audit. Logs are access-controlled (owner, guardian for minors, admins) per the table's row-level security. Logs are not used for training.
- **Vendor choice.** If a server-side LLM is used for future assist features (e.g. caption phrasing, plain-language brush parsing at higher quality, line-cleanup assistance), prefer the latest Claude models (e.g. Claude Opus / Claude Sonnet) for their safety posture and steerability. Any specific vendor and model choice must pass the product council's safety review before it ships, and must meet the no-training, retention, and data-minimization requirements above.

## Rollout Phases

- **v1 — Local helpers, no external calls.** Palette, curated prompt cards, brush recipes, curated background thumbnails, captions/alt-text, and tiny-loop in-betweens run on-device/deterministically. No data leaves the device for generation. No credits consumed. Available (in curated form) in `kid_safe`. Consent is still recorded so transparency and labeling are in place from day one.
- **v2 — Consented server-side cleanup behind credits + moderation.** Sketch-to-line cleanup (and any helper that genuinely needs a server model) runs server-side only with active consent, consumes `ai_credits`, logs to `ai_generations`, and routes shareable output through the moderation gate. Available in `friends` (and guardian-approved `kid_safe`) with conservative defaults. Vendor must have passed product-council review.
- **v3 — Broader assist for older / guardian-approved users.** Additional assist for verified adults and guardian-approved teens, still excluding face/person generation, style-cloning of living artists, copyrighted-character default flows, and training-without-consent. Each new capability is added only via a consent-version bump and a safety review.

## Compliance

Happy Paint takes a conservative compliance posture for a service likely directed to, and used by, children. This mirrors `docs/product-research.md` §"Safety and Compliance Notes".

- **COPPA.** AI features that would collect or process personal data from under-13 users are off by default and require verifiable guardian consent. We do not condition basic participation on AI or on collecting unnecessary data.
- **FTC 2025 children's-privacy limits.** We do not monetize children's data and do not use AI inputs/outputs for advertising or third-party data sharing. Parental opt-in governs any feature that could implicate this.
- **Apple Kids Category.** No AI purchasing opportunities or external links without a parental gate; privacy, commerce, and analytics handled with Kids Category care. AI credit purchase for minors sits behind guardian control.
- **Google Play Families.** AI features follow Families ads/monetization and content rules; no behavioral targeting, no unsafe generated content surfaced to children.
- **Conservative defaults.** AI off until consented; most restrictive surface gets the smallest AI surface; off-device generation disabled by default in `kid_safe`.
- **Auditability.** Every generation is logged with kind, input, output, model, consent version, and moderation status. Consent grants and revocations are timestamped. Moderation decisions are recorded. This supports internal review, guardian transparency, and regulator inquiries.

## Source Notes

Regulatory sources, consistent with `docs/product-research.md`:

- FTC COPPA 2025 update (limits on monetizing children's data; parental opt-in for third-party advertising): https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data
- Apple kids guidance: https://developer.apple.com/kids/
- Google Play Families policy: https://support.google.com/googleplay/android-developer/answer/9893335

Internal references:

- `docs/product-research.md` §"AI Assist, Not AI Replacement", §"Safety and Compliance Notes", §"AI" (feature priority map).
- `docs/paint-economy.md` §"AI assist credits", §"Children and Teens", §"Economy Safety Rules".
- `backend/supabase/schema.sql`: `ai_consent`, `ai_generations` (`ai_generation_kind`, `ai_moderation_status`), `ai_credits`, and `asset_moderation_queue`.
