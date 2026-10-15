# Changelog

## 0.2.2 — 2026-10-15

- Right-click any branch in the Branches view, including the checked-out branch and remote branches, and choose **Compare with Another Branch…** to compare it with a branch or tag picked from a list; the checked-out branch is shown on the right. The same action is in Branch Actions and in the Command Palette.
- The Branches view title now has **Fetch** and **Refresh**, and an empty Remote group says that no remote branches are downloaded yet and offers Fetch, or that no remote is configured. The view lists the remote branches Git already has; Fetch downloads the current list from the remote.

Fixes found in a full audit:

- **Git 2.32 or newer is required.** With an older Git, Git Pro says so once and stays inactive instead of failing action by action. Git before 2.36 now lists worktrees too.
- **Discard no longer empties a file added with `git add -N`.** Git keeps no copy of such a file's content. Discard Folder leaves these files out and names them; the Changes view hides Discard on them, and Get from Branch refuses them.
- **Stage and Unstage work on symlinks and submodules** (a submodule is staged as one entry), where they failed before. Unstaging a copied file no longer unstages the file it was copied from.
- **Amend with nothing staged** changes only the message of the last commit.
- **Reword keeps lines that start with `#`** (for example "#42 hotfix"); Git used to delete them silently.
- **A file name that is not valid UTF-8** no longer breaks the whole repository: only that entry is left out, and Pull, branch switches and other "clean tree" checks still count it. Compare lists no longer fail on such paths, and say so.
- **Compare:** the branch list refreshes when you press Refresh; Open All Changes skips submodules and symlinks instead of failing; a shallow clone is no longer reported as having no common ancestor; closing a repository no longer shows a "moved" banner; Get from Branch refuses `git add -N` files.
- **Conflicts and merges:** reftable repositories (Git 2.45+) are recognised as being in a cherry-pick, revert or rebase; Continue no longer commits Git's "# Conflicts:" comment block; Mark Resolved is refused for binary and one-sided conflicts; executable-bit conflicts keep the right file mode; a merge started from Compare names the branch in its message instead of a commit ID; a stash applied while a rebase is paused is no longer mistaken for the rebase.
- **A stopped Git command** (timeout or cancel) is ended gracefully, and a lock file it leaves behind is named with what to do; on Windows the hook processes it started are stopped too.
- **Errors:** only real Git conflict wording offers **Resolve Conflicts…**; a hook that prints the word "conflict" no longer hides its own error; Git Pro's own messages no longer start with "Error:".
- **Settings and commands:** the Git Pro blame toggle writes to the setting's own scope; `git.defaultBranchName` is honoured by Initialize Repository; nested repositories follow `git.autoRepositoryDetection`, scan depth and ignored folders; commands that need a tree row are hidden from the Command Palette; the welcome text and capability notes are localisable; the message editor tab is closed after use; the Changes view's content security policy now allows only its own nonce-marked script.

## 0.2.1 — 2026-10-15

- Added search keywords (merge, conflict, compare, diff, branch, cherry-pick) so the extension is easier to find on the Marketplace.
- No functional changes since 0.2.0.

## 0.2.0 — 2026-10-15

- Git Pro is no longer labelled a preview on the Marketplace, on the website or in the docs. Requirements and known limits, such as Remote WSL and Dev Containers not having completed release validation, stay listed in Compatibility and limitations.
- No functional changes since 0.1.0.

## 0.1.0 — 2026-10-15

- Review changes with file and folder staging, native diffs, file-type icons, inline row actions (Open Changes, Open File, Discard, Stage) and contextual actions.
- Commit staged changes from a message box above Changes (Ctrl+Enter, or ⌘Enter on macOS, or Commit; Commit & Push and options in the menu beside it), with amend, signoff and configured Git signing.
- Manage branches, upstreams, fetch, pull and push.
- Browse commit graphs, compare revisions and follow file history across renames.
- Use optional active-line blame and File History CodeLens.
- Review advanced Git operations and recover ongoing merge and rebase sequences.
- Resolve conflicts in a Conflicts tab: Yours/Theirs named by branch (during a rebase, Yours is the commit being replayed), bulk Accept Yours/Accept Theirs that resolves and stages after one confirmation, Merge… in VS Code's merge editor as Yours | Result | Theirs with Apply & Next, and Mark Resolved. The tab opens when a Git Pro action stops on conflicts (`gitPro.conflicts.autoOpen`).
- Follow an operation from the Changes banner and the status bar conflict count, with Continue, Skip and Abort behind a confirmation. Continue Merge can edit the merge message.
- Merge, squash-merge, pull-merge and stash apply/pop conflicts are now reported as conflicts with a Resolve Conflicts… button instead of a generic Git failure. Double-click on a conflict row opens Merge… or the Conflicts tab instead of a diff that could not open.
- The per-file Resolve Conflict quick pick says Yours/Theirs; guard messages point to Resolve Conflicts… and Operation Actions….
- Compare branches in a Compare tab from the Branches view and Branch Actions: Compare with Current, Compare Branches, Show Diff with Working Tree with Get from Branch, commits on each side, Since fork or Tip to tip files, and Open All Changes. Tags → Compare With HEAD opens it too, and Compare with Branch or Tag… compares one file.
- Merge into Current… and Rebase Current onto This… in Branch Actions, with the Advanced Actions review.
- Manage stashes, tags, remotes and worktrees.
- Use theme-aware icons, clear change statuses and responsive History panels.
- A native look across every view: 22px rows, status letters, codicons, theme colours throughout, a column-based History with a sticky header and theme lane colours, and a GitLens-style rebase planner. The orange accent marks HEAD and the current branch and can be changed through the theme colour `gitPro.accent`.
- Work in large repositories: Stage All and selections of thousands of files, very large unstaged or untracked files, slow containing-ref lookups and very large commits are handled without blocking other actions.
