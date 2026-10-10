# Workflows and recovery

## Review, stage and commit

Use Changes to review the diff and stage or unstage files or folders. Hover or select a row for inline Open Changes, Open File, Discard and Stage or Unstage buttons (Stage All or Unstage All on group headers); right-click a row for every contextual action. Discard requires a reviewed confirmation because it removes working changes. Selection does not change the index.

The composer uses the current index and preserves partial staging performed in native Source Control. Hooks run by default. Amend and Skip Hooks require explicit review. A signing failure retains the draft; Git Pro does not disable signing or automatically retry a commit. If Commit & Push commits successfully but push fails, the result reports these outcomes separately. Inspect the successful commit before retrying the push.

**Hunk Actions** checks a reviewed text patch before applying only that hunk. Unsaved files or stale reviews block the action. Binary, new/deleted, rename and mode-change cases use native SCM guidance. **Commit File** commits the full saved version of one file with Git's `commit --only`, preserving unrelated staged files.

## Sync and branches

Fetch reads remote updates. Pull requires a clean tree and defaults to fast-forward only; choose merge or rebase explicitly in [settings](SETTINGS.md). Ordinary push confirmations are optional. Force Push with Lease always requires a fresh exact-lease preview and confirmation; there is no setting to disable this review.

## History and comparison

History stays pinned to its repository. Choose branch/tag scope and filters; select a commit to inspect Details, parent choice and changed files. Compare commits through History's Compare action. File History follows renames across parents with explicit continuation when traversal reaches its bound.

History loads 25–100 commits per page and stops at 2,000 loaded commits. Load more explains whether the history ended or the load cap was reached. Refresh starts a new snapshot. Details mounts 200 files per page; comparison sides use 25 entries per page. Containing refs load after the rest of Details; in very large repositories they can take a while or be reported as unavailable without affecting the details. A commit whose file list or message exceeds the read bound shows its metadata with a note to use native Git. Text revisions require UTF-8 and at most 5 MiB; unsupported binary/submodule/symlink cases show guidance.

Enable active-line blame to see author, UTC author date, hash and summary. Dirty buffers suppress on-disk attribution; uncommitted lines have no commit link. Optional CodeLens opens File History for saved regular files in open trusted repositories.

## Advanced operations and tools

Advanced actions review fresh merge/rebase/cherry-pick/revert/reset previews. Continue, Skip and Abort depend on actual Git operation state. Interactive rebase supports 1–200 linear commits; merge ranges use native Git guidance. Resolve conflicts, save the intended content and review staging before continuing. If the native Merge Editor is unavailable, use the conflict guidance and native diffs.

Canceling an operation may leave Git state changed. Refresh and inspect the repository before retrying. Git Pro coordinates its own mutations in one extension host; other tools can still change the repository concurrently.

Repository Tools exposes stashes, tags, remotes and worktrees. Tag pushes/deletions and worktree destinations are explicit. External worktree create/remove requires approval of the exact path. Stash pop conflicts retain the stash. No automatic destructive retry is performed.

[Getting started](GETTING_STARTED.md) · [Settings](SETTINGS.md) · [Compatibility](RELEASE_STATUS.md)
