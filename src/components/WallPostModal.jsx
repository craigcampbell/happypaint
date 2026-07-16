// "Pin it to the Fridge Wall" — the studio's post dialog. The studio hands us
// already-captured frame dataURLs (1 for a drawing, up to 8 for an animation);
// we preview them (cycling if animated), collect title + up to 5 tags + artist
// name, and POST to /api/wall. The server profanity-gates every text field, so
// a rejected word gets a friendly nudge rather than a silent failure.

import { useEffect, useRef, useState } from "react";
import { getSession } from "../utils/auth";

function deviceKey() {
  try {
    return window.localStorage.getItem("drawesome:userkey:v1") || "";
  } catch {
    return "";
  }
}

export default function WallPostModal({ draft, defaultArtist, onClose, onPosted }) {
  const [title, setTitle] = useState("My drawing");
  const [artist, setArtist] = useState(defaultArtist || "");
  const [tags, setTags] = useState([]);
  const [tagDraft, setTagDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const [frame, setFrame] = useState(0);
  const cycleRef = useRef(null);

  const frames = draft?.frames || [];
  const animated = frames.length > 1;

  useEffect(() => {
    if (!animated) return undefined;
    cycleRef.current = window.setInterval(
      () => setFrame((f) => (f + 1) % frames.length),
      Math.max(120, draft.durationMs || 400),
    );
    return () => window.clearInterval(cycleRef.current);
  }, [animated, frames.length, draft?.durationMs]);

  const addTag = () => {
    const clean = tagDraft.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
    setTagDraft("");
    if (!clean || tags.includes(clean) || tags.length >= 5) return;
    setTags((prev) => [...prev, clean]);
  };

  const post = async () => {
    if (posting) return;
    setPosting(true);
    setError("");
    try {
      const session = await getSession().catch(() => null);
      const headers = { "Content-Type": "application/json" };
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      const res = await fetch("/api/wall", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title,
          tags,
          artist,
          frames,
          durationMs: draft.durationMs,
          userKey: deviceKey(),
        }),
      });
      if (res.ok) {
        onPosted();
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data.error === "language") {
        setError("Some of those words can't go on the wall — try different ones! 💛");
      } else if (res.status === 429) {
        setError("Whoa, speedy! Wait a little before posting again.");
      } else if (data.error === "wall_full") {
        setError("The wall is packed right now — try again tomorrow!");
      } else {
        setError("Couldn't pin that — try again in a moment.");
      }
    } catch {
      setError("Couldn't reach the wall — check your connection and try again.");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal wall-post-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wall-post-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="wall-post-title">🧲 Pin it to the Fridge Wall</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="wall-post-preview">
          <img src={frames[frame]} alt="Your drawing" />
          {animated ? <span className="wall-anim-badge">🎬 animated</span> : null}
        </div>

        <label className="wall-post-field">
          <span>Title</span>
          <input
            type="text"
            maxLength={60}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What did you make?"
          />
        </label>

        <label className="wall-post-field">
          <span>Artist name</span>
          <input
            type="text"
            maxLength={24}
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder="A Drawesome artist"
          />
        </label>

        <div className="wall-post-field">
          <span>Tags (up to 5 — help friends find it!)</span>
          <div className="wall-post-tags">
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                className="wall-tag"
                onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                title="Remove tag"
              >
                #{t} ✕
              </button>
            ))}
            {tags.length < 5 ? (
              <input
                type="text"
                maxLength={24}
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
                placeholder={tags.length ? "another…" : "cat, rainbow, rocket…"}
              />
            ) : null}
          </div>
        </div>

        {error ? <p className="wall-post-error" role="alert">{error}</p> : null}

        <div className="wall-post-actions">
          <span className="wall-post-note">Everyone can see art on the wall. 🌍</span>
          <button type="button" className="primary-action" onClick={post} disabled={posting}>
            {posting ? "Pinning…" : "Pin it! 🧲"}
          </button>
        </div>
      </section>
    </div>
  );
}
