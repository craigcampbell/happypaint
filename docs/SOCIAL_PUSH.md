# Drawesome: getting activity, feedback and shares

Research date: **2026-09-15**. Prepared from the live site (drawesome.art), the
repo, the production API, and public sources. Nothing was posted, DM'd, or paid
for. This file is a plan plus ready-to-use copy, not a record of outreach.

Companion file: `docs/SOCIAL_COPY.md` (paste-ready text per venue).

---

## 1. The honest diagnosis

Drawesome's problem is **not reach. It is concurrency.**

Measured on the live site today:

| What was checked | What it actually showed |
| --- | --- |
| Homepage public canvas | `0 drawing now` |
| `/rooms` | **20 themed public rooms, every one labeled "Be the first!"** |
| `/wall` (The Fridge Wall) | 2 posts, both titled "My drawing", by guest-generated names (`Crispy Crow`, `Zesty Wren`) |
| Shared-canvas mechanic | **Works.** A stroke drawn in one browser session appeared in a second, independent session (2603 non-white pixels on a fresh canvas; counter moved 1 → 2 "painting together") |
| `/api/billing/config` | `{"configured": false, "plans": {"monthly": false, "yearly": false}}` |
| Homepage **"Draw now"** CTA | **A fresh random room on every page load.** Session A got `/join/7T9QCU`, an independent session B got `/join/39ZBUF`, and reloading A gave `/join/L5P6B8` |
| `/rooms` themed cards | **Stable and shared.** "Dino World" resolved to `/join/DINOS` in both independent sessions |

### The defect that explains the zero

**The most prominent button on the site sends every visitor alone into their own
private room.** "Start drawing" / "Draw now" (`button.primary-action.home-draw-now`)
mints a new random code per page load, so two people who click it one second
apart can never meet. The one shared-canvas element on the homepage, "Join this
canvas →", opens a read-only viewer preview (`button.home-viewer`) rather than
joining — so the **only** routes into a shared room are `/rooms` or a room link
you publish yourself. Meanwhile the 20 themed rooms *are* stable, shared and
guessable:

| Room | Code | Room | Code |
| --- | --- | --- | --- |
| Open Studio (the shared public canvas) | `/join/MAIN` | Graffiti Wall | `/join/GRAFFITI` |
| Doodle Jam | `/join/DOODLE` | Animation Studio | `/join/FLIPBOOK` |
| Dino World | `/join/DINOS` | Finger Paints | `/join/FINGERS` |
| Outer Space | `/join/SPACE` | Draw & Guess | `/join/GUESS` |
| Under the Sea | `/join/OCEAN` | Draw Phone | `/join/PHONE` |
| Pet Parade | `/join/PETS` | Today's Challenge | `/join/DAILY` |
| Rainbow Lab | `/join/RAINBOW` | Kaleido Jam | `/join/KALEIDO` |
| Castles & Dragons | `/join/CASTLE` | Canvas Quests | `/join/QUEST` |
| Meme Wall | `/join/MEMEWALL` | Paint Orchestra | `/join/ORCHSTRA` |
| Aesthetic Board | `/join/VIBES` | OC Corner | `/join/OCCORNER` |

So the product already has a working meeting surface; the funnel just bypasses
it. **Pointing the primary CTA at a shared room instead of a fresh random one is
the single highest-leverage change available** — it is small, it is in the front
end, and without it no amount of traffic will ever produce visible activity,
because no two visitors will ever occupy the same canvas.

Two conclusions follow, and they drive everything below.

**a) The product is real; the room is empty.** I verified the core promise with
two separate browser sessions, so this is not a "does it work" problem. But the
20-room browse surface currently says "Be the first!" twenty times. A visitor
who arrives alone, in an empty room, experiences a blank canvas — the single
feature that separates Drawesome from any other drawing site delivers nothing.
They conclude the site is dead and leave. That is why activity never compounds.

**b) Revenue is zero because checkout is off, not because people refuse to pay.**
`configured:false` means the $4.99/$39 Family plan cannot be purchased at all
right now. Do not read the empty till as disinterest.

**The consequence for a social push:** sending traffic to drawesome.art *today*
burns your best channel on a bad first impression. Reddit gives you one shot at
a subreddit. So the push has to arrive **together, at a time**, into **one room**
— not one visitor at a time into twenty separate empty rooms.

---

## 2. Where this product actually spreads (evidence, not guesswork)

