// Runs in the screenshot image under xvfb (see run.sh): builds the demo repositories, runs test/extension/screenshots.js in VS Code once per scenario,
// and turns the raw PNGs of /shots into the JPEGs of docs/images and site/img.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runTests } = require('@vscode/test-electron');

const work = '/work', out = '/shots', version = process.env.GIT_PRO_SHOTS_VERSION || '1.141.0';
// One VS Code per scenario: the project in the dark theme, the same project in the light theme, and the clone that stopped in the middle of a merge.
const scenarios = [
  { name: 'project', workspace: 'project', shots: ['changes-and-commit', 'branches', 'history', 'compare'] },
  { name: 'light', workspace: 'project', shots: ['file-actions'], settings: { 'workbench.colorTheme': 'Default Light Modern' } },
  { name: 'merging', workspace: 'merging', shots: ['conflicts'] },
];

const settings = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'workbench.layoutControl.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.editor.enablePreview': true,
  'window.titleBarStyle': 'custom',
  'window.menuBarVisibility': 'hidden',
  // No tooltips over the row the pointer rests on.
  'workbench.hover.delay': 600000,
  'editor.hover.enabled': false,
  'window.commandCenter': false,
  'window.restoreFullscreen': false,
  'chat.commandCenter.enabled': false,
  'chat.disableAIFeatures': true,
  'editor.minimap.enabled': false,
  'editor.fontFamily': "'Fira Code', monospace",
  'editor.fontSize': 13,
  'editor.fontLigatures': false,
  'editor.renderWhitespace': 'none',
  'editor.stickyScroll.enabled': false,
  'diffEditor.renderSideBySide': true,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.ignoreRecommendations': true,
  'security.workspace.trust.enabled': false,
  'git.autofetch': false,
  'git.openRepositoryInParentFolders': 'never',
  'git.showProgress': false,
};

(async () => {
  const { buildDemoRepositories } = require(path.join(work, '.test-build', 'test', 'fixtures', 'demo-repository.js'));
  const root = await fs.mkdtemp('/tmp/git-pro-shots-');
  const demo = await buildDemoRepositories(root), only = process.env.GIT_PRO_SHOTS_ONLY;
  // /shots is a mount of .shots on the host: clear the old PNGs, keep the directory.
  await fs.mkdir(out, { recursive: true });
  for (const name of await fs.readdir(out)) if (name.endsWith('.png') && (!only || name.startsWith('_'))) await fs.rm(path.join(out, name));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_PRO_SHOTS_OUT: out, GIT_PRO_SHOTS_PROJECT: demo.project };
  for (const scenario of scenarios) {
    if (only && !only.split(',').some(name => scenario.shots.includes(name))) continue;
    const profile = path.join(root, `profile-${scenario.name}`);
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({ ...settings, ...scenario.settings }, null, 2));
    console.log(`=== ${scenario.name}`);
    await runTests({
      version, cachePath: '/cache',
      extensionDevelopmentPath: work,
      extensionTestsPath: path.join(work, '.test-build', 'test', 'extension', 'screenshots.js'),
      extensionTestsEnv: { ...env, GIT_PRO_SHOTS_SCENARIO: scenario.name, ...(only ? { GIT_PRO_SHOTS_ONLY: only } : {}) },
      launchArgs: [demo[scenario.workspace], '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extension', 'github.copilot', '--disable-extension', 'github.copilot-chat',
        '--user-data-dir', profile, '--extensions-dir', path.join(root, `extensions-${scenario.name}`), '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=2'],
    });
  }

  // docs/images keeps the 2160 pixel originals; site/img the smaller sizes for srcset.
  await fs.mkdir('/out/docs', { recursive: true }); await fs.mkdir('/out/site', { recursive: true });
  const magick = (args) => { const result = spawnSync('convert', args, { encoding: 'utf8' }); if (result.status !== 0) throw new Error(`convert ${args.join(' ')}: ${result.stderr}`); };
  // Names starting with an underscore are probes for tuning the tour; they stay where they are.
  for (const file of (await fs.readdir(out)).filter(name => name.endsWith('.png') && !name.startsWith('_')).sort()) {
    const name = file.replace(/\.png$/, ''), source = path.join(out, file);
    magick([source, '-strip', '-interlace', 'Plane', '-quality', '90', `/out/docs/${name}.jpg`]);
    for (const width of [1080, 1600]) magick([source, '-resize', `${width}x`, '-strip', '-interlace', 'Plane', '-quality', '84', `/out/site/${name}-${width}.jpg`]);
    console.log(`${name}.jpg`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
