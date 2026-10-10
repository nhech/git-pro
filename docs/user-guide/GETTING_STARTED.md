# Getting started

Requires VS Code 1.100.0 or newer, Git and the built-in Git extension. Open a trusted filesystem workspace. Browser and virtual workspaces are unsupported.

1. Install **Git Pro** from the Extensions view, or run **Extensions: Install from VSIX...** for a downloaded package. Reload VS Code if requested.
2. Open your repository folder and review workspace trust before enabling Git operations.
3. Select **Git Pro** in the Activity Bar. Choose the repository if more than one is available.
4. Open Changes, review a diff and stage the intended files. Selecting rows does not stage them.
5. Type a message in the Commit box above Changes and press Ctrl+Enter (⌘Enter on macOS) or Commit; the menu beside Commit offers Commit & Push, Amend, Sign-off, Skip hooks and message history. The composer commits the current index.

Use the Command Palette's **Git Pro** commands to open History, File History, branches, advanced actions or repository tools. Hover a Changes row for inline actions or right-click it for all file actions. Assign shortcuts in VS Code's Keyboard Shortcuts editor; Git Pro does not assign global shortcuts by default.

For partially staged files, select lines in native Source Control, then review the index in the composer. **Commit File** commits the full saved version of one file and preserves unrelated staged files.

If a repository is missing, use the repository selector or open its folder explicitly. Nested discovery searches up to 200 directories and depth 3. Use **Git Pro: Show Output** for diagnostics. Review any log before sharing it.

Git Pro uses your configured Git identity, credential helpers, SSH agent and signing settings. Configure these in Git before using authenticated or signed operations.

[Workflows](WORKFLOWS.md) · [Settings](SETTINGS.md) · [Compatibility](RELEASE_STATUS.md)
