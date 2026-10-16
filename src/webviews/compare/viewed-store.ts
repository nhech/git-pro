/** The part of a VS Code Memento the store needs, so tests can stand in for it. */
export interface ViewedMemento { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
interface Entry { at: number; files: string[] }
const KEY = 'gitPro.compare.viewed', MAX_COMPARISONS = 30, MAX_FILES = 5000, MAX_PATH = 4096;

/**
 * Which files of a comparison the user has marked as viewed, kept in the workspace state so the marks outlive the tab. A comparison is named by its two pinned commits (and the
 * folder it is limited to), so the marks last exactly as long as the files they were made for are the same; the 30 most recent comparisons are kept, 5000 files each.
 * No `vscode` import: unit tests load this module as it is.
 */
export class ViewedStore {
  constructor(private readonly memento: ViewedMemento | undefined) {}
  private all(): Record<string, Entry> {
    const value = this.memento?.get<unknown>(KEY);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Entry> : {};
  }
  load(comparison: string): Set<string> {
    const entry = this.all()[comparison];
    return new Set(Array.isArray(entry?.files) ? entry.files.filter((file): file is string => typeof file === 'string' && file.length <= MAX_PATH).slice(0, MAX_FILES) : []);
  }
  save(comparison: string, files: ReadonlySet<string>): void {
    if (!this.memento) return;
    const all = this.all(), kept: Record<string, Entry> = {};
    if (files.size) all[comparison] = { at: Date.now(), files: [...files].filter(file => file.length <= MAX_PATH).slice(0, MAX_FILES) }; else delete all[comparison];
    for (const [name, entry] of Object.entries(all).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, MAX_COMPARISONS)) kept[name] = entry;
    void this.memento.update(KEY, kept);
  }
}
/** A file as the marks name it: a rename is its old and its new path, and a signature, for a file that can change under its mark, is part of the name. */
export function viewedId(file: { readonly path: string; readonly originalPath?: string }, signature?: string): string {
  const name = file.originalPath ? `${file.originalPath}\0${file.path}` : file.path;
  return signature === undefined ? name : `${name}\u0001${signature}`;
}
