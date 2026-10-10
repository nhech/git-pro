const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const file = path.resolve(process.argv[2] || 'artifacts/git-pro-0.1.0.vsix');
const output = path.resolve(process.argv[3] || 'artifacts/package-check.json');
const guides = ['GETTING_STARTED.md', 'WORKFLOWS.md', 'SETTINGS.md', 'RELEASE_STATUS.md'];
const docs = ['docs/GIT_API_PROVENANCE.md', ...guides.map(name => `docs/user-guide/${name}`)];
const images = ['docs/images/changes-and-commit.jpg', 'docs/images/file-actions.jpg', 'docs/images/history.jpg'];
const required = ['readme.md', 'changelog.md', 'dist/extension.js', 'package.json', 'LICENSE.txt', 'package.nls.json', 'THIRD_PARTY_NOTICES.txt', ...docs, ...images,
  'media/icon.png', 'media/codicons/codicon.css', 'media/codicons/codicon.ttf', 'media/git-pro.svg', 'media/changes.js', 'media/changes.css', 'media/commit.js', 'media/commit.css',
  'media/history.js', 'media/history.css', 'media/rebase.js', 'media/rebase.css',
  'media/helpers/preserve-editor.cjs', 'media/helpers/rebase-editor.cjs',
  ...['play', 'add', 'edit', 'debug-step-over', 'circle-slash'].map(name => `media/operation-icons/${name}.svg`)];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Validate the file destinations used by the shipped Markdown dialect.
