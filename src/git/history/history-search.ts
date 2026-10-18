import type { HistoryFilters } from './history-builders';

/**
 * Search prefixes for History's Text box: `fix crash author:alice file:src/app.ts since:2026-01-01`. Each prefix is the filter of the field of the same meaning, so a typed prefix and a
 * filled field are the same thing, and the page answers with the applied filters, which moves the prefixes into their fields. What is left is the message text.
 * No `vscode` import: unit tests load this module as it is.
 */
const keys: Readonly<Record<string, 'author' | 'message' | 'path' | 'from' | 'to'>> = {
  author: 'author', message: 'message', msg: 'message', grep: 'message', file: 'path', path: 'path', since: 'from', after: 'from', from: 'from', until: 'to', before: 'to', to: 'to',
};
// A prefix starts a word and has a value right after the colon: a word or a "quoted phrase". `https://x` and `note: this` are text.
const prefix = /(^|\s)(author|message|msg|grep|file|path|since|after|from|until|before|to):(?:"([^"\0]+)"|([^\s"]\S*))/gi;

/** The filters a text with prefixes stands for, or undefined when it has none and is to be searched as it is. A prefix repeated keeps its last value; `message:` words join the plain words in place. */
export function parseHistorySearch(input: string): HistoryFilters | undefined {
  const filters: HistoryFilters = {};
  let text = '', last = 0, found = false;
  for (const match of input.matchAll(prefix)) {
    found = true;
    const key = keys[match[2]!.toLowerCase()]!, value = (match[3] ?? match[4]!).trim();
    text += input.slice(last, match.index) + match[1];
    last = match.index + match[0].length;
    if (key === 'message') text += value; else if (value) filters[key] = value;
  }
  if (!found) return undefined;
  text = (text + input.slice(last)).replace(/\s+/g, ' ').trim();
  if (text) filters.text = text;
  return filters;
}
