// The Fridge Wall — the community gallery. A Pinterest-style masonry of
// drawings kids pinned from the studio: hearts (one per person), tag chips +
// search, three sorts (daily "fresh mix" shuffle / most loved / newest), and
// animated posts that actually move (the card cycles the post's frame PNGs
// while it's on screen). CTA cards are mixed into the masonry so an empty or
// sparse wall invites you to add your own art instead of looking dead.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import { getSession } from "../utils/auth";

// Same device key the studio uses for saves — hearts stick per device, and
// sign-in upgrades them to the account key server-side via the bearer token.
function deviceKey() {
  try {
    let key = window.localStorage.getItem("drawesome:userkey:v1");
    if (!key) {
      key = "u_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      window.localStorage.setItem("drawesome:userkey:v1", key);
    }
    return key;
  } catch {
    return "";
  }
}

const CTA_MESSAGES = [
  { emoji: "🧲", line: "This wall is missing YOUR artwork!", action: "Draw now" },
  { emoji: "🎨", line: "Add your own masterpiece to the wall!", action: "Start painting" },
  { emoji: "✨", line: "Your art belongs up here too.", action: "Make something" },
];

// One animated card. Frames are served as immutable URLs; we preload them all
// once, then cycle with an interval only while the card is on screen (the
// IntersectionObserver keeps a wall of GIF-like posts from burning battery).
function WallCard({ post, onVote, onReport, onRemix, onShare }) {
  const [frame, setFrame] = useState(0);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || post.frames <= 1) return undefined;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.2 });
    io.observe(node);
    return () => io.disconnect();
  }, [post.frames]);

  useEffect(() => {
    if (!visible || post.frames <= 1) return undefined;
    const id = window.setInterval(
      () => setFrame((f) => (f + 1) % post.frames),
      Math.max(120, post.durationMs || 400),
    );
    return () => window.clearInterval(id);
  }, [visible, post.frames, post.durationMs]);

  // Preload every frame once so cycling never flickers through empty images.
  useEffect(() => {
    if (post.frames <= 1) return;
    for (let i = 1; i < post.frames; i += 1) {
      const img = new Image();
      img.src = `/api/wall/${post.id}/frame/${i}`;
    }
  }, [post.id, post.frames]);

  return (
    <figure className="wall-card" ref={rootRef}>
      <div className="wall-art">
        <img
          src={`/api/wall/${post.id}/frame/${frame}`}
          alt={post.title}
          loading="lazy"
          draggable={false}
        />
        {post.frames > 1 ? <span className="wall-anim-badge" title="Animated!">🎬</span> : null}
      </div>
      <figcaption>
        <div className="wall-caption-row">
          <strong className="wall-title">{post.title}</strong>
          <button
            type="button"
            className={`wall-heart${post.liked ? " is-liked" : ""}`}
            onClick={() => onVote(post)}
            aria-pressed={post.liked}
            aria-label={post.liked ? "Remove your heart" : "Love this drawing"}
          >
            {post.liked ? "❤️" : "🤍"} {post.votes > 0 ? post.votes : ""}
          </button>
        </div>
        <div className="wall-meta">
          <span className="wall-artist">by {post.artist}</span>
          <span className="wall-meta-actions">
            <button type="button" className="wall-share" onClick={() => onShare(post)} title="Share this drawing" aria-label="Share this drawing">
              📤
            </button>
            <button type="button" className="wall-report" onClick={() => onReport(post)} title="Report this post" aria-label="Report this post">
              ⚑
            </button>
          </span>
        </div>
        {post.parentPostId ? (
          <p className="wall-remix-line">
            🧬 {post.parent ? `Remixed from “${post.parent.title}”` : "Remixed from an unavailable source"}
          </p>
        ) : null}
        {post.tags.length ? (
          <div className="wall-tags">
            {post.tags.map((t) => (
              <span key={t} className="wall-tag">#{t}</span>
            ))}
          </div>
        ) : null}
        {post.allowRemix ? (
          <button type="button" className="wall-remix-btn" onClick={() => onRemix(post)}>
            Remix this 🧬
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

function CtaCard({ index, onNavigate }) {
  const msg = CTA_MESSAGES[index % CTA_MESSAGES.length];
  return (
    <div className="wall-card wall-cta">
      <span className="wall-cta-emoji" aria-hidden="true">{msg.emoji}</span>
      <p>{msg.line}</p>
      <button type="button" className="primary-action" onClick={() => onNavigate("/join/MAIN")}>
        {msg.action} 🖌️
      </button>
    </div>
  );
}

export default function WallPage({ onNavigate, initialPostId = "" }) {
  const [posts, setPosts] = useState([]);
  // /wall/:id deep link: the shared post is spotlighted above the feed.
  const [spotlight, setSpotlight] = useState(null);
  const [spotlightMissing, setSpotlightMissing] = useState(false);
  const [topTags, setTopTags] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("");
  const [sort, setSort] = useState("fresh");
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const debounceRef = useRef(null);
  // Monotonic request id — only the newest feed response is allowed to land, so
  // a slow older fetch can't overwrite a newer one (search/tag/sort race).
  const reqSeqRef = useRef(0);

  const say = useCallback((text) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  const load = useCallback(async (q, tag, sortBy) => {
    const seq = (reqSeqRef.current += 1);
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort: sortBy, limit: "60" });
      if (q) params.set("q", q);
      if (tag) params.set("tag", tag);
      const key = deviceKey();
      if (key) params.set("userKey", key);
      const session = await getSession().catch(() => null);
      const headers = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
      const res = await fetch(`/api/wall?${params}`, { headers, cache: "no-store" });
      if (!res.ok) throw new Error("feed failed");
      const data = await res.json();
      if (seq !== reqSeqRef.current) return; // a newer request superseded this one
      setPosts(data.posts || []);
      setTopTags(data.topTags || []);
      setTotal(data.total || 0);
    } catch {
      if (seq === reqSeqRef.current) setPosts([]);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load("", "", "fresh");
    return () => {
      window.clearTimeout(toastTimer.current);
      window.clearTimeout(debounceRef.current);
    };
  }, [load]);

  useEffect(() => {
    if (!initialPostId) return;
    let active = true;
    (async () => {
      try {
        const key = deviceKey();
        const session = await getSession().catch(() => null);
        const headers = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
        const res = await fetch(`/api/wall/${encodeURIComponent(initialPostId)}${key ? `?userKey=${encodeURIComponent(key)}` : ""}`, { headers, cache: "no-store" });
        if (!res.ok) throw new Error("missing");
        const data = await res.json();
        if (active && data.post) setSpotlight(data.post);
      } catch {
        if (active) setSpotlightMissing(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [initialPostId]);

  const share = useCallback(async (post) => {
    const url = `${window.location.origin}/wall/${encodeURIComponent(post.id)}`;
    const payload = {
      title: `“${post.title}” on Drawesome`,
      text: `Look what ${post.artist} drew on Drawesome! 🎨 ${url}`,
      url,
    };
    try {
      if (navigator.share) {
        await navigator.share(payload);
        return;
      }
      throw new Error("no share sheet");
    } catch (err) {
      if (err?.name === "AbortError") return; // user closed the sheet — not an error
      try {
        await navigator.clipboard.writeText(url);
        say("Link copied — send it to a friend! 🔗");
      } catch {
        window.prompt("Copy this link:", url);
      }
    }
  }, [say]);

  // Debounced search; tag + sort reload immediately. All three cancel any
  // pending debounced search first so a stale keystroke can't clobber them.
  const onSearch = (value) => {
    setQuery(value);
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => load(value, activeTag, sort), 300);
  };
  const onTag = (tag) => {
    const next = tag === activeTag ? "" : tag;
    window.clearTimeout(debounceRef.current);
    setActiveTag(next);
    load(query, next, sort);
  };
  const onSort = (s) => {
    window.clearTimeout(debounceRef.current);
    setSort(s);
    load(query, activeTag, s);
  };

  const vote = useCallback(async (post) => {
    const on = !post.liked;
    // Optimistic heart — snap back if the server disagrees. The spotlight card
    // (deep-link view) holds its own copy of the post, so patch it in step.
    const patch = (updater) => {
      setPosts((prev) => prev.map((p) => (p.id === post.id ? updater(p) : p)));
      setSpotlight((s) => (s && s.id === post.id ? updater(s) : s));
    };
    patch((p) => ({ ...p, liked: on, votes: Math.max(0, p.votes + (on ? 1 : -1)) }));
    try {
      const session = await getSession().catch(() => null);
      const headers = { "Content-Type": "application/json" };
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      const res = await fetch(`/api/wall/${post.id}/vote`, {
        method: "POST",
        headers,
        body: JSON.stringify({ on, userKey: deviceKey() }),
      });
      if (!res.ok) throw new Error("vote failed");
      const data = await res.json();
      patch((p) => ({ ...p, votes: data.votes, liked: data.liked }));
    } catch {
      // Reverse the optimistic delta against CURRENT state (a reload may have
      // replaced the list meanwhile) rather than restoring a click-time snapshot.
      patch((p) => ({ ...p, liked: !on, votes: Math.max(0, p.votes + (on ? -1 : 1)) }));
      say("Couldn't save that heart — try again!");
    }
  }, [say]);

  const report = useCallback(async (post) => {
    const ok = window.confirm(`Report "${post.title}" to the moderators?`);
    if (!ok) return;
    try {
      const res = await fetch(`/api/wall/${post.id}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "reported from the wall" }),
      });
      say(res.ok ? "Thanks — a moderator will take a look. 🛡️" : "Couldn't send the report — try again!");
    } catch {
      say("Couldn't send the report — try again!");
    }
  }, [say]);

  const remix = useCallback(async (post) => {
    try {
      const res = await fetch(`/api/wall/${encodeURIComponent(post.id)}/remix-room`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.code) throw new Error("remix failed");
      window.location.href = `/join/${data.code}`;
    } catch {
      say("Couldn't start that remix — try again.");
    }
  }, [say]);

  // Mix CTA cards into the masonry: one up top when the wall is thin, then
  // one roughly every 7 posts.
  const cells = useMemo(() => {
    const out = [];
    let ctaIndex = 0;
    if (posts.length < 4) out.push({ cta: ctaIndex++ });
    posts.forEach((p, i) => {
      out.push({ post: p });
      if ((i + 1) % 7 === 0) out.push({ cta: ctaIndex++ });
    });
    if (posts.length >= 4 && posts.length % 7 !== 0) out.push({ cta: ctaIndex++ });
    return out;
  }, [posts]);

  return (
    <div className="wall-page">
      <SiteNav onNavigate={onNavigate} current="/wall" />
      <main className="wall-main">
        <header className="wall-hero">
          <h1>🧲 The Fridge Wall</h1>
          <p>Art by kids like you — pin yours from the studio with the 🧲 Wall button!</p>
        </header>

        {spotlight ? (
          <section className="wall-spotlight" aria-label="Shared drawing">
            <WallCard post={spotlight} onVote={vote} onReport={report} onRemix={remix} onShare={share} />
            <button
              type="button"
              className="wall-spotlight-close"
              onClick={() => {
                setSpotlight(null);
                onNavigate("/wall");
              }}
            >
              See the whole wall ↓
            </button>
          </section>
        ) : null}
        {spotlightMissing ? (
          <p className="wall-status">That drawing isn&rsquo;t on the wall anymore — but look at everything else! 👇</p>
        ) : null}

        <div className="wall-controls">
          <input
            className="wall-search"
            type="search"
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={`Search ${total.toLocaleString()} drawings…`}
            aria-label="Search the wall"
          />
          <div className="wall-sorts" role="group" aria-label="Sort the wall">
            {[
              ["fresh", "🎲 Fresh mix"],
              ["top", "❤️ Most loved"],
              ["new", "✨ Newest"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={sort === key ? "is-active" : ""}
                onClick={() => onSort(key)}
                aria-pressed={sort === key}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {topTags.length ? (
          <div className="wall-tagrow" aria-label="Popular tags">
            {topTags.map((t) => (
              <button
                key={t}
                type="button"
                className={`wall-tagchip${activeTag === t ? " is-active" : ""}`}
                onClick={() => onTag(t)}
                aria-pressed={activeTag === t}
              >
                #{t}
              </button>
            ))}
          </div>
        ) : null}

        {loading ? (
          <p className="wall-status">Hanging up the artwork…</p>
        ) : (
          <div className="wall-masonry">
            {cells.map((cell, i) =>
              cell.post ? (
                <WallCard key={cell.post.id} post={cell.post} onVote={vote} onReport={report} onRemix={remix} onShare={share} />
              ) : (
                <CtaCard key={`cta-${i}`} index={cell.cta} onNavigate={onNavigate} />
              ),
            )}
          </div>
        )}
        {!loading && posts.length === 0 && (query || activeTag) ? (
          <p className="wall-status">Nothing matches that yet — be the first to draw it! 🎨</p>
        ) : null}
      </main>
      {toast ? <div className="wall-toast" role="status">{toast}</div> : null}
    </div>
  );
}
