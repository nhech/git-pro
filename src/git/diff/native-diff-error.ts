/**
 * A change that Git Pro's own text diff cannot show: a binary file, one past the size limit, a symlink or submodule, text that is not UTF-8. VS Code's own Source Control can
 * show these, so the command that asked for the diff opens it there instead of failing. No `vscode` import: unit tests load this module as it is.
 */
export class NativeDiffError extends Error {
  constructor(message: string) { super(message); this.name = 'NativeDiffError'; }
}
