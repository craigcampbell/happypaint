# Drawesome: Product, Design & Curator Direction

> Read this before redesigning discovery, adding community experiences, or expanding Curator.
> This document records the owner's approved direction, why we chose it, what we shipped, and how to continue without undoing the lessons.
>
> Decision history: October 2026. This is direction and rationale, not a claim that every future idea below is implemented. For deployment evidence, see [the Curator release record](docs/curator-release-2026-10-28.md).

## 1. The product we are trying to make

Drawesome is a place to discover drawings, find a reason to make something, and create alongside other people on your own terms.

Craig described the ambition as **“Twitch.tv but for drawing and doodling.”** Interpret that as discovery, creative presence, recognizable studios, and community participation—not as an instruction to copy Twitch's interface or require video streaming.

The essential journey is:

**Something catches my eye → I want to try → I start drawing → I choose whether and how to share.**

The site should feel like an invitation into a lively art space, not a directory that requires understanding its internal systems first. It must work for a casual doodler as well as an artist. Families and younger artists need clear privacy choices and adult guidance; creative adults should not feel they have entered a generic educational dashboard.

The creative promise is permission, not perfection:

**MAKE A BEAUTIFUL MESS.**

## 2. What prompted the change

### Inktober exposed a fragmented experience

The owner felt the Inktober experience was unintuitive and missed its opportunity. Discovery was split between shared rooms, artist studios, sketchbooks, Wall posts, and an event gallery. The visitor had to understand the containers before finding the art or a satisfying way to participate.

Early review found:

- “Gallery” could lead to an empty artist directory rather than visible artwork.
- Separate event and sketchbook surfaces could communicate emptiness despite drawings existing elsewhere.
- The distinction between watching and being allowed to draw was not prominent enough.
- A public shared room could feel much too public for someone who simply wanted to contribute their own picture.

A family-requested community tribute for **Rhoam Summer** made the missing participation model especially clear: people need to respond to a shared idea without all entering one editable canvas or being pressured into public performance.

### The first fixes were mechanically useful but visually wrong

We introduced artwork/event/studio discovery and private-first participation. Those were useful product foundations. But subsequent discovery layouts accumulated repeated navigation, tabs, topic chips, search, sidebars, and similar cards.

Craig rejected the result: **“It's like a lot is messed up I don't like it.”**

Do not dismiss that feedback because a layout passes tests. A functioning interface can still be confusing, uninspiring, or wrong for the product.

The visible problems were:

- Too much interface competing with too little artwork.
- Too many equally weighted choices.
- Repetitive card layouts that flattened importance.
- Small imagery and generic headings.
- Decorative colors without a strong compositional idea.
- A dashboard/directory impression instead of a distinctive creative place.

**Do not drift back to that layout under the guise of adding useful features.**

## 3. The approved creative direction

Craig asked for something one-of-a-kind and very creative, with more fun typography and imagery. His references were Banksy, Ralph Steadman, and Paula Scher, whose designs he particularly likes.

Translate those references into broad design qualities, not copied artwork or a signature-style imitation:

- Public-poster immediacy and confidence.
- Unruly, expressive ink and human irregularity.
- Typography that creates the composition rather than merely labels boxes.
- An unexpected, playful relationship between words and images.
- Strong contrast and a clear point of view.

The warm-paper art-wall preview received explicit approval: **“I like this direction a lot … try to make it even more edgier … by another 15%!”**

That extra edge is a qualitative request, not a measurable design formula. We interpreted it as slightly offset poster lettering, rough ink rules, print-like shadows, and bolder accents—not more clutter, obscenity, illegibility, or aggression.

### Visual vocabulary

