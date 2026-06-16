// Wallet panel (docs/paint-economy.md §Product Surfaces > Wallet).
// Shows Drops + Kudos + locked creator balances, recent ledger activity
// (earned/spent), and guardian-control copy for child/teen accounts. Pure UI:
// it reads the economy state and dispatches "open store" back to StudioApp.

import { CURRENCY, describeLedgerSource, dropsToApproxMoney, isMinorAccount } from "../utils/economy";

function currencyLabel(type) {
  if (type === CURRENCY.kudos) return "Kudos";
  if (type === CURRENCY.creator) return "Creator";
  return "Drops";
}

function ActivityRow({ entry }) {
  const credit = entry.direction === "credit";
  return (
    <li className="wallet-activity-row">
      <div>
        <span className="wallet-activity-label">{describeLedgerSource(entry)}</span>
        <small>{new Date(entry.created_at).toLocaleString()}</small>
      </div>
      <span className={`wallet-amount ${credit ? "is-credit" : "is-debit"}`}>
        {credit ? "+" : "−"}
        {entry.amount} {currencyLabel(entry.currency_type)}
      </span>
    </li>
  );
}

export default function WalletPanel({ economy, onClose, onOpenStore }) {
  const wallet = economy.wallet;
  const recent = economy.ledger.slice(0, 12);
  const minor = isMinorAccount(economy);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal wallet-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="wallet-title">Wallet</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="wallet-balances">
          <div className="wallet-balance is-drops">
            <span className="wallet-balance-label">Drops</span>
            <strong>{wallet.drops_balance}</strong>
            <small>≈ {dropsToApproxMoney(wallet.drops_balance)}</small>
          </div>
          <div className="wallet-balance is-kudos">
            <span className="wallet-balance-label">Kudos</span>
            <strong>{wallet.kudos_balance}</strong>
            <small>Earned reputation</small>
          </div>
          <div className="wallet-balance is-locked">
            <span className="wallet-balance-label">Creator (locked)</span>
            <strong>{wallet.locked_balance}</strong>
            <small>From tips</small>
          </div>
        </div>

        <button type="button" className="primary-action full-width" onClick={onOpenStore}>
          Get Drops &amp; Shop
        </button>

        <div className="wallet-section">
          <h3>Recent activity</h3>
          {recent.length === 0 ? (
            <div className="empty-gallery ps-empty">No wallet activity yet.</div>
          ) : (
            <ul className="wallet-activity">
              {recent.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </div>

        {minor ? (
          <p className="economy-note">
            Guardian controls apply to this account. Spending is guardian-controllable and a guardian can view full
            purchase history. Drops are bought through your app store and never expire.
          </p>
        ) : (
          <p className="economy-note">Purchased Drops never expire. Kudos are earned reputation and can&apos;t be cashed out.</p>
        )}
      </section>
    </div>
  );
}
