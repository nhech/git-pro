// Takes the screenshots of the README, the Marketplace page and the landing page, in Docker, so they come out the same on every machine:
//   npm run screenshots                    builds, then writes docs/images/*.jpg (2160 x 1350) and site/img/*-1080.jpg and *-1600.jpg
//   npm run screenshots -- --skip-build    when dist/ and .test-build/ are already current
//   npm run screenshots -- --only=compare  takes only those shots (comma separated; probes, which start with _, are always taken)
// A virtual display runs the extension in a real VS Code with the demo repositories of test/fixtures/demo-repository.ts; the shots are scripted in
// test/extension/screenshots.ts and the container side is scripts/screenshots/. Needs Docker; the first run downloads VS Code into a volume.
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.error}`);
};
// VS Code in a container without a desktop session logs a lot about D-Bus; none of it matters here.
const noise = /dbus|org\.freedesktop|address type \(examples|object_path=|^\[\d+:\d+\/\d+\.\d+:/;
const quiet = stream => { let rest = ''; return chunk => { const lines = (rest + chunk).split('\n'); rest = lines.pop(); for (const line of lines) if (!noise.test(line)) stream.write(`${line}\n`); }; };

async function main() {
  if (!process.argv.includes('--skip-build')) { run('npm run build', [], { shell: true }); run('npm run test:compile', [], { shell: true }); }
  run('docker', ['build', '-q', '-t', 'git-pro-screenshots', path.join(root, 'scripts', 'screenshots')], { stdio: ['inherit', 'ignore', 'inherit'] });
  const only = process.argv.find(argument => argument.startsWith('--only='))?.slice('--only='.length);
  const child = spawn('docker', ['run', '--rm', '--init', '--shm-size=2g',
    '-v', `${root}:/src:ro`, '-v', `${path.join(root, 'docs', 'images')}:/out/docs`, '-v', `${path.join(root, 'site', 'img')}:/out/site`,
    '-v', 'git-pro-screenshots-vscode:/cache', '-v', `${path.join(root, '.shots')}:/shots`,
    ...(only ? ['-e', `GIT_PRO_SHOTS_ONLY=${only}`] : []),
    'git-pro-screenshots', 'bash', '/src/scripts/screenshots/run.sh'], { cwd: root });
  child.stdout.setEncoding('utf8').on('data', quiet(process.stdout)); child.stderr.setEncoding('utf8').on('data', quiet(process.stderr));
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) throw new Error(`The screenshot container exited ${code}.`);
}

main().catch(error => { console.error(String(error.message ?? error)); process.exitCode = 1; });
