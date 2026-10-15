import { GitFailure, classifyGitDiagnostic } from '../git/git-error-parser';
import type { ConflictSource, ConflictsSurface, MergeBridge, OperationSummaryProvider } from '../git/conflicts/conflict-contract';
import type { CompareSurface } from '../webviews/compare/compare-contract';
import type { RepositoryRegistry } from '../repositories/repository-registry';
import type { PathPolicy } from '../security/paths';
import type { GitExecutor } from '../git/git-executor';
import type { GitService } from '../git/git.service';
import type { AdvancedService } from '../git/advanced/advanced.service';
import type { ConflictsService } from '../git/conflicts/conflicts.service';
import type { HistoryService } from '../git/history/history.service';
import type { HistoryPanel } from '../webviews/graph/history-panel';
import type { RevisionProvider } from '../documents/revision-provider';
import type { ToolsService } from '../git/tools/tools.service';
import type { Logger } from '../utils/logging';
import { MenuRouter } from '../webviews/menu-context';

/**
 * Late-bound feature surfaces: extension.ts creates one holder, hands it to the constructors that need it, and the register* functions fill it in,
 * so features land without touching each other's constructor calls. No runtime vscode import: vm-loaded unit tests require this module as is.
 */
export interface Surfaces {
  /** Set by registerConflicts (WP2). */
  conflicts?: ConflictsSurface; mergeBridge?: MergeBridge;
  /** Set by registerCompare (WP5) from WP4's createCompareSurface. */
  compare?: CompareSurface;
  /** Set by registerOperation (WP3) on WP1's operation context. */
  operation?: OperationSummaryProvider;
  /** Per repository id. WP5 records a stash pop/apply and WP1 a squash merge that stopped on conflicts; WP3's watcher deletes the entry when the count reaches 0 or the repository closes. */
  readonly conflictSources: Map<string, ConflictSource>;
  /** Which panel a native context-menu command came from; panels register their session here while they are open. */
  readonly menus: MenuRouter;
}
export function createSurfaces(): Surfaces { return { conflictSources: new Map(), menus: new MenuRouter() }; }
/** The trusted wrapper from extension.ts (trust and built-in Git checks, recovery toast, conflict auto-open); registrations belong to context.subscriptions. */
export type TrustedCommand = (id: string, action: (...args: unknown[]) => Promise<unknown>) => void;
/** What every register* function receives besides the extension context and the trusted wrapper. */
export interface FeatureDeps {
  readonly registry: RepositoryRegistry; readonly policy: PathPolicy; readonly executor: GitExecutor; readonly logger: Logger;
  readonly git: GitService; readonly advanced: AdvancedService; readonly conflicts: ConflictsService; readonly tools: ToolsService;
  readonly history: HistoryService; readonly historyPanels: HistoryPanel; readonly revisions: RevisionProvider;
  readonly surfaces: Surfaces;
}
/** Setting `gitPro.conflicts.autoOpen`; anything unknown reads as the default. */
export type ConflictsAutoOpen = 'gitPro' | 'always' | 'never';
export function conflictsAutoOpen(value: unknown): ConflictsAutoOpen { return value === 'always' || value === 'never' ? value : 'gitPro'; }
/** A Git failure classified as a conflict, as recoveryFor classifies it. A plain Error that merely mentions conflicts ("Resolve and stage all conflicts before continuing.") is not one. */
export function isConflictFailure(error: unknown): boolean {
  if (error instanceof GitFailure) return error.kind === 'conflict';
  const details = error && typeof error === 'object' ? error as { message?: unknown; stderr?: unknown; gitErrorCode?: unknown } : undefined;
  if (!details || !['gitErrorCode', 'stderr', 'gitCommand', 'exitCode'].some(key => key in details) || details.gitErrorCode === 'AuthenticationFailed') return false;
  return classifyGitDiagnostic(`${typeof details.message === 'string' ? details.message : ''}\n${typeof details.stderr === 'string' ? details.stderr.slice(0, 8192) : ''}`) === 'conflict';
}
/**
 * §3.5: after a Git Pro action stopped on conflicts, reveal and focus the Conflicts tab unless the mode is `never`. `conflicts` is the repository's count after the
 * action's refresh, so a conflict-classified failure in another repository never opens an empty tab. Only reveals UI, never mutates (N10).
 */
export async function openConflictsAfterFailure(surfaces: Surfaces, request: { readonly error: unknown; readonly repositoryId: string | undefined; readonly conflicts: number; readonly mode: ConflictsAutoOpen }): Promise<boolean> {
  if (request.mode === 'never' || !request.repositoryId || request.conflicts < 1 || !surfaces.conflicts || !isConflictFailure(request.error)) return false;
  await surfaces.conflicts.open(request.repositoryId); return true;
}
