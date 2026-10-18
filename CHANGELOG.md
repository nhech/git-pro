# Changelog

## 0.4.0 — 2026-10-19

A safety net under Discard, hard reset and force push, pull requests reviewed by fetching their ref, blame of a whole file, and a set of smaller tools for History, the commit box and remotes.

- **Single lines can be staged** with VS Code's own Stage Selected Ranges in the diff Git Pro opens; the guide and the Compare page say how.
- **Protected branches.** List branches in `gitPro.protectedBranches` (`main`, `release/*`, `hotfix/**`) and Git Pro asks, in its own words, before it commits on one, pushes it, force pushes it or deletes it.
- **Open on Remote and `#123` links.** A commit's menu in History and Compare has Open on Remote and Copy Remote URL, and History's details have an Open on Remote button. `#123` in a commit's subject or message becomes a link to that issue or pull request (`!123` to a merge request on GitLab). The links are built from the address of the remote and opened only when you click; a company GitHub, GitLab, Bitbucket or Gitea/Forgejo server is named in `gitPro.remoteHosts`.
- **Conventional Commit… for the commit box.** A button in the title of the Commit view (and the Command Palette) asks in Quick Picks for a type (feat, fix, docs and the rest of `gitPro.commit.conventionalTypes`), a scope and whether the change is a breaking one, and writes `type(scope)!: ` at the start of the first line of the message and nothing else. A first line such as `note: this`, which does not start with a listed type, is left alone.
- **Search prefixes in History.** The Text box takes `author:`, `file:` (or `path:`), `since:`, `until:` and `message:` next to plain words: `fix crash author:alice file:src since:2026-01-01`. A prefix fills the filter of the same name and the form shows where it went; quote a value with spaces (`author:"Alice Smith"`).
- **Go to HEAD, Parent and Child in History.** Alt+Home, Alt+Down and Alt+Up in the list, or the same names in a commit's right-click menu, select HEAD, the first parent and the nearest child among the loaded commits, and say so when the commit is not loaded yet.
- **Compare Pull Request…** reviews a pull request (a merge request on GitLab) without an account, a token or any request to the host's API. Type its number or link and pick the branch it is merged into; Git Pro fetches the ref the host publishes for it (`refs/pull/123/head` and its GitLab and Bitbucket Server equivalents) with the built-in Git's own credentials into `refs/gitpro/pr/<remote>/<number>`, and opens it in the Compare tab as `PR #123`. No branch, tag or working file is touched. Bitbucket Cloud publishes no such refs.
- **Undo… for Discard, hard reset, force push and Get from Branch.** Before Git Pro discards unstaged changes, hard resets, force pushes with lease or replaces files with Get from Branch, it keeps a copy of what the action would lose (the tracked changes, the old HEAD, the remote commit it replaces) under `refs/gitpro/undo/`, and **Undo…** in the Command Palette puts it back after the usual review. A toast offers Undo after a hard reset or a force push; a discard is not run if no copy can be kept. Up to 20 copies per repository, for 30 days.
- **Blame of the whole file in the gutter.** **Toggle File Blame** (Command Palette) shows, before each block of lines, the commit's short hash, author and age on a tint from warm (recent) to cool (old). Hover the gutter for a card with the author, date and subject, and links to open the commit in History, copy its hash or open it on the remote. An edit hides it until the file is saved, and a new HEAD reads it again; files over 1 MiB or 20,000 lines are refused.
- **Performance notes.** [docs/user-guide/PERFORMANCE.md](docs/user-guide/PERFORMANCE.md) publishes what `npm run test:stress` measures (the first History page of 100,000 commits in about 120 ms, the status of 5,000 changed files in about 80 ms, 10,000 branches in 1.4 s, the 344 KB package) with the machine it ran on, and lists the limits that bound every read.
- **Vietnamese.** With the Vietnamese Language Pack installed, VS Code shows Git Pro's command titles, menus, view names and setting descriptions in Vietnamese (`package.nls.vi.json`). The panels (History, Compare, Conflicts) stay in English. A test keeps the two files in step, so a new string cannot ship without its translation.
- **Two animated tours in the README.** The Compare and Conflicts sections of the README and the Marketplace page show a GIF of the tab at work (a commit chosen, files marked as viewed, tip to tip; a merge resolved in the merge editor and ready to continue), recorded by the screenshot script (`npm run screenshots -- --only=compare-tour,conflicts-tour`). The screenshots of the sidebar were taken again for the layout of 0.3.1, where Repositories is the last view.