// Heading fragments are intentionally not certified by this file-closure check.
function checkLinks(name, bytes, names) {
  const markdown = bytes.toString('utf8').replace(/```[^\n]*\n[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const targets = [...markdown.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)].map(m => m[1] || m[2]);
  for (const m of markdown.matchAll(/^\s*\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) targets.push(m[1] || m[2]);
  const checked = [];
  for (const target of targets) {
    if (/^(?:https?:|mailto:)/i.test(target) || target.startsWith('#')) continue;
    const destination = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    if (!destination || /^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('/') || destination.includes('\\')) throw new Error(`Unsafe documentation link: ${name} -> ${target}`);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), destination));
    if (!resolved.startsWith('extension/')) throw new Error(`Documentation link escapes package: ${name} -> ${target}`);
    if (!names.has(resolved)) throw new Error(`Missing documentation destination: ${name} -> ${target}`);
    checked.push({ from: name, target, resolved });
  }
  return checked;
}

async function verify() {
  const contents = await new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const names = new Set(), folded = new Set(), metadata = new Map();
      let total = 0, failed = false;
      const fail = err => { if (!failed) { failed = true; zip.close(); reject(err); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!failed) resolve({ names, metadata, total }); });
      zip.on('entry', entry => {
        try {
          const name = entry.fileName;
          if (names.has(name) || folded.has(name.toLowerCase()) || name.includes('..') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || entry.uncompressedSize > 10 * 1024 * 1024 || names.size >= 105) throw new Error('Invalid bounded archive entry.');
          if (name !== 'extension.vsixmanifest' && name !== '[Content_Types].xml' && !name.startsWith('extension/')) throw new Error(`Unexpected packaged path: ${name}`);
          if (/^extension\/(?:src|test|scripts|node_modules|designs|artifacts|\.npm-cache|\.vscode-test)\//.test(name) || name.endsWith('.map')) throw new Error(`Unexpected packaged path: ${name}`);
          if (name.startsWith('extension/docs/') && ![...docs, ...images].includes(name.slice(10))) throw new Error(`Unexpected packaged document: ${name}`);
          if (!['extension.vsixmanifest', '[Content_Types].xml', ...required.map(asset => 'extension/' + asset)].includes(name)) throw new Error(`Unexpected packaged path: ${name}`);
          if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw new Error(`Packaged symlink is unsupported: ${name}`);
          total += entry.uncompressedSize;
          if (total > 20 * 1024 * 1024) throw new Error('Archive exceeds package limit.');
          names.add(name); folded.add(name.toLowerCase());
          if (['extension/package.json', 'extension/LICENSE.txt', 'extension/media/icon.png'].includes(name) || name.endsWith('.md') || images.includes(name.slice(10))) {
            if (entry.uncompressedSize > 1024 * 1024) throw new Error('Package text exceeds verification limit.');
            zip.openReadStream(entry, (streamError, stream) => {
              if (streamError) return fail(streamError);
              const chunks = []; let size = 0;
              stream.on('error', fail);
              stream.on('data', chunk => {
                size += chunk.length;
                if (size > 1024 * 1024) { stream.destroy(); fail(new Error('Package text exceeds verification limit.')); return; }
                chunks.push(chunk);
              });
              stream.on('end', () => { if (!failed) { metadata.set(name, Buffer.concat(chunks)); zip.readEntry(); } });
            });
          } else zip.readEntry();
        } catch (err) { fail(err); }
      });
      zip.readEntry();
    });
  });
  const { names, metadata, total } = contents;
  for (const name of required) if (!names.has('extension/' + name)) throw new Error(`Missing package asset: ${name}`);
  const manifest = JSON.parse(metadata.get('extension/package.json').toString('utf8'));
  const license = metadata.get('extension/LICENSE.txt').toString('utf8');
  if (manifest.private !== true || manifest.license !== 'MIT' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version || '') || !license.startsWith('MIT License\n\nCopyright (c) 2026 longtd\n')) throw new Error('Packaged manifest and MIT license attribution do not match.');
  const links = [...metadata].filter(([name]) => name.endsWith('.md')).flatMap(([name, bytes]) => checkLinks(name, bytes, names));
  const imageChecks = images.map(name => {
    const bytes = metadata.get('extension/' + name);
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error(`Invalid documentation JPEG: ${name}`);
    const original = fs.readFileSync(path.resolve(__dirname, '..', name));
    if (!bytes.equals(original)) throw new Error(`Documentation image differs from source: ${name}`);
    return { name, bytes: bytes.length, sha256: sha256(bytes), sourceIdentical: true };
  });
  // The Marketplace refuses SVG extension icons; it needs a PNG of at least 128 × 128 pixels.
  const icon = metadata.get('extension/media/icon.png');
  if (manifest.icon !== 'media/icon.png' || !icon || !icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || icon.readUInt32BE(12) !== 0x49484452) throw new Error('Extension icon must be the packaged PNG media/icon.png.');
  const iconSize = { width: icon.readUInt32BE(16), height: icon.readUInt32BE(20) };
  if (iconSize.width < 128 || iconSize.height < 128 || iconSize.width !== iconSize.height) throw new Error(`Extension icon must be square and at least 128 px: ${iconSize.width}x${iconSize.height}.`);
  if (!icon.equals(fs.readFileSync(path.resolve(__dirname, '..', 'media', 'icon.png')))) throw new Error('Packaged icon differs from source.');
  const readme = metadata.get('extension/readme.md').toString('utf8');
  const imageLinks = [...readme.matchAll(/!\[[^\]\n]*\]\(([^\s)]+)\)/g)].map(match => match[1]);
  const marketplaceImages = images.map(name => `https://raw.githubusercontent.com/nhech/git-pro/main/${name}`);
  const rewritten = imageLinks.some(link => /^https:/i.test(link));
  if (imageLinks.length !== images.length || imageLinks.some((link, index) => link !== (rewritten ? marketplaceImages[index] : images[index]))) throw new Error('README screenshots do not match the reviewed image list.');
  const result = { passed: true, file: path.basename(file), files: names.size, uncompressedBytes: total, bytes: fs.statSync(file).size,
    sha256: sha256(fs.readFileSync(file)), documents: [...metadata.keys()].filter(name => name.endsWith('.md')), localFileLinks: links, images: imageChecks, icon: { ...iconSize, bytes: icon.length, sha256: sha256(icon) }, marketplaceImagesRewrittenToHttps: rewritten, headingFragmentsChecked: false };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, localFileLinks: links.length }));
}
verify().catch(error => { console.error(error.message); process.exitCode = 1; });
