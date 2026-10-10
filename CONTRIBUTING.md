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
