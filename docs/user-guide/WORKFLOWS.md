# Workflows and recovery

## Review, stage and commit

Use Changes to review the diff and stage or unstage files or folders. Hover or select a row for inline Open Changes, Open File, Discard and Stage or Unstage buttons (Stage All or Unstage All on group headers); right-click a row for every contextual action. Discard requires a reviewed confirmation because it removes working changes. Selection does not change the index.

The composer uses the current index and preserves partial staging performed in native Source Control. Hooks run by default. Amend and Skip Hooks require explicit review. A signing failure retains the draft; Git Pro does not disable signing or automatically retry a commit. If Commit & Push commits successfully but push fails, the result reports these outcomes separately. Inspect the successful commit before retrying the push.

**Hunk Actions** checks a reviewed text patch before applying only that hunk. Unsaved files or stale reviews block the action. Binary, new/deleted, rename and mode-change cases use native SCM guidance. **Commit File** commits the full saved version of one file with Git's `commit --only`, preserving unrelated staged files.

## Sync and branches

Fetch reads remote updates. Pull requires a clean tree and defaults to fast-forward only; choose merge or rebase explicitly in [settings](SETTINGS.md). Ordinary push confirmations are optional. Force Push with Lease always requires a fresh exact-lease preview and confirmation; there is no setting to disable this review.

## History and comparison

History stays pinned to its repository. Choose branch/tag scope and filters; select a commit to inspect Details, parent choice and changed files. Compare exact revisions through History's Compare form, or branches in the Compare tab (below). File History follows renames across parents with explicit continuation when traversal reaches its bound.

History loads 25–100 commits per page and stops at 2,000 loaded commits. Load more explains whether the history ended or the load cap was reached. Refresh starts a new snapshot. Details mounts 200 files per page; comparison sides use 25 entries per page. Containing refs load after the rest of Details; in very large repositories they can take a while or be reported as unavailable without affecting the details. A commit whose file list or message exceeds the read bound shows its metadata with a note to use native Git. Text revisions require UTF-8 and at most 5 MiB; unsupported binary/submodule/symlink cases show guidance.

Enable active-line blame to see author, UTC author date, hash and summary. Dirty buffers suppress on-disk attribution; uncommitted lines have no commit link. Optional CodeLens opens File History for saved regular files in open trusted repositories.

## Compare branches

In the Branches view or Branch Actions, choose **Compare with Current** or **Show Diff with Working Tree** on any branch except the checked-out one. **Compare with Another Branch…** works on every branch, including the checked-out one and remote branches: pick the other branch or tag from a list, and the checked-out branch is always shown on the right. Ctrl/Cmd-click exactly two branches for **Compare Branches**. The **Remote** group of the Branches view lists the remote branches Git already has; use **Fetch** in the view title (or turn on auto-fetch in settings) to download new ones. Tags → Compare With HEAD opens the same tab. Both refs are pinned to commits when the tab opens; if a branch moves later, the tab says so and **Refresh** pins it again.

The Compare tab lists "Commits in X, not in Y" for each direction, 25 at a time, with **Swap**. Files show **Since fork** (what the branch changed since the merge base; the default) or **Tip to tip**. With several merge bases the first one is used; unrelated histories fall back to tip to tip. Select a commit to see only its files, and **All changes** to return. **Open All Changes** opens up to 300 text files in one multi-diff editor; binary files are left out. File rows offer Open Diff, **Compare with Local** and Open File.

**Show Diff with Working Tree** compares a branch with your tracked working files, staged or not; untracked files are not compared. The working file is the editable side. **Get from Branch** (up to 100 selected files) replaces those working files with the branch version and deletes the ones the branch does not have, after a confirmation that lists both. It never changes the index, and it refuses files with unsaved edits and untracked or ignored files of the same name, which Git could not give back.

**Compare with Branch or Tag…** in the Explorer and editor tab menus compares one file with a branch or tag; the working file stays editable.

## Resolve conflicts

When a Git Pro merge, pull, rebase, cherry-pick, revert or stash stops on conflicts, the **Conflicts** tab opens (setting `gitPro.conflicts.autoOpen`). Open it any time with **Resolve Conflicts…** from the Changes view, its banner or the status bar menu. Each row shows the file, its kind and the state of the Yours and Theirs sides, named after their branches. During a rebase, Yours is the commit being replayed (Git `--theirs`) and Theirs is the upstream; each confirmation names the Git side.

- **Accept Yours** / **Accept Theirs** (Alt+Y / Alt+T) resolve up to 100 selected files and stage them in one step after one confirmation. If the chosen side has no file, the file is deleted. Files with unsaved edits or open in a merge editor are refused.
- **Merge…** (Alt+M, Enter or double-click) opens VS Code's merge editor as Yours | Result | Theirs; the Result is the real file. **Apply & Next** in the editor title saves the Result, stages it and opens the next file. VS Code's own Complete Merge saves without staging, so Git Pro then offers Mark Resolved. VS Code's "Accept All … from Left/Right" tooltips keep their own Incoming/Current wording. VS Code's default merge editor layout puts Yours and Theirs side by side above the Result; **More Actions → Use Column Layout in Merge Editor** switches the next one to three columns, and VS Code keeps that layout.
- **Mark Resolved** (row menu) stages a text file changed on both sides with no conflict markers left. Binary files and modify/delete or add/rename conflicts are resolved with Accept only, so a side is never chosen silently. Symlinks, submodules and files larger than 5 MiB need native Git.
- A cherry-pick, revert, merge or stash apply run while a rebase is stopped (for example at an `edit` step) owns its conflicts: Yours is then your current work (Git `--ours`), and Continue or Abort act on that command first.

The Changes view shows a banner such as "Merging feature into main · 3 conflicts" with Resolve, Continue and Abort, and the status bar shows the conflict count; clicking it opens the same actions. Continue stays disabled until every conflict is staged and always asks first; Continue Merge can edit the merge message. After a Git Pro stash pop stops on conflicts, the stash is kept, and the tab offers **Drop Stash…** once everything is resolved.

## Advanced operations and tools

Advanced actions review fresh merge/rebase/cherry-pick/revert/reset previews. Branch Actions also offers **Merge into Current…** and **Rebase Current onto This…** with the same review. Continue, Skip and Abort depend on actual Git operation state. Interactive rebase supports 1–200 linear commits; merge ranges use native Git guidance. Resolve conflicts, save the intended content and review staging before continuing. If no merge editor can open, Git Pro opens the file with its conflict markers.

Canceling an operation may leave Git state changed. Refresh and inspect the repository before retrying. Git Pro coordinates its own mutations in one extension host; other tools can still change the repository concurrently.

Repository Tools exposes stashes, tags, remotes and worktrees. Tag pushes/deletions and worktree destinations are explicit. External worktree create/remove requires approval of the exact path. Stash pop conflicts retain the stash. No automatic destructive retry is performed.

[Getting started](GETTING_STARTED.md) · [Settings](SETTINGS.md) · [Compatibility](RELEASE_STATUS.md)
