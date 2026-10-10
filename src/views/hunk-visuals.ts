/** Display coordinates only; the owned patch remains the mutation authority. */
export function hunkLineLabel(header: string, ordinal: number): string {
  const fallback = `Hunk ${ordinal}`;
  const range = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!range) return fallback;
  const start = Number(range[1]), count = Number(range[2] ?? 1), end = start + Math.max(0, count - 1);
  if (![start, count, end].every(Number.isSafeInteger) || start < 0 || count < 0 || (count > 0 && start === 0)) return fallback;
  if (count === 0) return `${fallback} · ${start === 0 ? 'Start of file' : `After line ${start}`}`;
  return `${fallback} · ${count === 1 ? `Line ${start}` : `Lines ${start}–${end}`}`;
}

export function hunkChangeDescription(added: number, removed: number): string {
  return `${added} ${added === 1 ? 'line' : 'lines'} added · ${removed} ${removed === 1 ? 'line' : 'lines'} removed`;
}