## 0.3.1 — 2026-10-17

Changes shows each file's own icon, a binary file opens in the built-in diff, and Repositories moves to the bottom of the sidebar.

- **A binary file opens in the built-in diff.** Clicking a changed image, PDF or other file that Git Pro's text diff cannot show used to end in "Binary revision: open the file through native Source Control". It now opens that diff itself, and the same goes for a file that is too large, a symlink or submodule, and text that is not UTF-8. The message appears only when the built-in Source Control cannot show the file either. A file that is staged and changed again opens as its working-tree change.
- **The Repositories view is the last view of the sidebar**, after Branches and Repository Tools: with one repository it adds little, and Commit and Changes now come first. VS Code keeps the order you already have; drag the view, or reset it with **View: Reset Location of All Views**, to see the new one.
- **Changes shows each file's own icon** from your file icon theme (TypeScript, Markdown, images and so on), as the built-in Source Control does. Version 0.3.0 gave every row the same icon for its status; the status is now the coloured letter at the end of the row, and the colour of the name.

## 0.3.0 — 2026-10-16

Changes is now VS Code's own tree, Branches shows how far each branch has moved, and Compare reads more like a code review.

- **Changes is a native tree.** It looks and behaves like the built-in views: status icons, letters and colours that follow your theme, the file name with its folder beside it, multi-select with Ctrl or Shift and the keyboard, the same hover and focus rows, and a count badge on the Git Pro icon. Hover or select a row for Open Changes, Open File, Discard and Stage or Unstage; group headers have Stage All and Unstage All, and the view title has Commit, Fetch, Pull, Push, Stage All and Unstage All, with a **View as Tree** or **View as List** switch. Right-click a row, a folder or a group for every action; the menu works on the whole selection. An unfinished merge, rebase, cherry-pick or revert is the first row of the list ("Merging feature into main · 3 conflicts") with Resolve, Continue, Skip, Abort and Amend. The "N selected" bar below the list is gone, because the menus and the inline buttons now act on the selection themselves.
- **Ahead and behind in Branches.** A local branch that differs from its upstream shows `↑2 ↓1` next to its name. The counts are read apart from the list, so a slow repository never delays it.
- **Compare marks the same change.** A commit that exists on the other side under another ID, such as a cherry-pick or a rebased copy, carries a `≈` and its row says so to a screen reader; the footer counts them. The check runs when the two sides together have at most 2,000 commits; with more, the footer says it was skipped.
- **Compare lists the changed files as a nested tree.** Folders come first and hold their folders and files, a chain of folders with nothing else in it reads as one row (`src/main/java`), as in the Explorer, and a folder row counts everything below it.
- **Mark files as viewed**, as in a code review. Press **V** on a row, use the button on it, or right-click (the whole selection of a working-tree comparison at once). A viewed file is dimmed with a check and counted in the footer. The marks are kept in the workspace for that exact comparison, so they outlive the tab and last as long as the two commits and the folder stay the same; the 30 most recent comparisons are remembered. Marking a file changes nothing else, so a selection made for Get from Branch is kept. The files of one commit have no marks.
- **Commit rows in Compare** have **Copy Revision Number** and **Show in History** buttons on hover and focus.
- Marks in a working-tree comparison follow the file: one that you edit while the tab is open is no longer marked, and Since fork and Tip to tip keep their marks apart, because the same file has another diff in each.
- Fixes: **Stage All** on the Untracked group failed when one of its entries was a repository of its own; it now leaves that one out, as the title-bar Stage All does. Stage Folder, Unstage Folder, Discard Folder and Copy Relative Path act on every selected row, not only the one you right-clicked. In Changes, **Merge…** is offered only on a conflict that both sides changed or added (the others get Resolve Conflicts… in its place), and Open File is not offered on a deleted file. A group header that is part of a selection no longer turns Stage or Discard into an action on the whole group. Branches keeps its ahead and behind counts in a repository with many long branch names.
- The screenshots in the README and on the website are now taken by a script (`npm run screenshots`) from a demo repository, and there are new ones for Compare and Conflicts.

## 0.2.3 — 2026-10-15

Right-click menus are now VS Code's own, and Compare is quicker to work in.

