# Contributing

Use Node.js 22 or newer and Git 2.36 or newer.

```sh
npm ci --ignore-scripts
npm run check
npm run package
npm run audit:licenses
```

Press F5 in VS Code to launch the extension for development. Run `npm run test:extension` for extension-host tests; use `GIT_PRO_TEST_VERSION` to select a VS Code version. Tests create disposable repositories and must not operate on a contributor's working repository.

## Screenshots

The images in `docs/images/` (README and Marketplace) and `site/img/` (landing page) are taken by a script, from a demo repository, so they can be redone after any UI change:

```sh
npm run screenshots                # builds, then writes docs/images/*.jpg and site/img/*-1080|1600.jpg
npm run screenshots -- --skip-build
npm run screenshots -- --only=compare-tour,conflicts-tour   # the two animated tours: docs/images/compare-tour.gif and conflicts-tour.gif
```

The two GIFs in the README are tours of the Compare and Conflicts tabs: each step of the tour saves a frame (`frame()` in `test/extension/screenshots.ts`), and `scripts/screenshots/gifs.cjs` draws the pointer where it was, since a capture does not show it, and joins the frames. A VS Code that runs a test refuses to show a dialog, so a tour cannot confirm one: the Conflicts tour resolves in the merge editor instead of with Accept Yours.

It needs Docker. In a container, a virtual 2160 × 1350 display (device scale 2) runs a real VS Code with the extension and the demo repositories of `test/fixtures/demo-repository.ts`; the tour that clicks through it is `test/extension/screenshots.ts`, and the container side is in `scripts/screenshots/`. The first run builds the image and downloads VS Code into a Docker volume. Look at every image before you commit it: raw captures and tuning probes (names starting with `_`) stay in `.shots/`, which is ignored by Git.

Keep changes focused and describe observable behavior in commit messages. Include relevant regression coverage for Git mutations, stale state, cancellation and disposal. Preserve the MIT license and third-party attribution.

Keep generated packages, logs, local credentials and internal planning or measurement reports out of Git. The installation package contains runtime assets and user documentation only.

## Publishing

A release is built from a clean checkout of the release commit, so work in progress in the working tree is never packaged:

```sh
git worktree add --detach ../git-pro-release HEAD   # then link or install node_modules there
npm run check
node scripts/package-public-candidate.cjs           # writes artifacts/git-pro-<version>-public-candidate.vsix
```

The README links its screenshots to the commit the package was built from, so push that commit before the package is uploaded.

**Visual Studio Marketplace.** Upload the package on the publisher's Manage page: the `...` menu of Git Pro, then **Update**.

**Open VSX** (VSCodium, Gitpod, and the gallery that Cursor installs from). This needs the owner's accounts, so it is done by hand, once and then for every release:

1. Sign in to <https://open-vsx.org> with GitHub, link an Eclipse Foundation account and sign the Publisher Agreement.
2. Create an access token under *Settings → Access Tokens*, and keep it in an environment variable, never in a file or the command history (`$env:OVSX_PAT = '…'`, or `export OVSX_PAT=…`).
3. Claim the namespace once: `npx --yes ovsx@1.2.0 create-namespace longtd -p "$OVSX_PAT"` (PowerShell: `-p $env:OVSX_PAT`).
4. Publish each release: `npx --yes ovsx@1.2.0 publish artifacts/git-pro-<version>-public-candidate.vsix -p "$OVSX_PAT"`.

Add the Open VSX link to the README and the website once the listing is live. Git Pro has not been checked in Cursor or VSCodium yet: Cursor 2.6 is built on VS Code 1.105 and ships the built-in Git extension, which meets the requirements, but Cursor did not run the extension-host tests (they stopped before Git Pro loaded), so a manual check is needed first: install the package, open the Git Pro view in a repository, then stage, commit and open a diff.

## Issue bot

Issues are opened from forms (bug report, feature request, question). A GitHub Actions bot (`.github/workflows/issue-bot.yml`, logic and tests in `.github/scripts/issue-bot.cjs` and `test/unit/issue-bot.test.ts`) triages them:

- A new issue gets `needs-triage`, up to two `area: …` labels guessed from its text, and one welcome comment. A bug report with empty required fields, or an issue that skipped the forms, also gets `needs-info` and a request for the missing details.
- When the reporter answers an issue labelled `needs-info`, the bot swaps it back to `needs-triage`.
- An issue labelled `needs-info` is marked `stale` after 14 days without a reply and closed 7 days later (`.github/workflows/stale.yml`). Nothing else is closed automatically.

Maintainers (owner, members and collaborators) control it with a comment whose first line is a command; other people's commands are ignored:

| Command | Effect |
|---|---|
| `/resolve` or `/resolve 0.2.1` | Comment, add `resolved`, clear the waiting labels and close as completed. A version is mentioned only when one is given. |
| `/duplicate #123` | Comment, add `duplicate` and close as not planned, when issue 123 exists. |
| `/needs-info optional note` | Add `needs-info`, remove `needs-triage` and ask for details. The note never pings anyone. |
| `/triaged` | Remove `needs-triage`. |
| `/reopen` | Reopen a closed issue. |
| `/label a, b` and `/unlabel a` | Add or remove up to five labels that already exist. |

The bot uses the repository's `GITHUB_TOKEN` with `issues: write` (and `contents: read` to check out its script) only. Issue text is treated as data: it is never expanded into a shell, and the workflow never checks out or runs code from a pull request.
