import { decode } from './history-parser';
import { shortAge } from '../../utils/age';

/**
 * The blame of a whole file, from `git blame --porcelain`: which commit each line comes from, grouped into blocks of consecutive lines, with what a gutter and a hover card show.
 * Everything a repository supplies (author names, subjects) is bounded and stripped of control and direction characters here, because it ends up on screen next to code.
 * No `vscode` import: unit tests load this module as it is.
 */
export interface BlameCommit { readonly oid: string; readonly author: string; readonly timestamp: number; readonly summary: string; readonly uncommitted: boolean }
/** `length` consecutive lines, from the zero-based line `start`, that one commit wrote. */
export interface BlameBlock { readonly start: number; readonly length: number; readonly commit: BlameCommit }
export interface BlameFile { readonly lines: number; readonly blocks: readonly BlameBlock[] }

export const maxBlameLines = 20_000;
const header = /^([a-f0-9]{40}|[a-f0-9]{64}) (\d+) (\d+)(?: \d+)?$/i;
// Control characters, and the characters that reorder or isolate text, which could make one name read as another.
const unsafe = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩‎‏؜]/g;

/** One line of plain text of at most `max` characters (not UTF-16 units): the control and direction characters are dropped, runs of blanks become one, an ellipsis marks a cut. */
export function plainText(value: string, max: number): string {
  const text = Array.from(value.replace(unsafe, ' ').replace(/\s+/g, ' ').trim());
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).join('')}…` : text.join('');
}

/** The porcelain blame of one file. Throws for output that is not blame, and for a file of more than `maximum` lines. */
export function parseBlameFile(buffer: Buffer, maximum = maxBlameLines): BlameFile {
  const commits = new Map<string, BlameCommit>(), owner: string[] = [];
  const fields = new Map<string, Map<string, string>>();
  let current: string | undefined, expecting = false;
  for (const line of decode(buffer).split('\n')) {
    if (line.startsWith('\t')) {
      if (!expecting) throw new Error('Invalid blame output.');
      expecting = false; continue;
    }
    const match = header.exec(line);
    if (match) {
      const final = Number(match[3]);
      if (!Number.isSafeInteger(final) || final < 1 || final > maximum) throw new Error('This file has too many lines to blame at once.');
      const oid = match[1]!.toLowerCase();
      current = oid; owner[final - 1] = oid; expecting = true;
      if (!fields.has(oid)) fields.set(oid, new Map());
      continue;
    }
    // A metadata line of the commit whose header came last: `author Name`, `author-time 1700000000`, `summary Subject`, `boundary`.
    const separator = line.indexOf(' ');
    if (current && separator > 0) { const map = fields.get(current)!; if (!map.has(line.slice(0, separator))) map.set(line.slice(0, separator), line.slice(separator + 1)); }
  }
  for (let index = 0; index < owner.length; index++) if (owner[index] === undefined) throw new Error('Incomplete blame output.');
  for (const [oid, map] of fields) {
    const timestamp = Number(map.get('author-time'));
    if (!map.has('author') || !Number.isSafeInteger(timestamp)) throw new Error('Truncated blame metadata.');
    commits.set(oid, Object.freeze({ oid, author: plainText(map.get('author')!, 200), timestamp, summary: plainText(map.get('summary') ?? '', 1000), uncommitted: /^0+$/.test(oid) }));
  }
  const blocks: BlameBlock[] = [];
  for (let index = 0; index < owner.length;) {
    let end = index + 1; while (end < owner.length && owner[end] === owner[index]) end++;
    blocks.push(Object.freeze({ start: index, length: end - index, commit: commits.get(owner[index]!)! })); index = end;
  }
  return Object.freeze({ lines: owner.length, blocks: Object.freeze(blocks) });
}

/** How old a change is, as one of eight steps: a day, a week, a month, three months, half a year, a year, two years, older. The gutter colours them from warm to cool. `timestamp` is in seconds, as Git writes it, and `now` in milliseconds. */
export const ageBuckets = 8;
export function ageBucket(timestamp: number, now: number): number {
  const days = Math.max(0, (now - timestamp * 1000) / 86_400_000);
  const limits = [1, 7, 30, 90, 180, 365, 730];
  const found = limits.findIndex(limit => days <= limit);
  return found < 0 ? limits.length : found;
}

export const gutterWidth = 28;
const blank = ' ';
/** The gutter text of one line of a block (`now` in milliseconds): hash, author and age on its first line, and blanks of the same width after it, so the colour runs down the block. */
export function gutterText(block: BlameBlock, now: number, first: boolean): string {
  if (!first) return blank.repeat(gutterWidth);
  const commit = block.commit;
  const text = commit.uncommitted ? 'Not committed yet' : `${commit.oid.slice(0, 7)} ${plainText(commit.author, 14)} ${shortAge(commit.timestamp * 1000, now)}`;
  const chars = Array.from(text.replace(/ /g, blank));
  return (chars.length > gutterWidth ? chars.slice(0, gutterWidth) : [...chars, ...Array.from({ length: gutterWidth - chars.length }, () => blank)]).join('');
}

/** The block that holds a zero-based line, by bisection, or undefined past the end. */
export function blockAt(blocks: readonly BlameBlock[], line: number): BlameBlock | undefined {
  let low = 0, high = blocks.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1, block = blocks[middle]!;
    if (line < block.start) high = middle - 1; else if (line >= block.start + block.length) low = middle + 1; else return block;
  }
  return undefined;
}

/** Text made safe to put into Markdown as text: every character that could start a link, emphasis, a tag or a table is escaped. */
export function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]()<>#+\-.!|~&@:]/g, '\\$&'); }
