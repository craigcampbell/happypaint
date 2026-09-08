// Preserve operation order, including asynchronous images, while yielding on
// elapsed time instead of assuming every brush operation costs the same.
export async function replayInSlices(ops, apply, {
  isCurrent = () => true,
  onSlice = () => {},
  budgetMs = 8,
  now = () => performance.now(),
  yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  let started = now();
  for (let index = 0; index < ops.length; index += 1) {
    if (!isCurrent()) return false;
    const pending = apply(ops[index]);
    if (pending?.then) await pending;
    if (!isCurrent()) return false;
    if (index + 1 < ops.length && now() - started >= budgetMs) {
      onSlice();
      await yieldTask();
      started = now();
    }
  }
  if (!isCurrent()) return false;
  onSlice();
  return true;
}
