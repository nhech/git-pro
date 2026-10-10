# Compatibility and limitations

Git Pro 0.1.0 is a preview: behavior and limits may change between versions. Report problems on [GitHub Issues](https://github.com/nhech/git-pro/issues).

## Requirements

- VS Code 1.100.0 or newer with the built-in Git extension enabled.
- Git available on the extension host.
- A trusted filesystem workspace. Browser and virtual workspaces are unsupported.

Git identity, authentication and signing use the configured Git environment. Remote workspaces require Git and credentials on the remote host. Remote WSL and Dev Containers have not completed release validation.

## Workflow limits

- History uses a pinned snapshot until Refresh and displays up to 2,000 loaded commits and 512 graph lanes.
- Text revisions must be UTF-8 and no larger than 5 MiB. Unsupported binary, submodule and symlink revisions show guidance.
- File History follows one file path through renames; bounded traversal may require an explicit continuation.
- Interactive rebase supports a linear range of 1–200 commits. Use native Git for merge ranges.
- When the native Merge Editor is unavailable, use conflict guidance and native diffs.
- File actions use saved content. Unsaved buffers are not saved-file revisions.
- Other Git tools can change a repository while Git Pro is open. Refresh after external changes or an interrupted operation.

## Large repositories

- Stage, Unstage, Stage All and Unstage All handle more than 5,000 files in consecutive groups of 5,000. If a later group fails, the error says which groups were already applied; refresh and review before retrying. Discard reviews at most 5,000 files at a time.
- In History Details, containing refs load after the rest of the details. In very large repositories they can take a while or be reported as unavailable.
- A commit whose file list or message exceeds the read bound shows its metadata with a note to use native Git.
- The Changes view sends every changed row when status changes, so tens of thousands of changes make it slower to update.

Auto-fetch, active-line blame and CodeLens are off by default. Destructive actions require a reviewed confirmation. Canceling a Git operation does not imply that earlier changes were rolled back.

[Getting started](GETTING_STARTED.md) · [Workflows](WORKFLOWS.md) · [Settings](SETTINGS.md)