- **Native right-click menus** in History, Compare, Conflicts and the interactive rebase planner. A commit offers Checkout (Detached), Create Branch, Create Tag, Cherry Pick, Revert, Interactive Rebase from Here, Compare with Current, Compare with Working Tree and Copy Commit Hash or Message; a conflicted file offers Merge…, Accept Yours, Accept Theirs, Mark Resolved, Open File and the three compares; each rebase step offers its actions and Move Up or Down. Each choice goes through the same preview and confirmation as before. The Compare and More Actions drop-downs in the Conflicts tab stay, because a native menu cannot open from a button, and now close when the panel loses focus, resizes or scrolls.
- **Branches, Repositories and Repository Tools** no longer open a list when you click an item: a click only selects, as in the built-in views. Right-click a branch for Checkout, Rename, Set or Unset Upstream, Copy Branch Name, Delete and Force Delete next to the compare, merge and rebase choices; right-click a stash, tag, remote or worktree for its actions, and a group for Create, Add or Prune; right-click a repository for History, Fetch, Pull, Push, Repository Tools, Copy Path and Reveal. The inline button beside an item still opens the old list.
- **Compare opens diffs beside the tab.** Click a file and its diff appears next to the list, which stays in view; the next click replaces it. Turn this off with the new setting `gitPro.compare.openDiffsBeside`.
- **Filter the changed files** by part of a name and by Added, Modified, Deleted or Renamed. Counts, paging and Open All Changes follow what is shown.
- **Compare a folder** with a branch, tag or revision: Compare with Branch or Tag… now works on a folder in the Explorer, and lists only the files inside it.
- **Enter a revision…** at the end of every Compare list takes a commit ID or an expression such as `HEAD~3`.
- Ctrl+A (⌘A) selects every file in a working-tree comparison.
- **Shortcuts that the menus show.** Alt+Y, Alt+T and Alt+M (Accept Yours, Accept Theirs, Merge…) are now real shortcuts of the Conflicts tab, so its menu shows them, and Alt+Up and Alt+Down move the selected commit in the interactive rebase planner; neither runs while the keyboard is in the sidebar or the panel. In the Branches view F2 renames, Delete deletes (after the usual confirmation) and Ctrl+C copies the name of the selected branch; in Repository Tools Delete starts the removal that fits the selected stash, tag, remote or worktree, and F2 renames a remote. Every shortcut works only inside its own tab or view.
- **Next and Previous File** in Compare (Alt+Down and Alt+Up in the list, or the arrow buttons above it) open the neighbouring file's diff beside the tab.
- After a right-click menu closes, focus goes back to the row it was opened on.
- Fixes: the Changes view said "Working tree clean" twice; History showed `refs/heads/…` paths in the filter summary and on commit rows instead of branch and tag names; the Commit pane cut off its staging hint.
- The Marketplace page has a new description and more search keywords, and the README screenshots are no longer packed into the extension: the package is 332 KB instead of 798 KB, and the README links to them at the commit the package was built from.

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
- **More conflict and rebase fixes:** a rebase that stops on a conflict in a squash or fixup step is recognised as a rebase (it was shown as idle, with Yours and Theirs the wrong way round); the default Continue of a merge keeps lines you typed that start with `#` and removes only the "Conflicts:" block Git added; a rebase that rewords commits picks its comment character from every message in the range and tells you the exact command to continue it in a terminal; a stash apply is recognised only by both of its marker labels; the fingerprint of a reviewed reset covers files whose names are not valid UTF-8.
- **More Stage and Compare fixes:** a symlink that points outside the repository now stages, unstages and discards like any other (Unstage All used to fail on it); a repository Git does not track yet is no longer staged by Stage All as an embedded repository; Open All Changes leaves out a link that leads outside instead of failing; merge and rebase previews and the History compare list no longer fail on a path that is not valid UTF-8; `.git.bak` and similar folder names are ordinary files, while a link into the `.git` of a nested repository is refused; ignored-folder names match the way the file system compares names.
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
- A native look across every view: 22px rows, status letters, codicons, theme colours throughout, a column-based History with a sticky header and theme lane colours, and an interactive rebase planner. The orange accent marks HEAD and the current branch and can be changed through the theme colour `gitPro.accent`.
- Work in large repositories: Stage All and selections of thousands of files, very large unstaged or untracked files, slow containing-ref lookups and very large commits are handled without blocking other actions.
