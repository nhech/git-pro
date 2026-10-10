/**
 * Windows rejects a process command line over 32,767 characters (`spawn ENAMETOOLONG`); POSIX limits are far
 * higher but still finite. Path arguments for one Git invocation therefore stay within this many characters,
 * leaving ample room for the executable path and the fixed arguments.
 */
export const ARGV_PATH_BUDGET = process.platform === 'win32' ? 24_000 : 100_000;

/** Splits `paths` into consecutive batches whose combined argument length fits `budget`. Order is preserved. */
export function chunkPaths<T extends string>(paths: readonly T[], budget = ARGV_PATH_BUDGET): T[][] {
  const batches: T[][] = []; let current: T[] = []; let used = 0;
  for (const value of paths) {
    // One separator plus the quotes Windows adds around an argument that contains a space.
    const cost = value.length + 3;
    if (current.length && used + cost > budget) { batches.push(current); current = []; used = 0; }
    current.push(value); used += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}
