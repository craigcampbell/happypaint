// Publish a Community Brush Pack from the locker.
//
// Lets the user name a pack, pick which of their saved brush (and stamp /
// palette / template) assets go in it, choose visibility (private / friends /
// public — public requires review) and a remix permission, then "Submit for
// review". StudioApp owns persistence: onPublish receives the assembled pack
// request and writes the asset_packs row + asset_moderation_queue entry.

import { useMemo, useState } from "react";
import { PACK_VISIBILITY_OPTIONS, REMIX_PERMISSIONS } from "../utils/brushPacks";

// Asset kinds eligible to be packed (per docs: brushes + stamp/sticker/palette/
// template). loops are excluded for the brush-pack MVP.
const PACKABLE_KINDS = ["brush", "sticker", "palette", "template"];

export default function PublishPackModal({ assets = [], onClose, onPublish }) {
  const packable = useMemo(
    () => assets.filter((asset) => PACKABLE_KINDS.includes(asset.kind)),
    [assets],
  );
  const [title, setTitle] = useState("My Brush Pack");
  const [selectedIds, setSelectedIds] = useState(() => packable.filter((a) => a.kind === "brush").map((a) => a.id));
  const [visibility, setVisibility] = useState("public");
  const [remix, setRemix] = useState("none");

  const toggle = (id) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const selectedAssets = packable.filter((asset) => selectedIds.includes(asset.id));
  const needsReview = visibility === "public" || visibility === "friends";
  const visibilityNote = PACK_VISIBILITY_OPTIONS.find((opt) => opt.id === visibility)?.note || "";

  const submit = () => {
    if (selectedAssets.length === 0) {
      return;
    }
    onPublish?.({
      title: title.trim() || "My Brush Pack",
      assets: selectedAssets,
      visibility,
      remix_permission: remix,
    });
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal publish-pack-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-pack-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="publish-pack-title">Publish a Brush Pack</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="ps-subtitle">
          Group your saved assets into a pack and submit it. Public packs are reviewed before they go live.
        </p>

        {packable.length === 0 ? (
          <div className="empty-gallery ps-empty">
            Save some brushes in Brush Studio first, then come back to publish a pack.
          </div>
        ) : (
          <>
            <label className="color-picker">
              <span>Pack name</span>
              <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>

            <div className="ps-group">
              <h3>Choose assets ({selectedAssets.length} selected)</h3>
              <div className="publish-pack-list">
                {packable.map((asset) => (
                  <label key={asset.id} className="publish-pack-item">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(asset.id)}
                      onChange={() => toggle(asset.id)}
                    />
                    <span className="publish-pack-item-title" title={asset.title}>
                      {asset.title}
                    </span>
                    <span className="publish-pack-item-kind">{asset.kind}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="publish-pack-options">
              <label className="color-picker">
                <span>Visibility</span>
                <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
                  {PACK_VISIBILITY_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="color-picker">
                <span>Remix permission</span>
                <select value={remix} onChange={(event) => setRemix(event.target.value)}>
                  {REMIX_PERMISSIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p className="publish-pack-note">{visibilityNote}</p>
            {needsReview ? (
              <p className="publish-pack-note compliance">
                Community packs require moderation before they appear in browse or featured.
              </p>
            ) : null}

            <div className="brush-studio-save-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-action"
                disabled={selectedAssets.length === 0}
                onClick={submit}
              >
                {needsReview ? "Submit for review" : "Save pack"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