| Element | Direction | Why |
|---|---|---|
| Ground | Warm paper, `#f3efdf` | Welcoming, tactile, unlike a software dashboard |
| Ink | Near-black, `#181916` | Clear hierarchy and strong reading contrast |
| Accent | Vermilion, `#e7472d` | Energy and typographic emphasis |
| Highlight | Acid yellow, `#e9f35a` | Playfulness and obvious drawing actions |
| Supporting color | Restrained sky blue | A quieter counterpoint; useful where exuberance is inappropriate |
| Display type | Self-hosted Anton | Condensed, confident poster-scale typography |
| Handwritten accent | Self-hosted Patrick Hand | Human annotation, used sparingly |
| Body copy | Existing readable sans-serif system | Personality must not come at the expense of reading |
| Illustration | Original abstract ink, scribbles, halftone and simple print forms | Creative character without pretending to be community artwork |
| Artwork | Actual public contributions with attribution | The community's work is the point |

Font licenses ship with the assets under `public/fonts/`.

### Composition rules

1. Treat discovery as an **Explore** experience. A distinctive masthead may establish the identity, but real artwork must follow promptly.
2. Let scale, asymmetry, typography, and negative space establish hierarchy before adding containers.
3. Give sections different rhythms. Do not turn every idea into the same three-card grid.
4. Keep one obvious primary path into drawing. Secondary browsing should not compete equally with every CTA.
5. Keep expressive effects on the site's own typography and illustration. Do not rotate, recolor, filter, crop away, or otherwise distort guest artwork for decoration.
6. Keep body copy, privacy language, and form controls stable and legible. The headline can be unruly; the instructions cannot.
7. Avoid purposeless animation, custom cursors that interfere with use, and effects that delay access to drawing.
8. Respect reduced motion and retain visible keyboard focus.
9. Design at phone width first, then make desktop composition more expansive—not the reverse.
10. Do not claim success from a desktop screenshot alone.

### What to avoid

- A dark Twitch clone.
- A generic SaaS landing page dressed up with paint splatters.
- Equal-weight feature tiles everywhere.
- Rainbow accents with no hierarchy.
- Oversized rounded boxes replacing actual composition.
- Tiny labels and low-contrast text in the name of sophistication.
- Navigation duplicated across a sidebar, tabs, topics, and header on the homepage.
- Fake artists, fake artwork, fake popularity, or invented live counts.
- Empty modules that consume a large section merely to announce they are empty.

## 4. The participation model

Keep these concepts distinct:

### Artwork

A picture or animation deliberately shared for others to view. Viewing it does not grant permission to edit or remix it.

### Studio / room

A place where drawing happens. A studio's viewing, painting, ownership, and listing permissions are separate concerns. A public viewing experience must not silently become an open collaborative canvas.

### Community invitation / event

A shared reason to draw that can span many independent canvases and studios. It is **not** synonymous with one shared room.

### Privacy is part of the experience

- “Draw my own” starts on a local private canvas without requiring an account.
- No automatic publication or multiplayer connection for that private path.
- A selected idea should remain visible after the visitor reaches the canvas.
- Publishing requires explicit confirmation describing where the picture will appear.
- A finished contribution can be withdrawn through an ownership-checked action.
- Signing in later must not upload local-only drawings or make device-owned contributions impossible to withdraw.
- Shared-room publication must disclose its event association, including sensitive-event restrictions.
- Listing a studio remains an explicit choice. Creating it does not imply listing it.

The “What-if machine” is a concrete example of the intended tone: playful, functional, low-pressure, and immediately useful. It changes the prompt and carries that prompt into the private drawing experience. It is not a decorative button.

## 5. Sensitive invitations need a different register

The Draw for Rhoam invitation is an independent community response to the family's public request. Preserve its source and do not imply endorsement or affiliation.

For tributes and comparable sensitive subjects:

- Keep the presentation calm, respectful, and readable.
- Welcome quiet participation without publishing.
- Do not gamify grief or use it as an acquisition spectacle.
- Do not add competitive rankings, voting, remix incentives, or monetization pressure.
- Keep applicable protections on the server, not merely hidden in the UI.
- Do not automatically apply the site's edgiest artwork, copy, or interactions to these pages.

Source associated with this invitation:
https://www.opb.org/article/2026/10/19/parents-of-rhoam-summer-share-memories-of-5-year-old-killed-in-bend-shooting/

## 6. Why we built Curator

Craig wanted to change page headers and refresh the homepage/gallery experience without needing a code change each time. He proposed calling the tool **Curator**.

