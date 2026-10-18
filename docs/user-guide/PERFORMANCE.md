# Performance

What Git Pro costs, as measured, and where it is bounded by design. Everything here can be reproduced from the repository; where a number is not measured, this page says so.

## Measured

`npm run test:stress` builds one repository with **100,000 commits, 10,000 branches and 5,000 changed files**, adds nine more repositories, and times the reads that the History, Branches and Changes views make. It writes the figures to `artifacts/stress-core.json`.

| What | Result |
|---|---|
| First page of History (100 commits) of the 100,000-commit history, cold | 131 ms |
| The same page, five warm runs | median 116 ms, slowest 136 ms |
| Reading and parsing the 10,000 branches | 1.5 s |
| Searching the 10,000 branches again, from the cache | 1.6 ms |
| Reading and parsing the status of 5,000 changed files | 93 ms |
| 500 repository change events fired at once | 1 status read |
| Memory of the whole Node process that held the repositories and ran the test | 97 MB |
| Size of the package | 338 KB, 39 files, 1.2 MB unpacked; no runtime dependencies |

Run on 2026-10-18, version 0.3.1, Windows 11, an 11th Gen Intel Core i5-11400F at 2.6 GHz, Git 2.36.0 for Windows (the oldest Git that Git Pro supports is 2.32, and newer Git is not slower at these reads), Node 24. Your repository, disk, antivirus and Git will give other numbers; the figures above are one machine's, not a promise.

What this measures is Git Pro's own path: starting Git, reading its output with the bounds below, and parsing it. It does not measure VS Code's start-up, the time the extension takes to activate inside VS Code, the memory of the extension host, or how fast a webview draws. Those depend on the machine and on the other extensions that are installed, and no figure for them is published here.

## Bounded by design

These limits are in the code and in its tests; they do not depend on how large a repository is.

| Where | Limit |
|---|---|
| A Git read | 5 MiB of output, then it stops and says so |
| History | 25 to 100 commits per page (`gitPro.graph.pageSize`), at most 2,000 kept; only the rows in view, and a few more, are drawn |
| Compare | Commits 25 at a time; files 200 at a time; the same-change check is skipped past 2,000 commits |
| Branches | The search over the list is kept for 10 seconds, and the branch pickers refuse more than 10,000 branches; ahead and behind counts load apart from the list, in reads of at most 200 branches |
| File blame | A regular file of at most 1 MiB and 20,000 lines; one `git blame --porcelain` read |
| Safety copies for Undo… | 20 per repository, for 30 days |
| Status | Changes are read from one `git status`; a burst of change events is merged into one read |

Auto-fetch, active-line blame, File History CodeLens and File Blame are off until you turn them on.

Git Pro does check for changes by itself: while the VS Code window has focus it reads the status of each open repository every 5 seconds, slowing to every 30 seconds while nothing changes, and it reads at once when VS Code's Git extension reports a change or when you ask. A window in the background is not read, and a repository whose read is still running is not queued again.

## Reproduce

```bash
npm ci
npm run test:stress
```

The test runs for about a minute and prints the figures it writes. A different machine, or a different Git, is a different measurement; compare the figures of two runs on the same machine.
