import * as vscode from 'vscode';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { ExtensionDiagnostics } from '../../src/extension';

/**
 * The scripted tour behind the screenshots of the README and the landing page (scripts/screenshots.cjs). It runs in a real VS Code on a virtual display with the demo
 * repository of test/fixtures/demo-repository.ts, drives the UI the way a person would (commands, the keyboard, clicks through xdotool) and captures the display with
 * ImageMagick. Names starting with `_` are probes for tuning the tour: they stay in .shots/ and are not turned into screenshots.
 *
 * Positions are in pixels of the 2160 x 1350 display (the window renders at a device scale of 2, so VS Code sees 1080 x 675).
 */
const outDir = process.env.GIT_PRO_SHOTS_OUT ?? '/shots';
const only = process.env.GIT_PRO_SHOTS_ONLY?.split(',').filter(Boolean);
const scenario = process.env.GIT_PRO_SHOTS_SCENARIO ?? 'project';
const size = { width: 2160, height: 1350 };
/** The window of VS Code is taller than the picture by the height of its title bar (30 points at a device scale of 2), which is cut off the top. */
const trim = Number(process.env.GIT_PRO_SHOTS_TRIM ?? 60);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const tool = (command: string, ...args: (string | number)[]) => spawnSync(command, args.map(String), { encoding: 'utf8' });
const must = (command: string, ...args: (string | number)[]) => { const result = tool(command, ...args); if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr || result.stdout}`); return result.stdout; };
const exec = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(id, ...args);
const allTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);

const pointer = {
  /** Positions are those of the picture; the window starts `trim` pixels above it. */
  move: (x: number, y: number) => must('xdotool', 'mousemove', '--sync', x, y + trim),
  click: async (x: number, y: number, button = 1) => { pointer.move(x, y); await sleep(150); must('xdotool', 'click', button); await sleep(450); },
  drag: async (fromX: number, fromY: number, toX: number, toY: number) => {
    pointer.move(fromX, fromY); await sleep(250); must('xdotool', 'mousedown', 1); await sleep(250);
    pointer.move(toX, toY); await sleep(350); must('xdotool', 'mouseup', 1); await sleep(600);
  },
  /** Pushes the pointer to where it hovers over nothing in particular, so no row, tab or button looks hovered. */
  park: () => pointer.move(size.width - 40, size.height - 40),
};
const keys = async (...names: string[]) => { for (const name of names) { must('xdotool', 'key', '--delay', 40, name); await sleep(200); } };
const typeText = async (text: string) => { must('xdotool', 'type', '--delay', 35, '--', text); await sleep(400); };

async function waitFor<T>(probe: () => T | undefined | false, what: string, timeout = 20_000): Promise<T> {
  for (const start = Date.now(); ;) {
    const value = probe(); if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}; tabs: ${allTabs().map(tab => tab.label).join(', ')}`);
    await sleep(100);
  }
}
/** A tab that is not drawn yet shows as flat grey (#808080); wait until the middle of the window is something else. With too small a /dev/shm the page never gets drawn: the container is started with --shm-size. */
async function painted(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = tool('import', '-window', 'root', '-crop', `1x1+${size.width / 2}+${size.height / 2 + trim}`, '+repage', '-depth', 8, 'txt:-').stdout;
    if (probe && !probe.includes('(128,128,128)')) return;
    await sleep(500);
  }
  throw new Error('The tab was not drawn within 30 seconds.');
}
const webviewTab = async (label: string) => { const tab = await waitFor(() => allTabs().find(tab => tab.input instanceof vscode.TabInputWebview && tab.label.includes(label)), `the ${label} tab`); await painted(); return tab; };

/** The virtual display has no window manager: size and place the VS Code window by hand. The picture is the window without its title bar. */
async function fitWindow(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const ids = tool('xdotool', 'search', '--onlyvisible', '--class', 'code').stdout.split('\n').filter(Boolean);
    if (ids.length) { for (const id of ids) tool('xdotool', 'windowmove', id, 0, 0, 'windowsize', id, size.width, size.height + trim); await sleep(2000); return; }
    await sleep(250);
  }
  throw new Error('No VS Code window on the display.');
}

/** The toast about running as root is VS Code's, and appears a moment after start: clear everything, then wait for what could still come. */
async function clearToasts(): Promise<void> { await exec('notifications.clearAll'); await sleep(600); }

async function capture(name: string, quick = false): Promise<void> {
  if (only && !name.startsWith('_') && !only.includes(name)) return;
  if (!quick) await clearToasts();
  const file = path.join(outDir, `${name}.png`);
  // A probe named _raw… keeps the title bar, to measure how much of it to cut off.
  must('import', '-window', 'root', ...(name.startsWith('_raw') ? [] : ['-crop', `${size.width}x${size.height}+0+${trim}`, '+repage']), file);
  console.log(`captured ${name}`);
}

/** Opens the Git Pro side bar and tidies the rest of the window: nothing but the side bar, the editors and the status bar. */
async function arrange(): Promise<void> {
  await exec('workbench.action.closePanel'); await exec('workbench.action.closeAuxiliaryBar');
  await exec('workbench.action.closeAllEditors');
  await exec('workbench.view.extension.gitPro');
  await sleep(1500); await clearToasts();
}

