export function wrapCategoryIndex(currentIndex, direction, categoryCount) {
  if (!Number.isSafeInteger(categoryCount) || categoryCount <= 0) return -1;

  const requested = Number.isSafeInteger(currentIndex) ? currentIndex : 0;
  const current = ((requested % categoryCount) + categoryCount) % categoryCount;
  const delta = direction === "prev" || direction === -1 ? -1 : 1;
  return (current + delta + categoryCount) % categoryCount;
}