The goal is **editorial flexibility inside a coherent design system**, not an unrestricted CMS that can accidentally destroy the design or its security boundaries.

### What shipped

Curator is at `/admin/curator`, linked from the admin overview, behind the existing admin login and 2FA.

Editable page headers:

- Homepage
- Artwork gallery
- Events index
- Artist studios

Editable fields:

- Kicker
- Headline, up to three lines
- Description
- Margin note
- CTA label and an allowlisted destination
- Palette preset
- Illustration preset

Workflow:

**Edit → inspect live draft preview → Save draft → Publish saved draft.**

There is a published-header preview and an explicit Restore defaults action. Saving does not publish. Restoring defaults replaces both draft and public content after confirmation. Publishing an unchanged draft is disabled.

### Why it is structured

- Text is rendered as text, not executable HTML.
- Presets keep type, color, and artwork within tested boundaries.
- CTA destinations cannot become arbitrary external or executable URLs.
- Field lengths constrain mobile layout risk.
- Admin preview and public pages share the header component.
- Drafts never enter public APIs or crawlable HTML.
- Revision checks prevent one editing session from silently overwriting another.
- Persistence completes before a write is acknowledged.
- Readback verifies saved or published content before the editor reports success.

Persistence is under `DATA_DIR/.curator.json`. Public reads expose only published content. Unsaved editor changes are in memory, not a new durable browser store.

### What it does not do yet

Curator is **not** currently a general page builder. It does not provide:

- Arbitrary HTML, CSS, or JavaScript.
- Image uploads or a media library.
- Section rearrangement.
- A community-event creation/editor workflow.
- Scheduled publication.
- Revision history with one-click rollback to arbitrary prior editions.
- Direct editing of SEO metadata or canonical URLs.

Sensitive tribute detail pages are intentionally outside the initial generic-header editing scope.

Do not describe these future capabilities as implemented.

## 7. SEO is a product constraint, not cleanup work

Craig emphasized SEO and reported roughly 50 organic visits, without specifying a period. The exact number is not the requirement; protecting existing discovery is.

- Preserve existing URLs and canonical behavior.
- Do not rename routes to suit a visual redesign.
- Add useful landing pages without removing established sitemap entries.
- The first discovery release added five routes; the art-wall/Curator release left the sitemap URL set unchanged from its immediate baseline.
- Render published header content into initial crawlable HTML, not only after client-side JavaScript runs.
- Keep metadata and canonical URLs under deliberate control; Curator currently edits visible header content, not SEO configuration.
- Keep private, invitation-capability, and admin surfaces out of indexing.
- Unknown event URLs should not masquerade as valid landing pages.
- Compare actual sitemap URL sets before and after release.
- Technical SEO creates eligibility and clarity; it does not guarantee ranking or traffic.

## 8. How to continue from here

These are proposed directions, not promises or an already-approved implementation queue.

### A. Expand curation before expanding navigation

A stronger selection and arrangement of real artwork is more valuable than another browse category. Consider an editorial featured-work shelf, with clear artist attribution and moderation/withdrawal behavior.

Do not copy private artwork into a public collection or assume that publication grants blanket reuse rights.

### B. Give Curator a safe media workflow

If header uploads are added, include file-type validation, size bounds, alt text, rights confirmation, safe image processing, deletion, and a reversible publication workflow. Never accept arbitrary remote scripts or HTML as a shortcut to flexible layouts.

### C. Make invitations editorially manageable

A future invitation editor could support title, prompt, explanation, dates, participation status, source, and sensitive-event designation. The sensitive designation must drive backend behavior as well as visuals. Preview, publish, archive, and withdrawal need explicit semantics.

Prefer deliberate curation over automated trend promotion. There is no automatic social-trend discovery system today.

### D. Improve watching without making drawing more public

Explore clearer watch-first studios, creator context, and friend participation. Keep spectators from acquiring painting rights. “Twitch for drawing” should not make video streaming or constant public performance a prerequisite.

### E. Make Curator safer as it grows

Useful next candidates are version history, rollback to a previous publication, scheduled editions, and role separation. Add them when there is a real editorial need, not merely because a large CMS would have them.

