import type { HistoryCommit } from '../../git/history/history-parser';
export interface GraphEdge { from: number; to: number; oid: string; boundary: boolean }
export interface GraphRow { oid: string; lane: number; before: readonly (string | null)[]; after: readonly (string | null)[]; edges: readonly GraphEdge[] }
export interface GraphPage { rows: readonly GraphRow[]; continuation: readonly (string | null)[] }
/** Carries exact parent OIDs across pages; missing/filtered parents remain boundary lanes. */
export function layoutGraph(commits: readonly Pick<HistoryCommit, 'oid' | 'parents'>[], continuation: readonly (string | null)[] = []): GraphPage {
  const lanes = [...continuation]; const visible = new Set(commits.map(commit => commit.oid)); const rows: GraphRow[] = [];
  const allocate = (oid: string, preferred?: number) => {
    const existing = lanes.indexOf(oid); if (existing >= 0) return existing;
    const free = preferred !== undefined && !lanes[preferred] ? preferred : lanes.indexOf(null);
    const slot = free < 0 ? lanes.length : free; lanes[slot] = oid;
    if (lanes.length > 512) throw new Error('Graph is too wide; narrow the branch/filter query.');
    return slot;
  };
  for (const commit of commits) {
    const lane = allocate(commit.oid); const before = [...lanes]; lanes[lane] = null;
    const parentEdges = commit.parents.map((parent, index) => ({ from: lane, to: allocate(parent, index === 0 ? lane : undefined), oid: parent, boundary: !visible.has(parent) }));
    const edges: GraphEdge[] = before.flatMap((oid, index) => oid && oid !== commit.oid ? [{ from: index, to: lanes.indexOf(oid), oid, boundary: !visible.has(oid) }] : []);
    edges.push(...parentEdges);
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    rows.push(Object.freeze({ oid: commit.oid, lane, before: Object.freeze(before), after: Object.freeze([...lanes]), edges: Object.freeze(edges) }));
  }
  return { rows: Object.freeze(rows), continuation: Object.freeze([...lanes]) };
}