I searched for how the free collaborative-canvas category has historically been
shared on Reddit. `aggie.io` was the previous free standard in this exact niche
(Magma absorbed it; **aggie.io now redirects to magma.com**).

Every organic aggie.io post I found was **the same shape: two friends made
something silly together, and posted the result into a fandom subreddit.**

- r/HollowKnight — "Fanart … drawn during a very fun Aggie.io session with some friends"
- r/fivenightsatfreddys — "Drew a Baby the other day on Aggie.io"
- r/wholesomejojo, r/outerwilds, r/Terraria, r/kurzgesagt, r/Sanatolia, r/touhou
- r/AnimalJam — "all the drawing jammers out there can join a drawing server on Aggie.io" (Oct 2025)
- r/OscWhiteboards — a whole sub for the Object Show Community built on WhiteboardFox / Conceptboard / Aggie.io

That is a **strategy**, and it is not "target artists." Artists already have
Procreate. The people who spread this category are **fandom communities**:
OC art, character sheets, "draw my OC", art jams. Magma's own homepage confirms
it — its live-room list reads "Help me fix my Danganronpa OC", "draw my oc",
"OC Shipping & interact central!".

There is also a **direct, standing ask** this product answers, found verbatim:
- r/learntodraw: *"Is there any app that allows multiple people to draw on the same canvas together? I'm surprised more apps don't have this"*
- A fandom post titled: *"THEY BLOCKED MAGMA SO I HAVE TO FIND ANOTHER DRAWING APP TO USE BRUH I DON'T WANT TO USE CANVA"*

The second one is the opening. School and network filters block magma.com.
Drawesome is free, needs no account, and needs no install — which is exactly the
combination a blocked-out kid can still reach.

### The demand is being voiced constantly, in your own words

You do not have to convince anyone this category should exist. People ask for it
repeatedly, and the tools keep dying underneath them:

- r/learnart — *"Many years ago I used a site called **iscribble**, it allowed for collaborative art drawings with strangers in real time. Are there any apps or sites like this?"*
- r/learntodraw — *"Is there any app that allows multiple people to draw on the same canvas together? I'm surprised more apps don't have this, especially Clip Studio and Procreate."*
- r/learnart — *"Why is it so hard to find local artists to collaborate with?"*
- r/homeschool — *"Any good free online 'Drawing' classes? I have a 10yo who draws constantly."*

Note the pattern: **aggie.io died. iscribble died. The request never does.** That
is the most useful positioning fact you have — not "another drawing app," but
*the shared canvas that is still running*.

### r/DigitalArt is already asking for exactly this, in the wrong shape

That sub carries a constant stream of collab posts — *"LOOKING TO DO AN ART COLLAB"*,
*"Anybody wanna collab?!"*, *"Does anyone want to do a collab art project where we
all work together to make one masterpiece"* — and they all resolve the same
clumsy way: **each person draws separately and posts "my part / their part."**

That is your single best pitch, because it is not a pitch. It is an obvious
improvement on something they are already trying to do:

> You don't have to trade files back and forth — you can both be on the same
> canvas at the same time and watch it come together.

Answer those posts. Don't lead with the site; lead with the fact that
simultaneous is possible at all.

---

## 3. The plan: an art jam, not a link drop

### Step 1 — Seed the room with people you already have (this week)

Do not lead with strangers. Get 3-6 humans into **one room at one time**. Two
people drawing together is enough to make every screenshot and every clip real.

Use the surface that already exists. Every themed room has a **stable, guessable
code**, so a room link you publish keeps working and keeps collecting people:

- **`/join/DINOS`** ("Dino World") or **`/join/MAIN`** ("Open Studio", the shared
  public canvas) are the best jam venues — they're stable, they're advertised on
  `/rooms`, and the names are self-explanatory.

**Publish the room URL, never the bare domain.** `drawesome.art` sends a visitor
to the random-room CTA (see §1), which would scatter your entire audience into
separate empty rooms. `drawesome.art/join/DINOS` puts every single one of them
on the same canvas.

Repeat the same room every time. The whole point is that people learn one
address and start running into each other there.

There is a second reason to keep one fixed slot: the empty-room problem is not
unique to you. r/alphaandbetausers currently carries several near-identical
projects, including a collaborative pixel canvas whose author wrote *"right now
it is mostly me."* Every new shared canvas dies the same way. A fixed time is
the only thing that has ever fixed it.

Cadence to try: a fixed 20-minute slot, twice a week, announced once. Pick the
time from the audience you're aiming at, not your own convenience.

