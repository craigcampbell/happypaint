import { useMemo, useState } from "react";
import { discoverTags, discoverableRooms, publicGalleryPieces, roomPolicyFor } from "../utils/social";
import EventsPanel from "./EventsPanel";
import BrushPackBrowse from "./BrushPackBrowse";

function matchesSearch(item, query, activeTags) {
  const haystack = [
    item.title,
    item.topic,
    item.theme,
    item.roomTitle,
    item.event,
    item.code,
    ...(item.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const matchesQuery = !query.trim() || haystack.includes(query.trim().toLowerCase());
  const matchesTags = activeTags.length === 0 || activeTags.every((tag) => item.tags?.includes(tag));

  return matchesQuery && matchesTags;
}

function GalleryArt({ palette }) {
  const colors = palette || ["#0f172a", "#0ea5e9", "#f97316"];

  return (
    <div className="gallery-art" aria-hidden="true">
      <i style={{ background: colors[0] }} />
      <i style={{ background: colors[1] }} />
      <i style={{ background: colors[2] }} />
    </div>
  );
}

export default function DiscoveryHub({ query, onQueryChange, onNavigate, onGetPack }) {
  const [activeTags, setActiveTags] = useState([]);
  const [notice, setNotice] = useState("Browse is open. Joining stays invite-only or host-approved.");
  const [voteCounts, setVoteCounts] = useState(() =>
    Object.fromEntries(publicGalleryPieces.map((piece) => [piece.id, piece.votes]))
  );
  const [votedIds, setVotedIds] = useState([]);

  const filteredRooms = useMemo(
    () => discoverableRooms.filter((room) => matchesSearch(room, query, activeTags)),
    [activeTags, query]
  );
  const filteredGallery = useMemo(
    () => publicGalleryPieces.filter((piece) => matchesSearch(piece, query, activeTags)),
    [activeTags, query]
  );

  const toggleTag = (tag) => {
    setActiveTags((current) => (current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]));
  };

  const voteFor = (piece) => {
    if (votedIds.includes(piece.id)) {
      setNotice(`${piece.title} already has your vote in this demo.`);
      return;
    }

    setVotedIds((current) => [...current, piece.id]);
    setVoteCounts((current) => ({ ...current, [piece.id]: current[piece.id] + 1 }));
    setNotice(`Vote added for ${piece.title}.`);
  };

  return (
    <section className="discovery-hub" id="discover" aria-label="Browse rooms, events, and gallery posts">
      <div className="discovery-header">
        <div>
          <p className="eyebrow">Discover without pressure</p>
          <h2>Search topics, preview rooms, and vote on group art.</h2>
        </div>
        <label className="discovery-search" htmlFor="discovery-search">
          <span>Search rooms, topics, tags, or events</span>
          <input
            id="discovery-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Try meme remix, anime, coloring..."
          />
        </label>
      </div>

      <div className="discover-tag-row" aria-label="Discovery tags">
        {discoverTags.map((tag) => (
          <button type="button" key={tag} className={activeTags.includes(tag) ? "is-active" : ""} onClick={() => toggleTag(tag)}>
            {tag}
          </button>
        ))}
      </div>

      <p className="discovery-notice">{notice}</p>

      <div className="discovery-layout">
        <section className="discovery-panel room-browser" aria-label="Browse rooms">
          <div className="panel-title-row">
            <h3>Rooms</h3>
            <span>{filteredRooms.length} listed</span>
          </div>
          {filteredRooms.map((room) => {
            const policy = roomPolicyFor(room.audience);

            return (
              <article key={room.id} className="discovery-room-card">
                <div className="room-card-art" style={{ "--room-accent": room.accent }} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="room-card-copy">
                  <div className="room-card-topline">
                    <span>{room.status}</span>
                    <small>{policy.title}</small>
                  </div>
                  <h4>{room.title}</h4>
                  <p>{room.topic}</p>
                  <div className="mini-tag-row">
                    {room.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <div className="role-meter" aria-label={`${room.artists.active} artists and ${room.viewers.active} viewers`}>
                    <span>
                      Artists {room.artists.active}/{room.artists.max}
                    </span>
                    <span>
                      Viewers {room.viewers.active}/{room.viewers.max}
                    </span>
                  </div>
                  <p className="room-role-note">{room.rolePolicy}</p>
                  <div className="discovery-actions">
                    <button type="button" className="primary-action" onClick={() => setNotice(`${room.title} preview opened.`)}>
                      Preview Room
                    </button>
                    <button type="button" onClick={() => setNotice(`${room.title} needs an invite or host approval to join.`)}>
                      Request Role
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>

        <section className="discovery-panel events-panel" aria-label="Timed events">
          <EventsPanel onNavigate={onNavigate} />
        </section>

        <section className="discovery-panel gallery-vote-panel" aria-label="Community gallery voting">
          <div className="panel-title-row">
            <h3>Gallery Vote</h3>
            <span>{filteredGallery.length} posts</span>
          </div>
          <div className="gallery-vote-grid">
            {filteredGallery.map((piece) => (
              <article key={piece.id}>
                <GalleryArt palette={piece.palette} />
                <div>
                  <h4>{piece.title}</h4>
                  <p>
                    {piece.roomTitle} · {piece.contributors} artists
                  </p>
                  <small>{piece.event}</small>
                </div>
                <button type="button" onClick={() => voteFor(piece)} disabled={votedIds.includes(piece.id)}>
                  {voteCounts[piece.id].toLocaleString()} votes
                </button>
              </article>
            ))}
          </div>
        </section>
      </div>

      <BrushPackBrowse query={query} onGet={onGetPack} />
    </section>
  );
}
