// Renders site/og/og-card.html to site/og.jpg (1200 × 630) with a local Chromium-based browser in headless mode.
// JPEG keeps the card well under the ~300 KB limit some link previews (for example WhatsApp) apply.
// No dependencies. Usage: node scripts/render-og.cjs
// OG_BROWSER overrides the browser executable; OG_PROFILE_DIR is where the throwaway browser profile is created.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const WIDTH = 1200, HEIGHT = 630, MAX_BYTES = 300 * 1024;
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'site', 'og', 'og-card.html');
const output = path.join(root, 'site', 'og.jpg');
const candidates = [
  process.env.OG_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);
const browser = candidates.find(file => fs.existsSync(file));
if (!browser) throw new Error('No Chromium-based browser found. Set OG_BROWSER to its executable.');

// Width and height from the first JPEG start-of-frame marker, or null.
function jpegSize(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const profile = fs.mkdtempSync(path.join(process.env.OG_PROFILE_DIR || os.tmpdir(), 'git-pro-og-'));
const shot = path.join(profile, 'og.jpeg'); // the browser picks the image format from the extension
try {
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`, '--virtual-time-budget=3000', `--screenshot=${shot}`, pathToFileURL(source).href
  ], { stdio: 'inherit', timeout: 60000 });
  // Some launchers return before the headless child has written the file: wait until its size is stable.
  let size = -1;
  for (let waited = 0; waited < 30000; waited += 250) {
    const current = fs.existsSync(shot) ? fs.statSync(shot).size : -1;
    if (current > 0 && current === size) break;
    size = current;
    sleep(250);
  }
  if (size <= 0) throw new Error('The browser did not write a screenshot.');
  fs.copyFileSync(shot, output);
} finally {
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
  catch { console.warn(`Could not remove the temporary browser profile ${profile}; delete it manually.`); }
}

const jpeg = fs.readFileSync(output);
const dimensions = jpegSize(jpeg);
if (!dimensions || dimensions.width !== WIDTH || dimensions.height !== HEIGHT) throw new Error(`site/og.jpg must be a ${WIDTH}x${HEIGHT} JPEG, got ${dimensions ? `${dimensions.width}x${dimensions.height}` : 'another format'}.`);
if (jpeg.length > MAX_BYTES) throw new Error(`site/og.jpg is ${jpeg.length} bytes; keep it under ${MAX_BYTES} bytes for link previews.`);
console.log(JSON.stringify({ output: 'site/og.jpg', ...dimensions, bytes: jpeg.length }));