### F. Measure whether the invitation works

Evaluate whether visitors discover art, start drawing, understand privacy, and voluntarily share. Any added analytics should respect the audience and existing privacy obligations. Do not optimize publication volume by making sharing confusing or coercive.

## 9. Acceptance checklist for future changes

### Product and design

- Is the purpose clear before the visitor understands our internal terminology?
- Does the page show real art prominently?
- Is there an obvious route to drawing without an account?
- Does the design still feel like an original art wall, not a software directory?
- Are decorative choices helping hierarchy rather than competing with it?
- Is a tribute treated differently from a playful challenge?
- Are empty, loading, error, and populated states designed honestly?

### Accessibility and interaction

- Inspect phone and desktop screenshots, not only DOM assertions.
- Check overflow at narrow phone, intermediate, and desktop widths.
- Exercise keyboard focus, mobile menu, and reduced motion.
- Keep important controls comfortably tappable.
- Test maximum valid CMS field lengths and every preset.
- Carry a selected prompt into the canvas visibly.

### Privacy and correctness

- Verify no unintended upload or room socket before private participation consent.
- Verify publish and unpublish against a real isolated server.
- Test later sign-in with local-only art and anonymous ownership.
- Verify draft isolation in public API, rendered DOM, and initial HTML.
- Test stale revisions, failed persistence, unauthorized requests, and 2FA.
- Verify normal anonymous drawing still works with cloud configuration absent.

### Release

- Run lint, build, and relevant regression suites.
- Test the built app, not only a Vite fixture harness.
- Keep QA data and ports separate from production.
- Preserve the current source baseline and reconcile concurrent changes.
- Back up app data and tag the running image before an app-only swap.
- Do not restart the database or tunnel unnecessarily.
- Read back the live result, compare asset bytes, and check the sitemap.
- Record what is implemented, verified, committed, and deployed separately.

## 10. Implementation map and evidence

| Concern | Main files |
|---|---|
| Homepage composition and prompt interaction | `src/components/HomePage.jsx`, `src/components/artwall-home.css` |
| Shared discovery layout | `src/components/DiscoveryPage.jsx`, `src/components/discovery.css` |
| Event detail and sensitive treatment | `src/components/CommunityEventPage.jsx`, `src/data/communityEvents.js` |
| Header component and presets | `src/components/CuratedHeader.jsx`, `src/components/curator.css` |
| Public header loading | `src/hooks/useCuratorContent.js` |
| Curator editor | `src/components/AdminCurator.jsx` |
| Shared content schema/defaults | `src/data/curatorContent.js` |
| Persistence and admin/public API | `server/curator.js`, integration in `server.js` |
| Crawlable landing content | `server/discoverySeo.js` |
| Private drawing prompt banner | `src/components/EventDrawingBanner.jsx` |

Relevant verification commands:

```sh
npm run lint
npm run build
node --test test/curator-content.test.mjs
node scripts/curator-server-verify.mjs
node scripts/curator-built-ui-verify.mjs
node scripts/discovery-seo-verify.mjs
node scripts/event-drawing-ui-verify.mjs
```

The preview-specific `scripts/artwall-ui-verify.mjs` requires its isolated preview server. Read script headers and resource allocations before running suites concurrently.

Historical release details:

- [Discovery release](docs/discovery-release-2026-10-26.md)
- [Art-wall + Curator release and operating guide](docs/curator-release-2026-10-28.md)
- Application release commit: `28cf988d0b8c177a6e23748b4162e17abf91c965`.
- Release documentation commit: `2263943237017e1f05bc09e9b749c012bc3dfcfb`.

Paths at the time of this work:

- Deployment source: `/home/craig/Projects/happypaint` (not a Git checkout).
- Implementation worktree: `/home/craig/Projects/happypaint-artwall-20261026`.

These paths and release identifiers are historical context. Re-check current Git and Docker state before future deployment work.

## The guiding test

**Does this make someone want to pick up a brush—and let them do it on their own terms?**

If the answer is no, more features, more navigation, or more visual noise will not fix it.
