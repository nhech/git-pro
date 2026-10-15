# Changelog

## 0.2.1 — 2026-10-15

- Added search keywords (merge, conflict, compare, diff, branch, cherry-pick) so the extension is easier to find on the Marketplace.
- No functional changes since 0.2.0.

## 0.2.0 — 2026-10-15

- Git Pro is no longer labelled a preview on the Marketplace, on the website or in the docs. Requirements and known limits, such as Remote WSL and Dev Containers not having completed release validation, stay listed in Compatibility and limitations.
- No functional changes since 0.1.0.

## 0.1.0 — 2026-10-15

- Review changes with file and folder staging, native diffs, file-type icons, inline row actions (Open Changes, Open File, Discard, Stage) and contextual actions.
- Commit staged changes from a message box above Changes (Ctrl+Enter or Commit; Commit & Push and options in the menu beside it), with amend, signoff and configured Git signing.
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
