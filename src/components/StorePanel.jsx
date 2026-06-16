// Store panel (docs/paint-economy.md §Product Surfaces > Store).
// Two parts:
//   1. "Get Drops" — the drop_products with $ prices and a MOCK buy that credits
//      Drops. Real purchases use App Store / Google Play / web checkout (copy is
//      explicit; no real payment is implemented).
//   2. The store catalog — official packs, room themes, storage/export tokens,
//      and event bundles, each with a Drops price and a Buy that spends Drops.
// No loot boxes / no randomized packs — every item is a transparent bundle.

import {
  DROP_PRODUCTS,
  STORE_CATEGORIES,
  STORE_ITEMS,
  dropsToApproxMoney,
  formatPrice,
  isMinorAccount,
  ownsItem,
} from "../utils/economy";

function DropProductCard({ product, onBuy }) {
  return (
    <article className="pack-card drop-product-card">
      <div>
        <h3>{product.drop_amount} Drops</h3>
        <p>{formatPrice(product.price_cents)}</p>
      </div>
      <button type="button" className="primary-action full-width" onClick={() => onBuy(product)}>
        Get Drops
      </button>
    </article>
  );
}

function StoreItemCard({ item, owned, balance, onBuy }) {
  const affordable = balance >= item.price_drops;
  return (
    <article className="pack-card store-item-card">
      <div>
        <h3>{item.title}</h3>
        <p>
          {item.price_drops} Drops <small className="store-money">≈ {dropsToApproxMoney(item.price_drops)}</small>
        </p>
      </div>
      <p className="store-item-desc">{item.description}</p>
      {owned ? (
        <button type="button" className="full-width" disabled>
          Owned
        </button>
      ) : (
        <button
          type="button"
          className="primary-action full-width"
          onClick={() => onBuy(item)}
          disabled={!affordable}
          title={affordable ? "Spend Drops" : "Not enough Drops"}
        >
          {affordable ? "Buy" : "Not enough Drops"}
        </button>
      )}
    </article>
  );
}

export default function StorePanel({ economy, onClose, onBuyDrops, onBuyItem }) {
  const balance = economy.wallet.drops_balance;
  const minor = isMinorAccount(economy);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal store-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="store-title">Store</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="ps-subtitle">
          You have <strong>{balance} Drops</strong> ≈ {dropsToApproxMoney(balance)}.
        </p>

        <div className="store-section">
          <h3>Get Drops</h3>
          <p className="economy-note">
            Real purchases use the App Store, Google Play, or web checkout. This preview is a mock — no real payment is
            taken. Purchased Drops never expire.
            {minor ? " Spending is guardian-controllable, behind a parental gate." : ""}
          </p>
          <div className="pack-grid">
            {DROP_PRODUCTS.map((product) => (
              <DropProductCard key={product.id} product={product} onBuy={onBuyDrops} />
            ))}
          </div>
        </div>

        {STORE_CATEGORIES.map((category) => {
          const items = STORE_ITEMS.filter((item) => item.category === category.id);
          if (items.length === 0) {
            return null;
          }
          return (
            <div className="store-section" key={category.id}>
              <h3>{category.label}</h3>
              <div className="pack-grid">
                {items.map((item) => (
                  <StoreItemCard
                    key={item.id}
                    item={item}
                    owned={ownsItem(economy, item.id)}
                    balance={balance}
                    onBuy={onBuyItem}
                  />
                ))}
              </div>
            </div>
          );
        })}

        <p className="economy-note">
          No loot boxes and no randomized packs — every bundle lists exactly what it contains. Drops can&apos;t buy
          safety controls, votes, event placement, or access to other people.
        </p>
      </section>
    </div>
  );
}