### Step 2 — Make the demo before you make the post

You can produce the content natively — I confirmed these buttons exist in the
studio: **🎬 Timelapse**, **🖼 GIF**, **🧲 Wall**, **📤 Share**, plus *Draw &
Guess* and *Draw Phone* room modes.

A 15-25 second clip of **two cursors contributing to one finished drawing**
beats any feature list, and it is the format that performs on TikTok / Reels /
X. The repo's own launch plan says the same thing, and it's right.

### Step 3 — Post the *output* first, the *site* second

The proven unit is "my friend and I made this." So the sequence is:

1. Post the finished collaborative drawing into a **fandom or group-doodle
   subreddit** as art, with the tool mentioned in a comment — not as a pitch.
2. Only then, once you have something worth showing, post the *tool* to the
   maker/website subs.

---

## 4. Venues, ranked, with the rule that will bite you

I read the actual rules where they were retrievable. Rule text is quoted from
the subreddit's own wiki.

### Tier 1 — best fit

| Venue | Why it fits | The rule to respect |
| --- | --- | --- |
| **r/groupdoodles** | Exists *specifically* for "art that has been made cooperatively". Its own description advertises aggie.io and drawpile. Your output is literally the content. | Community is small; post art, not a pitch. |
| **r/InternetIsBeautiful** (~17M) | In scope: single-purpose web tool, top-level domain, **no login, no download, free core**. Two collaborative-drawing sites have been posted here before ("A universe which we draw together"). | See the three warnings below. |
| **Fandom subs** (your own OC/fandom) | Where this category actually spread, per §2. | Post the art. Tool in a comment. Never a cold link. |
| **r/learntodraw, r/ArtEd, r/homeschool** | Standing demand ("is there an app where we draw on the same canvas") and the parent/teacher angle. | Answer the question; disclose you're the maker; link only if asked. |

### r/InternetIsBeautiful — read this before you post

**Look at what the sub actually accepts.** Its current front page is all highly
specific single-purpose tools: a defrag simulator, a 56k dial-up simulator, a
pet-toxic-plant database, a ShadeMap, "draw any shape and hear it as a drum."
There is no generic "drawing app" on it. It also currently carries a
**"[SUB NEWS] Generic and Repetitive Site Submissions"** notice, so curation is
tightening, not loosening.

**Practical consequence:** message the mods *before* posting and ask whether a
shared-canvas tool is welcome. It costs one message and it is the difference
between a post and a removal.

Quoted from the wiki:

- **"Not unique"**: *"a site is considered not unique if too many similar services can be easily found or are known to the mod reviewing submissions."* Magma, Drawpile, Kleki and WhiteboardFox all exist. This is the rule most likely to kill the post — so **lead with what is genuinely different**: a shared room + 6,000+ coloring sheets + kid-safe rooms, no account, no install. Do not lead with "online drawing app."
- **90/10**: *"If more than 10% of your account is used for self-promotion, you will be banned."* This is about your **account history**, not this post. If the account you use is new or all-promo, it will be removed and you may be banned. Check your own history first.
- **No web games** — post those to r/webgames. Draw & Guess / Draw Phone are game modes; mention them second, if at all.
- **No paywalled features and no required signup.** Your core is free and anonymous, so you pass — but do not say "free demo," which is disqualifying language.
- Posts perform in **weekday mornings US Eastern**, and comments decide the outcome. Be free for two hours after posting.

### Tier 2 — explicitly promotion-tolerant, and where your peers already are

**r/alphaandbetausers** is the best fit for the feedback you asked for, and it
is already full of your exact category. Live examples found today:

- *"I built an infinite canvas where you can draw together in real time. Looking for someone who can draw…"*
- *"I built a social platform where artists can continue each other's drawings"* (Sketch.Social)
- *"Looking for people to test the no-signup drawing flow on my shared pixel mural"*
- *"[Web, Beta] OUR PLACE — a shared 1000x1000 pixel canvas I turned on this morning. Come draw on it… because right now it is mostly me."*

Two things follow. First, this venue will accept your post and answer it honestly.
Second, **the empty-canvas problem is the universal failure mode of this product
category**, not a Drawesome defect — which means the fix is the known one
(a fixed time and place) rather than something you have to invent.

Also: r/SideProject, r/UsefulWebsites, r/InteractiveWebsites, r/IMadeThis,
r/Shamelessplug, r/somethingimade. Good for feedback rather than reach. Ask a
real question — *"could you get two people drawing without me explaining it?"*
— and you will get useful answers.

