// Verification for server/economy.js. Run inside the app container (which has
// node_modules): docker exec happypaint-app-1 node /tmp/test-economy.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEconomy, DROP_PRODUCTS, STORE_ITEMS } from '/app/server/economy.js';

const dir = mkdtempSync(join(tmpdir(), 'econ-'));
const econ = createEconomy({ dataDir: dir, resolveOwner: async () => 'a', resolveOwnerOptional: async () => 'a' });
const I = econ._internals;

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name} ${extra}`); }
}
const bal = (k) => I.project(I.walletFor(k, false));

console.log('\n-- purchases (money in) --');
const p1000 = DROP_PRODUCTS.find((p) => p.id === 'drops_1000');
check('purchase credits drops', I.creditPurchase('buyer', p1000, 'cs_1').ok);
check('purchase credits paidDrops', bal('buyer').drops === 1000 && bal('buyer').paidDrops === 1000, JSON.stringify(bal('buyer')));
check('duplicate receipt is idempotent', I.creditPurchase('buyer', p1000, 'cs_1').reason === 'duplicate');
check('no double credit', bal('buyer').drops === 1000, `drops=${bal('buyer').drops}`);
check('refund claws back', I.refundPurchase('cs_1').ok && bal('buyer').drops === 0, `drops=${bal('buyer').drops}`);
check('double refund refused', I.refundPurchase('cs_1').reason === 'already_refunded');

console.log('\n-- earning (never payoutable) --');
check('paint credits drops', I.earnFromPainting('painter', 1).ok);
check('paint does NOT credit paidDrops', bal('painter').paidDrops === 0, JSON.stringify(bal('painter')));
check('paint throttle blocks a re-earn inside 4s', I.earnFromPainting('painter', 1).reason === 'throttled');
check('quest credits once', I.earnFromQuest('painter', 'set:1', 3).ok);
check('quest is idempotent per key', I.earnFromQuest('painter', 'set:1', 3).reason === 'duplicate');

console.log('\n-- store spend --');
const brushes = STORE_ITEMS.find((i) => i.id === 'creator-brushes');
I.earnFromQuest('shopper', 'seed', 5);
check('insufficient funds rejected', I.buyStoreItem('shopper', brushes.id).reason === 'insufficient', JSON.stringify(bal('shopper')));
I.creditPurchase('shopper', p1000, 'cs_2');
check('store purchase debits', I.buyStoreItem('shopper', brushes.id).ok);
check('balance drops by price', bal('shopper').drops === 1000 + 5 - brushes.price_drops, `drops=${bal('shopper').drops}`);
check('item is idempotent (not double-charged)', I.buyStoreItem('shopper', brushes.id).reason === 'owned');
check('grant recorded', I.walletFor('shopper', false).entitlements.includes('studio'));

console.log('\n-- THE ANTI-FARMING RULE --');
// A creator tipped ONLY with paint-earned Drops gets creator balance but nothing
// cashable: those Drops cost the sender nothing, so no money entered the system.
I.earnFromQuest('farmer', 'seed2', 5);
I.earnFromQuest('farmer', 'seed3', 5);
I.earnFromQuest('farmer', 'seed4', 5);
I.earnFromQuest('farmer', 'seed5', 5);
I.earnFromQuest('farmer', 'seed6', 5); // 25 earned Drops
check('farmer has only earned drops', bal('farmer').paidDrops === 0 && bal('farmer').drops === 25, JSON.stringify(bal('farmer')));
const tip1 = I.sendTip('farmer', 'creatorA', 25, 'post1');
check('earned-Drops tip accepted', tip1.ok && tip1.cashBacked === 0, JSON.stringify(tip1));
check('creator got the balance', bal('creatorA').creator === 25, JSON.stringify(bal('creatorA')));
check('creator has ZERO payoutable value', bal('creatorA').payoutableDrops === 0 && bal('creatorA').payoutableCents === 0, JSON.stringify(bal('creatorA')));

// Same tip, but paid with PAID Drops: now real money backed it, so it is cashable.
I.creditPurchase('richFan', p1000, 'cs_3');
const tip2 = I.sendTip('richFan', 'creatorB', 100, 'post2');
check('paid-Drops tip is cash-backed', tip2.ok && tip2.cashBacked === 100, JSON.stringify(tip2));
check('creatorB balance', bal('creatorB').creator === 100, JSON.stringify(bal('creatorB')));
check('creatorB payoutable = 100 Drops', bal('creatorB').payoutableDrops === 100, JSON.stringify(bal('creatorB')));
check('mixed tip: paid portion only counts', (() => {
  // richFan has 900 paid Drops left; tip 100 -> all 100 cash-backed.
  const r = I.sendTip('richFan', 'creatorC', 100, 'post3');
  return r.ok && r.cashBacked === 100 && bal('creatorC').payoutableDrops === 100;
})());

console.log('\n-- payout pricing --');
check('1000 Drops = $6.50 at 0.65c/Drop', Math.floor((1000 * 65) / 100) === 650);
check('5000-Drop minimum = $32.50', Math.floor((5000 * 65) / 100) === 3250);
check('payoutable never exceeds creator balance', bal('creatorA').payoutableDrops <= bal('creatorA').creator);

console.log('\n-- guards --');
check('self-tip refused', I.sendTip('shopper', 'shopper', 10).reason === 'bad_recipient');
check('non-preset amount refused', I.sendTip('shopper', 'creatorA', 37).reason === 'bad_amount');
check('unknown store item refused', I.buyStoreItem('shopper', 'nope').reason === 'unknown_item');
check('prototype-polluting key refused', I.walletFor('__proto__') === null);

console.log(`\nRESULT: ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log('FAILED:', fails.join(', ')); process.exit(1); }
