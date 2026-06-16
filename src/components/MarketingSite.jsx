import { useCallback, useState } from "react";
import DiscoveryHub from "./DiscoveryHub";
import { kidSafetyPrinciples, revenueModels } from "../utils/social";
import { addAsset, loadPaintSpace, savePaintSpace } from "../utils/paintSpace";
import { getPackAssets } from "../utils/brushPacks";

export default function MarketingSite({ onNavigate }) {
  const [discoveryQuery, setDiscoveryQuery] = useState("");

  // "Get" a browsed community pack: copy its brushes into the shared Paint Space
  // locker (same localStorage/IndexedDB store the studio reads) and record
  // asset_uses. Returns false on a storage failure so browse can report honestly.
  const handleGetPack = useCallback(async (pack) => {
    try {
      const newAssets = getPackAssets(pack);
      if (newAssets.length === 0) {
        return true;
      }
      const current = await loadPaintSpace();
      let next = current;
      for (const asset of newAssets) {
        next = addAsset(next, asset);
      }
      await savePaintSpace(next);
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <main className="marketing-site">
      <section className="marketing-hero">
        <div className="marketing-nav">
          <strong>Happy Paint</strong>
          <nav aria-label="Marketing navigation">
            <button type="button" onClick={() => onNavigate("/studio")}>
              Browser Studio
            </button>
            <a href="#discover">Discover</a>
            <a href="#together">Paint Together</a>
            <a href="#pricing">Pricing</a>
          </nav>
        </div>

        <div className="hero-copy">
          <p className="eyebrow">Drawing, coloring, and shared art time</p>
          <h1>Happy Paint</h1>
          <p>
            A fast, kid-conscious studio for solo art, planned paint sessions, and invite-only creative rooms.
          </p>
          <div className="hero-actions">
            <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>
              Paint in Browser
            </button>
            <a className="button-link" href="#discover">
              Browse Rooms
            </a>
            <button type="button" onClick={() => onNavigate("/join")}>
              Join With Code
            </button>
          </div>
          <label className="hero-search" htmlFor="hero-discovery-search">
            <span>Preview rooms before joining</span>
            <input
              id="hero-discovery-search"
              type="search"
              value={discoveryQuery}
              onChange={(event) => setDiscoveryQuery(event.target.value)}
              placeholder="Search memes, anime, coloring..."
            />
          </label>
          <div className="store-row" aria-label="Future app store links">
            <span>iPhone and iPad</span>
            <span>Android</span>
            <span>Web</span>
          </div>
        </div>

        <div className="hero-preview" aria-label="Happy Paint app preview">
          <div className="preview-toolbar">
            <span />
            <span />
            <span />
          </div>
          <div className="preview-canvas">
            <i className="stroke stroke-one" />
            <i className="stroke stroke-two" />
            <i className="stroke stroke-three" />
          </div>
          <div className="preview-rail">
            <b>Marker</b>
            <b>Paint</b>
            <b>Glow</b>
          </div>
        </div>
      </section>

      <DiscoveryHub
        query={discoveryQuery}
        onQueryChange={setDiscoveryQuery}
        onNavigate={onNavigate}
        onGetPack={handleGetPack}
      />

      <section className="marketing-band" id="together">
        <div>
          <p className="eyebrow">Room discovery, not people search</p>
          <h2>Browse what is happening, then join through codes or host approval.</h2>
        </div>
        <div className="feature-grid">
          <article>
            <h3>Room Codes</h3>
            <p>Short codes work for siblings, classmates, and quick calls without sharing personal details.</p>
          </article>
          <article>
            <h3>Preview First</h3>
            <p>Discovery shows approved room snapshots, topics, tags, and events without exposing live child presence.</p>
          </article>
          <article>
            <h3>Artist or Viewer</h3>
            <p>Hosts choose who can draw and who can watch, vote, and react before the room opens.</p>
          </article>
        </div>
      </section>

      <section className="marketing-band safety-band">
        <div>
          <p className="eyebrow">Built carefully for kids</p>
          <h2>Social features should add delight, not risk.</h2>
        </div>
        <ul className="safety-list">
          {kidSafetyPrinciples.map((principle) => (
            <li key={principle}>{principle}</li>
          ))}
        </ul>
      </section>

      <section className="marketing-band" id="pricing">
        <div>
          <p className="eyebrow">Monetization</p>
          <h2>Make money from creative value, not pressure.</h2>
        </div>
        <div className="pricing-grid">
          {revenueModels.map((model) => (
            <article key={model.id} className="pricing-card">
              <h3>{model.title}</h3>
              <strong>{model.price}</strong>
              <p>{model.detail}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