### r/characterdrawing — participate, don't pitch

This sub runs on `[LFA]` ("looking for artist") posts: people describing an
original character and hoping someone will draw them. Many go unfilled. It is
the clearest demand signal for a shared canvas that exists on Reddit — people
want their OC drawn, and artists want practice.

The legitimate move is to **become a participant**: pick an `[LFA]` post, draw it
on Drawesome, and post the result as a filled request — mentioning the tool only
in passing. You earn the right to talk about your site by having used it to give
someone art they asked for. Do not post a link there cold; that community's whole
point is free art, and a pitch will be removed on sight.

### Tier 3 — your own accounts (IG, X, TikTok)

This is where your "share their drawings" goal lives, and it needs a **logged-in
browser**. I checked: TikTok search renders nothing logged out, X forces a login
redirect, and Bluesky search says "Search is currently unavailable when logged
out." Instagram blocks keyword search entirely without a session.

So: I cannot read or post there until we set that up (§6).

### What NOT to do

- **No cold DMs or mass comments.** "Check out my site" DMs are spam, they get
  your account action-blocked, and on TikTok a comment containing a domain was
  accepted in-session then silently vanished on reload. On a personal account,
  bulk IG actions are the top trigger for an action-block. This is the single
  most likely way to lose the accounts you need.
- **No buying traffic, votes, followers or reviews** — Reddit's User Agreement
  covers vote manipulation, and it is permanent-ban territory.
- **Don't post the same link to many subs at once.** That is the pattern
  Reddit's spam filters are built to catch.

---

## 5. Feedback, and the "keep coming back" loop

You asked for three things: activity, opinions, and people sharing their art.

- **Opinions:** ask a *specific* question and you'll get real answers. "Could you
  get a second person drawing without me explaining it? What broke?" beats
  "feedback welcome." Put it in r/SideProject and r/alphaandbetausers.
- **Sharing:** the Wall + the 📤 Share / 🎬 Timelapse buttons already exist, so
  the ask is small — but nobody shares art into an empty gallery. **Seed the
  Wall yourself first** (it currently holds 2 placeholder posts). A wall with 15
  real drawings makes sharing feel normal; a wall with 2 makes it feel pointless.
- **Returning:** the honest reason to come back is *someone being there.* That is
  what the fixed jam slot is for. A daily prompt alone doesn't create that.

---

## 6. What I need from you to go further

The single blocker for everything social-platform is a **logged-in browser**.
Right now the browser I can drive is a headless Chrome with an empty profile, so
every platform walls it.

To unlock IG / X / TikTok reading *and* posting, launch a dedicated automation
Chrome and log in by hand once (the profile persists for future runs):

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --remote-debugging-port=9333 \
  --user-data-dir="C:/Users/Craig Campbell/.config/browser-harness/chrome-personal" \
  --no-first-run --no-default-browser-check https://www.instagram.com/
```

Then I can, in your browser, harvest what's actually being said around digital
drawing/painting, find the threads worth answering, and draft or post to your
approval. I will not type credentials or touch 2FA — you log in, I work the page.

Also useful, and I'll assume the obvious answer unless you say otherwise:
- **Which accounts?** A `drawesome.art` brand account is better than your
  personal one for IG/TikTok — the content is the product, not you. Your
  personal Reddit account is *fine* for posting as long as its history passes
  the 90/10 rule.
- **Who is the jam for?** The two audiences pull in different directions:
  *fandom teens* (where this category spreads) vs *parents/teachers* (where the
  money and the safety story are). Pick one for the first push — I'd pick
  fandom for activity, because that's what the aggie.io evidence shows works.

---

## 7. Monetization, briefly (you asked me to look)

- The Family plan is **unpurchasable** (`configured:false`). Wiring `MONETIZATION.md`
  steps 1-11 is a prerequisite for *any* revenue experiment, but it is not what's
  blocking growth, and a subscription is the wrong first ask when the rooms are
  empty.
- The stronger commercial fit is the **adult buyer with a budget**: the parent/
  teacher/club path (the repo's `docs/LAUNCH_PLAN.md` models ~$99/year per
  teacher, one-time institutional rather than monthly consumer). Your assets for
  that audience are real and already built — the 6,000+ coloring library,
  kid-safe rooms, no-student-accounts rooms.
- Keep ads off for now. There is no traffic baseline to monetize, and ad
  approval for a child-directed site is work with no payoff at zero users.

Sequence: **concurrency → retention → then money.**
