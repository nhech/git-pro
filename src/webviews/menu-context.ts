import { validateOid } from '../security/refs';

/**
 * Native context menus for webviews. An element carries `data-vscode-context='{"webviewSection":"commit","session":"…","oid":"…"}'`; VS Code builds the menu
 * from `contributes.menus["webview/context"]` and runs the chosen command with that object, merged over the ancestors' contexts, plus `webview` (the panel's
 * view type or the view's id). The renderer is not trusted, so a command never acts on what it says directly: the value is parsed into plain bounded data,
 * the session must belong to a live panel, and that panel confirms it showed the commit or the row.
 * No `vscode` import: unit tests load this module as it is.
 */
export type MenuValue = string | number | boolean;
export interface MenuContext {
  readonly webview: string;
  readonly session: string;
  /** The `webviewSection` of the clicked element, such as "commit" or "file". */
  readonly section: string;
  /** Every other plain value the element carried. */
  readonly values: Readonly<Record<string, MenuValue>>;
}
/** What a panel offers to the commands behind its menus; each method answers only for what that panel really shows. */
export interface MenuPanel {
  /** Set by panels whose rows are commits of one repository (History, Compare, Conflicts); the commit menu commands need it. */
  readonly repositoryId?: string;
  knowsCommit?(oid: string): boolean;
  /** Panel-specific actions (open a diff, select a row…); `context` is already parsed. */
  handle?(action: string, context: MenuContext): Promise<void> | void;
}
const keyPattern = /^[A-Za-z][A-Za-z0-9]{0,31}$/, sessionPattern = /^[A-Za-z0-9-]{8,64}$/, sectionPattern = /^[a-z][a-z-]{0,31}$/, webviewPattern = /^[A-Za-z][A-Za-z0-9.-]{0,63}$/;
const reserved = new Set(['webview', 'webviewSection', 'session', 'preventDefaultContextMenuItems']);
const unusable = () => new Error('Use this command from a Git Pro panel menu.');

export function parseMenuContext(argument: unknown): MenuContext {
  if (!argument || typeof argument !== 'object' || Array.isArray(argument)) throw unusable();
  const source = argument as Record<string, unknown>, values: Record<string, MenuValue> = {};
  const { webview, webviewSection: section, session } = source;
  if (typeof webview !== 'string' || !webviewPattern.test(webview) || typeof section !== 'string' || !sectionPattern.test(section) || typeof session !== 'string' || !sessionPattern.test(session)) throw unusable();
  let count = 0;
  for (const key of Object.keys(source)) {
    if (reserved.has(key)) continue;
    const value = source[key];
    if (!keyPattern.test(key) || ++count > 16) throw unusable();
    if (typeof value === 'string') { if (value.length > 2048 || value.includes('\0')) throw unusable(); values[key] = value; }
    else if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw unusable(); values[key] = value; }
    else if (typeof value === 'boolean') values[key] = value;
    else throw unusable();
  }
  return Object.freeze({ webview, session, section, values: Object.freeze(values) });
}

export class MenuRouter {
  private readonly panels = new Map<string, MenuPanel>();
  private static key(webview: string, session: string): string { return `${webview}\0${session}`; }
  /** A panel registers its session while it is open and disposes the registration with the panel. */
  register(webview: string, session: string, panel: MenuPanel): { dispose(): void } {
    const key = MenuRouter.key(webview, session);
    this.panels.set(key, panel);
    return { dispose: () => { if (this.panels.get(key) === panel) this.panels.delete(key); } };
  }
  /** The live panel and the parsed context behind a menu command's argument; throws for anything else. `webviews` limits which panels may use the command and `section` which kind of element it is for. */
  resolve(argument: unknown, webviews?: readonly string[], section?: string): { readonly panel: MenuPanel; readonly context: MenuContext } {
    const context = parseMenuContext(argument);
    if (webviews && !webviews.includes(context.webview) || section !== undefined && context.section !== section) throw unusable();
    const panel = this.panels.get(MenuRouter.key(context.webview, context.session));
    if (!panel) throw new Error('This panel is closed. Open it again to use its menu.');
    return { panel, context };
  }
  /** A commit menu command: the panel, its repository and a full commit ID that the panel confirms it shows. */
  commit(argument: unknown, webviews?: readonly string[]): { readonly panel: MenuPanel; readonly context: MenuContext; readonly repositoryId: string; readonly oid: string } {
    const { panel, context } = this.resolve(argument, webviews, 'commit'), value = context.values.oid;
    if (typeof value !== 'string') throw unusable();
    const oid = validateOid(value).toLowerCase();
    if (panel.repositoryId === undefined) throw unusable();
    if (!panel.knowsCommit?.(oid)) throw new Error('That commit is no longer shown in this panel. Refresh and try again.');
    return { panel, context, repositoryId: panel.repositoryId, oid };
  }
}
