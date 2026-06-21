// Creator Dashboard (docs/paint-economy.md §Product Surfaces > Creator Dashboard).
// Shows My packs (reuses Paint Space assets if present, else a mock),
// Tips received (into the locked creator balance), Kudos earned, Pending
// moderation, and a Payout status section that stays locked until eligible
// (Phase 1: no cash payouts).

import { dropsToApproxMoney, isMinorAccount } from "../utils/economy";

const MOCK_PACKS = [
  { id: "mock-pack-1", title: "My Neon Doodles", status: "draft", kind: "Sticker pack" },
  { id: "mock-pack-2", title: "Starter Loops", status: "pending", kind: "Loop pack" },
];

function packStatusLabel(status) {
  const map = { draft: "Draft", pending: "In moderation", approved: "Live", rejected: "Needs changes" };
  return map[status] || status;
}

export default function CreatorDashboard({ economy, paintSpaceAssets = [], onClose, onOpenWallet }) {
  const wallet = economy.wallet;
  const tips = economy.tipsReceived || [];
  const tipsTotal = tips.reduce((sum, tip) => sum + tip.amount_drops, 0);
  const minor = isMinorAccount(economy);

  // Prefer the user's real Paint Space assets as "my packs"; fall back to a mock
  // so the surface is never empty.
  const myAssets = paintSpaceAssets.slice(0, 6);
  const pendingPacks = MOCK_PACKS.filter((pack) => pack.status === "pending");

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal creator-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="creator-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="creator-title">Creator Dashboard</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="creator-stats">
          <div className="creator-stat">
            <span>Tips received</span>
            <strong>{tipsTotal} Drops</strong>
            {dropsToApproxMoney(tipsTotal) ? <small>≈ {dropsToApproxMoney(tipsTotal)}</small> : null}
          </div>
          <div className="creator-stat">
            <span>Locked creator balance</span>
            <strong>{wallet.locked_balance} Drops</strong>
            <small>Not withdrawable yet</small>
          </div>
          <div className="creator-stat">
            <span>Kudos earned</span>
            <strong>{wallet.kudos_balance}</strong>
            <small>Reputation</small>
          </div>
        </div>

        <div className="creator-section">
          <h3>My packs</h3>
          {myAssets.length > 0 ? (
            <ul className="creator-list">
              {myAssets.map((asset) => (
                <li key={asset.id} className="creator-list-row">
                  <span>{asset.title}</span>
                  <small>{asset.kind}</small>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="creator-list">
              {MOCK_PACKS.map((pack) => (
                <li key={pack.id} className="creator-list-row">
                  <span>{pack.title}</span>
                  <small>
                    {pack.kind} · {packStatusLabel(pack.status)}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="creator-section">
          <h3>Tips received</h3>
          {tips.length === 0 ? (
            <div className="empty-gallery ps-empty">No tips yet. Share art to earn tips into your locked balance.</div>
          ) : (
            <ul className="creator-list">
              {tips.slice(0, 8).map((tip) => (
                <li key={tip.id} className="creator-list-row">
                  <span>+{tip.amount_drops} Drops</span>
                  <small>
                    {tip.source_type.replace("_", " ")} · {new Date(tip.created_at).toLocaleDateString()}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="creator-section">
          <h3>Pending moderation</h3>
          {pendingPacks.length === 0 ? (
            <div className="empty-gallery ps-empty">Nothing waiting on moderation.</div>
          ) : (
            <ul className="creator-list">
              {pendingPacks.map((pack) => (
                <li key={pack.id} className="creator-list-row">
                  <span>{pack.title}</span>
                  <small>In moderation</small>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="creator-section payout-locked">
          <h3>Payout status</h3>
          <p className="economy-note">
            Payouts not available yet. Tips accumulate into a locked creator balance you can spend inside Happy Paint.
            {minor
              ? " Cash-out for teen creators will require guardian approval, identity checks, and tax info before it opens."
              : " Cash-out opens in a later phase once safety, tax, and payout controls are ready."}
          </p>
          <button type="button" className="full-width" disabled>
            Set up payouts (locked)
          </button>
        </div>

        <button type="button" className="full-width" onClick={onOpenWallet}>
          View wallet
        </button>
      </section>
    </div>
  );
}
