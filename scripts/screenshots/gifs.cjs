// Joins the frames of the animated tours (test/extension/screenshots.ts, gif-<tour>-<number>-h<hold>-x<x>y<y>.png) into <tour>.gif. The capture does not show the pointer, so it is drawn
// where it was; a frame is held for `hold` beats. Flat interface colours compress best without dithering. Used by inner.cjs; it can also run alone on frames that are already taken:
//   docker run --rm -v "$PWD/.shots:/shots" -v "$PWD/docs/images:/out" -v "$PWD/scripts/screenshots:/s:ro" git-pro-screenshots node /s/gifs.cjs /shots /out
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const beat = 90, width = 1400, colors = 128;
async function buildGifs(frames, destination) {
  const magick = args => { const result = spawnSync('convert', args, { encoding: 'utf8' }); if (result.status !== 0) throw new Error(`convert ${args.slice(0, 6).join(' ')}…: ${result.stderr}`); };
  const names = (await fs.readdir(frames)).filter(name => /^gif-[a-z-]+-\d+-h\d+-x\d+y\d+\.png$/.test(name)).sort(), tours = new Map();
  for (const name of names) { const tour = /^gif-([a-z-]+)-\d+-h/.exec(name)[1]; tours.set(tour, [...(tours.get(tour) ?? []), name]); }
  for (const [tour, files] of tours) {
    const args = [];
    for (const file of files) {
      const [, hold, x, y] = /-h(\d+)-x(\d+)y(\d+)\.png$/.exec(file).map(Number);
      const arrow = [[0, 0], [0, 36], [9, 28], [16, 43], [23, 40], [16, 26], [28, 26]].map(([dx, dy]) => `${x + dx},${y + dy}`).join(' ');
      args.push('-delay', String(hold * beat), '(', path.join(frames, file), '-fill', 'white', '-stroke', 'black', '-strokewidth', '2', '-draw', `polygon ${arrow}`, '-resize', `${width}x`, ')');
    }
    magick([...args, '-loop', '0', '+dither', '-colors', String(colors), '-layers', 'OptimizeTransparency', path.join(destination, `${tour}.gif`)]);
    console.log(`${tour}.gif (${files.length} frames)`);
  }
}
module.exports = { buildGifs };
if (require.main === module) buildGifs(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
