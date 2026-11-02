/** Bound validator work before Zod can allocate one issue for every invalid collection element. */
export function withinJsonBudget(value: unknown): boolean {
  const pending: [unknown, number][] = [[value, 0]];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (++nodes > 100_000 || depth > 64) return false;
    if (!item || typeof item !== "object") continue;
    if (seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 10_000 || pending.length + nodes + item.length > 100_000) return false;
      for (const child of item) pending.push([child, depth + 1]);
    } else {
      const keys = Object.keys(item);
      if (keys.length > 10_000 || pending.length + nodes + keys.length > 100_000) return false;
      for (const key of keys) pending.push([(item as Record<string, unknown>)[key], depth + 1]);
    }
  }
  return true;
}
