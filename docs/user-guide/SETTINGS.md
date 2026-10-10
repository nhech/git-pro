# Settings

Open VS Code Settings and search for `gitPro`. Resource settings apply to the selected repository; machine settings apply to the host running Git Pro. Defaults, types, ranges and scopes below match the extension manifest.

| Setting | Default | Allowed values | Scope | Behavior |
|---|---|---|---|---|
| `gitPro.logging.level` | `"info"` | off, error, info, debug | window | Git Pro operation metadata logging; credentials are always redacted. |
| `gitPro.commit.confirmBeforeCommit` | `false` | true / false | resource | Confirm each staged-only commit. |
| `gitPro.confirmBeforePush` | `false` | true / false | resource | Confirm pushes to the configured upstream. |
| `gitPro.pull.strategy` | `"ff-only"` | ff-only, merge, rebase | resource | Pull strategy. Divergence requires an explicit merge or rebase choice. |
| `gitPro.commit.subjectLimit` | `72` | 20–200 | resource | Commit subject warning length. |
| `gitPro.commit.messageHistoryLimit` | `20` | 0–100 | resource | Maximum messages stored per repository in workspace state. |
| `gitPro.autoFetch.enabled` | `false` | true / false | resource | Periodically fetch repository remotes. Authentication is handled by built-in Git. |
| `gitPro.autoFetch.intervalMinutes` | `5` | 1–60 | resource | Auto-fetch interval with exponential backoff after failures. |
| `gitPro.blame.enabled` | `false` | true / false | resource | Show author and commit for the active line. Dirty editor buffers are not attributed from disk. |
| `gitPro.codeLens.enabled` | `false` | true / false | resource | Show a read-only File History CodeLens on saved files in open trusted repositories. No automatic Git read. |
| `gitPro.blame.delay` | `250` | 100–2000 | resource | Delay in milliseconds before reading active-line blame. Dirty buffers never receive disk attribution. |
| `gitPro.graph.pageSize` | `100` | 25–100 | resource | Commits read per history page; loaded graph remains bounded at 2000 commits. |
| `gitPro.graph.showRemoteBranches` | `true` | true / false | resource | Include remote branches in the native history reference chooser. Explicit refs entered in the panel remain available. |
| `gitPro.changes.groupBy` | `"status"` | status, folder | resource | Display paths directly or as folders within each staged/working/untracked/conflict group. |
| `gitPro.cli.readTimeout` | `15` | 5–600 | machine | Local CLI read timeout in seconds. Built-in Git API requests use their own host behavior. |
| `gitPro.cli.timeout` | `120` | 15–600 | machine | Local CLI mutation timeout in seconds. Interruption may leave Git state changed; inspect before retrying. |
| `gitPro.cli.networkTimeout` | `180` | 30–900 | machine | Explicit CLI remote operation timeout in seconds. Does not cancel built-in Git API fetch/push. |

Auto-fetch, active-line blame and CodeLens are opt-in. A CodeLens provider does not read history until you open File History. Dirty buffers suppress on-disk blame. Auto-fetch uses per-repository schedules and backoff; disabling or disposing stops future calls while an already running built-in Git API operation settles.

CLI timeouts are seconds and do not control exported built-in Git API calls. There is no setting to disable destructive confirmations or exact force-push lease review. Ordinary commit/push confirmation settings do not remove amend/Skip Hooks review.

The subject limit warns; it does not truncate the message. A message-history limit of zero hides the history and stops retaining new entries. History page size does not raise the 2,000 loaded-commit cap. Remote-branch visibility affects the native scope chooser; an explicit panel ref selection is retained.

No global keybindings are contributed. Assign existing Git Pro commands in VS Code Keyboard Shortcuts; Compare is reached from History.

Git Pro follows your colour theme. Its one accent colour, used for HEAD and the current branch in History and for an in-progress rebase, is the theme colour `gitPro.accent`; change it with `workbench.colorCustomizations`, for example `"gitPro.accent": "#3794ff"`.

[Getting started](GETTING_STARTED.md) · [Workflows](WORKFLOWS.md) · [Compatibility](RELEASE_STATUS.md)
