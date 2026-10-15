# Contributing

Use Node.js 22 or newer and Git 2.36 or newer.

```sh
npm ci --ignore-scripts
npm run check
npm run package
npm run audit:licenses
```

Press F5 in VS Code to launch the extension for development. Run `npm run test:extension` for extension-host tests; use `GIT_PRO_TEST_VERSION` to select a VS Code version. Tests create disposable repositories and must not operate on a contributor's working repository.

Keep changes focused and describe observable behavior in commit messages. Include relevant regression coverage for Git mutations, stale state, cancellation and disposal. Preserve the MIT license and third-party attribution.

Keep generated packages, logs, local credentials and internal planning or measurement reports out of Git. The installation package contains runtime assets and user documentation only.

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