/** Where things are in the 2160 x 1350 picture, with the side bar widened by dragging its edge. Look at the probes (`_*.png` in .shots/) after any change of layout. */
const at = {
  sash: { x: 636, y: 700 }, sashTo: 760,
  message: { x: 396, y: 227 },
  rows: { cart: { x: 330, y: 767 }, feature: { x: 734, y: 595 } },
  /** Empty editor space: a click there puts the focus in the editor, and the pointer rests there. */
  quiet: { x: 1500, y: 1000 },
};

const projectRoot = process.env.GIT_PRO_SHOTS_PROJECT ?? '';
const git = (...args: string[]) => must('git', '-C', projectRoot, ...args).trim();

/** Which shots this run takes: all of them, or the ones named with --only (probes, whose names start with _, are always taken). */
const wanted = (...names: string[]) => !only || names.some(name => only.includes(name));

async function project(api: ExtensionDiagnostics): Promise<void> {
  if (wanted('changes-and-commit', 'branches')) {
    await arrange();
    await capture('_raw');
    await pointer.drag(at.sash.x, at.sash.y, at.sashTo, at.sash.y);

    // Changes and commit: a message in the box, a changed file open in a diff, its row hovered.
    await pointer.click(at.message.x, at.message.y); await typeText('Add the user email and a first cart test');
    await pointer.click(at.rows.cart.x, at.rows.cart.y); await sleep(1500);
    await pointer.click(at.quiet.x, at.quiet.y);
    pointer.move(at.rows.cart.x, at.rows.cart.y); await sleep(600);
    await capture('changes-and-commit');

    // Branches: how far each branch is from its upstream, and its right-click menu.
    await exec('gitPro.branchesView.focus'); await sleep(1200);
    await pointer.click(183, 446); await sleep(800); // collapses Changes
    await pointer.click(143, 551); await sleep(1200); // opens the Local group
    await pointer.click(at.rows.feature.x, at.rows.feature.y, 3); await sleep(1000);
    await capture('branches');
    await keys('Escape');
  }

  // History and Compare get the whole window.
  if (wanted('history')) {
    await arrange(); await exec('workbench.action.closeSidebar'); await sleep(800);
    await exec('gitPro.history'); await webviewTab('History'); await sleep(2500);
    await pointer.click(248, 98); await sleep(800);
    await pointer.click(454, 396); await sleep(2500); pointer.move(at.quiet.x, at.quiet.y);
    await capture('history');
  }

  if (wanted('compare')) {
    await arrange(); await exec('workbench.action.closeSidebar'); await sleep(800);
    const branch = 'feature/checkout', ref = `refs/heads/${branch}`;
    await exec('gitPro.compareWithCurrent', { kind: 'branch', repositoryId: api.activeRepository(), branch: { name: branch, ref, oid: git('rev-parse', ref), remote: false, upstream: `origin/${branch}`, worktree: '' } });
    await webviewTab('Compare'); await sleep(2500);
    // Two of the three files are marked as viewed; the diff of the one that was opened last appears beside the list.
    await pointer.click(1325, 446); await sleep(2000); await keys('v'); await sleep(800);
    // The list is stacked above the files while the diff is beside it: the second file is lower.
    await pointer.click(306, 953); await sleep(2000); await keys('v'); await sleep(800);
    await exec('workbench.action.closeEditorsInOtherGroups'); await sleep(3000);
    await clearToasts();
    // A commit row, hovered: Copy Revision Number and Show in History. Captured at once, before the browser's tooltip for the row appears.
    pointer.move(486, 339); await sleep(250);
    await capture('compare', true);
  }
}

/** The same Changes view in the light theme: the right-click menu of the row of a changed file. */
async function light(): Promise<void> {
  await arrange();
  await pointer.drag(at.sash.x, at.sash.y, at.sashTo, at.sash.y);
  await pointer.click(at.message.x, at.message.y); await typeText('Add the user email and a first cart test');
  await pointer.click(at.rows.cart.x, at.rows.cart.y); await sleep(1500);
  await pointer.click(at.rows.cart.x, at.rows.cart.y, 3); await sleep(1000);
  await capture('file-actions');
  await keys('Escape');
}

async function merging(): Promise<void> {
  await arrange(); await exec('workbench.action.closeSidebar'); await sleep(800);
  await exec('gitPro.conflicts.open');
  await webviewTab('Conflicts');
  await sleep(2500); await pointer.click(274, 299); await keys('ctrl+a'); pointer.move(at.quiet.x, at.quiet.y); await sleep(500);
  await capture('conflicts');
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionDiagnostics>('longtd.git-pro');
  if (!extension) throw new Error('Git Pro is not installed in the test host.');
  const api = await extension.activate();
  await waitFor(() => api.repositories() === 1 && api.activeSnapshot()?.changes.length, 'the repository and its changes');
  await fitWindow();
  if (scenario === 'merging') await merging(); else if (scenario === 'light') await light(); else await project(api);
}
