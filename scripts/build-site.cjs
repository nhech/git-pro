// Builds the landing page in site/ into site-dist/ and validates the result. No dependencies.
// Usage: node scripts/build-site.cjs  (prints a JSON summary and exits 1 on any failure)
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// The VS Code Marketplace listing. Change it here only: pages use the {{MARKETPLACE_URL}} placeholder.
const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=longtd.git-pro';
// Set to true once the listing is live: the build then drops every <!-- unlisted -->...<!-- /unlisted -->
// block (the "not live yet" notes). While false, only the markers are removed and the notes stay.
const MARKETPLACE_LISTED = false;
const UNLISTED_BLOCK = /<!-- unlisted -->([\s\S]*?)<!-- \/unlisted -->/g;
const SITE_URL = 'https://git-pro.longtd.me/';
const OG_IMAGE = { file: 'og.jpg', type: 'image/jpeg', width: 1200, height: 630 };

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'site');
const output = path.join(root, 'site-dist');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const placeholders = { MARKETPLACE_URL, VERSION: version };
const notDeployed = new Set(['og', 'deploy', 'README.md']); // top-level entries of site/ that stay source-only
const screenshots = ['changes-and-commit', 'file-actions', 'history'];
const templated = new Set(['.html', '.xml', '.txt', '.webmanifest']);
const textTypes = new Set([...templated, '.css', '.js', '.svg', '.json']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const errors = [];
const fail = message => { errors.push(message); };
const counts = { localReferences: 0, fragments: 0, externalLinks: 0, images: 0, cssUrls: 0, manifestIcons: 0, sitemapUrls: 0, jsonLd: 0 };

function walk(directory, base = directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${path.relative(root, full)}`);
    if (entry.isDirectory()) found.push(...walk(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found.sort();
}

// ---------- PNG helpers (favicon-32.png is box-filtered from media/icon.png) ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG file.');
  let header = null, offset = 8;
  const data = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: chunk.readUInt32BE(0), height: chunk.readUInt32BE(4), depth: chunk[8], colorType: chunk[9], interlace: chunk[12] };
    else if (type === 'IDAT') data.push(chunk);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  if (!header || header.depth !== 8 || header.colorType !== 6 || header.interlace !== 0) throw new Error('Icon must be an 8-bit, non-interlaced RGBA PNG.');
  const { width, height } = header, stride = width * 4, raw = zlib.inflateSync(Buffer.concat(data)), pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0, b = y ? pixels[(y - 1) * stride + x] : 0, c = x >= 4 && y ? pixels[(y - 1) * stride + x - 4] : 0;
      let value = raw[line + x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}.`);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

function downscale({ width, height, pixels }, size) {
  const factor = width / size;
  if (width !== height || !Number.isInteger(factor)) throw new Error(`Cannot box-filter a ${width}x${height} icon to ${size}x${size}.`);
  const result = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, alpha = 0;
    for (let sy = 0; sy < factor; sy++) for (let sx = 0; sx < factor; sx++) {
      const i = ((y * factor + sy) * width + x * factor + sx) * 4, weight = pixels[i + 3];
      r += pixels[i] * weight; g += pixels[i + 1] * weight; b += pixels[i + 2] * weight; alpha += weight;
    }
    const o = (y * size + x) * 4;
    if (alpha) { result[o] = Math.round(r / alpha); result[o + 1] = Math.round(g / alpha); result[o + 2] = Math.round(b / alpha); }
    result[o + 3] = Math.round(alpha / factor ** 2);
  }
  return result;
}

function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function imageSize(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
    return null;
  }
  const viewBox = /<svg\b[^>]*\bviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(bytes.toString('utf8'));
  return viewBox ? { width: Number(viewBox[1]), height: Number(viewBox[2]) } : null;
}

// ---------- Build ----------
function build() {
  for (const [name, value] of Object.entries(placeholders)) {
    if (!/^[\w.:/?=-]+$/.test(value)) throw new Error(`Placeholder ${name} contains characters that would need escaping: ${value}`);
  }
  if (path.basename(output) !== 'site-dist' || path.dirname(output) !== root) throw new Error('Unexpected output directory.');
  fs.rmSync(output, { recursive: true, force: true });

  for (const file of walk(source)) {
    if (notDeployed.has(file.split('/')[0])) continue;
    const from = path.join(source, file), to = path.join(output, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (templated.has(path.extname(file))) {
      const text = fs.readFileSync(from, 'utf8')
        .replace(/\{\{([A-Z_]+)\}\}/g, (match, name) => (name in placeholders ? placeholders[name] : match))
        .replace(UNLISTED_BLOCK, (match, inner) => (MARKETPLACE_LISTED ? '' : inner));
      fs.writeFileSync(to, text);
    } else fs.copyFileSync(from, to);
  }

  const copies = [
    ...screenshots.map(name => [`docs/images/${name}.jpg`, `images/${name}.jpg`]),
    ['media/icon.png', 'icon.png'],
    ['media/icon.png', 'apple-touch-icon.png']
  ];
  for (const [from, to] of copies) {
    fs.mkdirSync(path.dirname(path.join(output, to)), { recursive: true });
    fs.copyFileSync(path.join(root, from), path.join(output, to));
  }
  fs.writeFileSync(path.join(output, 'favicon-32.png'), encodePng(32, 32, downscale(decodePng(fs.readFileSync(path.join(root, 'media', 'icon.png'))), 32)));
}

// ---------- Validation ----------
const decodeEntities = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function parseAttributes(text) {
  const attributes = {};
  for (const match of text.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function parsePage(file) {
  const html = fs.readFileSync(path.join(output, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map(match => ({ attributes: parseAttributes(match[1]), body: match[2] }));
  const markup = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, '$1$3');
  const tags = [...markup.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g)].map(match => ({ name: match[1].toLowerCase(), attributes: parseAttributes(match[2] || '') }));
  const ids = new Set();
  for (const tag of tags) {
    if (tag.attributes.id === undefined) continue;
    if (ids.has(tag.attributes.id)) fail(`${file}: duplicate id "${tag.attributes.id}"`);
    ids.add(tag.attributes.id);
  }
  const title = /<title>([^<]*)<\/title>/i.exec(markup);
  return { file, tags, ids, scripts, title: title ? title[1].trim() : '' };
}

function validate() {
  const files = new Set(walk(output));
  const pages = new Map([...files].filter(file => file.endsWith('.html')).map(file => [file, parsePage(file)]));

  function check(from, reference, { expectHtml = false } = {}) {
    if (/\{\{|\}\}/.test(reference)) return fail(`${from}: unreplaced placeholder in "${reference}"`);
    if (/^javascript:/i.test(reference)) return fail(`${from}: javascript: URL "${reference}"`);
    if (/^(?:mailto:|tel:|data:)/i.test(reference)) return;
    let local = reference;
    if (local.startsWith(SITE_URL)) local = '/' + local.slice(SITE_URL.length);
    else if (/^[a-z][a-z\d+.-]*:/i.test(local) || local.startsWith('//')) {
      counts.externalLinks++;
      if (!/^https:\/\//i.test(local)) fail(`${from}: external URL is not https: "${reference}"`);
      return;
    }
    const hash = local.indexOf('#');
    const fragment = hash >= 0 ? decodeURIComponent(local.slice(hash + 1)) : '';
    let pathname = decodeURIComponent((hash >= 0 ? local.slice(0, hash) : local).split('?')[0]);
    let target = from;
    if (pathname) {
      const directory = pathname.endsWith('/');
      pathname = pathname.startsWith('/') ? pathname.slice(1) : path.posix.join(path.posix.dirname(from), pathname);
      target = path.posix.normalize(pathname || '.');
      if (target === '..' || target.startsWith('../')) return fail(`${from}: "${reference}" points outside site-dist`);
      if (target === '.' || directory) target = path.posix.join(target === '.' ? '' : target, 'index.html');
      else if (!files.has(target) && files.has(`${target}/index.html`)) target = `${target}/index.html`;
    }
    counts.localReferences++;
    if (!files.has(target)) return fail(`${from}: "${reference}" does not resolve to a file in site-dist (${target})`);
    if (expectHtml && !target.endsWith('.html')) fail(`${from}: "${reference}" should point to a page`);
    if (!fragment) return target;
    counts.fragments++;
    if (!pages.has(target)) fail(`${from}: "${reference}" has a fragment but ${target} is not a page`);
    else if (!pages.get(target).ids.has(fragment)) fail(`${from}: "${reference}" fragment #${fragment} has no matching id in ${target}`);
    return target;
  }

  for (const page of pages.values()) {
    const { file, tags } = page;
    const meta = (key, value) => tags.find(tag => tag.name === 'meta' && tag.attributes[key] === value);
    const content = (key, value) => (meta(key, value) || { attributes: {} }).attributes.content;
    const html = tags.find(tag => tag.name === 'html');
    if (!html || !html.attributes.lang) fail(`${file}: <html> needs a lang attribute`);
    const headings = tags.filter(tag => tag.name === 'h1').length;
    if (headings !== 1) fail(`${file}: expected exactly one <h1>, found ${headings}`);

    for (const tag of tags) {
      for (const attribute of ['href', 'src']) if (tag.attributes[attribute] !== undefined && tag.name !== 'base') check(file, tag.attributes[attribute]);
      if (tag.name !== 'img') continue;
      counts.images++;
      const { alt, width, height, src } = tag.attributes;
      if (alt === undefined) fail(`${file}: <img src="${src}"> has no alt attribute`);
      if (!/^\d+$/.test(width || '') || !/^\d+$/.test(height || '')) { fail(`${file}: <img src="${src}"> needs numeric width and height`); continue; }
      if (!src || /^[a-z][a-z\d+.-]*:/i.test(src)) continue;
      const target = src.startsWith('/') ? src.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), src));
      if (!files.has(target)) continue;
      const size = imageSize(path.join(output, target));
      if (size && Math.abs(size.width / size.height - Number(width) / Number(height)) > 0.01) fail(`${file}: <img src="${src}"> width/height ${width}x${height} do not match the ${size.width}x${size.height} image`);
    }

    // Required metadata. Pages marked noindex (404) only need the basics.
    const noindex = /noindex/i.test(content('name', 'robots') || '');
    if (!tags.some(tag => tag.name === 'meta' && tag.attributes.charset)) fail(`${file}: missing <meta charset>`);
    if (!content('name', 'viewport')) fail(`${file}: missing viewport meta`);
    if (!page.title) fail(`${file}: missing <title>`);
    const description = content('name', 'description') || '';
    if (description.length < 50 || description.length > 170) fail(`${file}: meta description should be 50–170 characters (found ${description.length})`);
    if (!meta('name', 'theme-color')) fail(`${file}: missing theme-color meta`);
    if (noindex) continue;

    const canonical = tags.find(tag => tag.name === 'link' && (tag.attributes.rel || '').split(/\s+/).includes('canonical'));
    const expectedUrl = SITE_URL + (file === 'index.html' ? '' : file.replace(/index\.html$/, ''));
    if (!canonical || canonical.attributes.href !== expectedUrl) fail(`${file}: canonical must be ${expectedUrl}`);
    for (const property of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt']) if (!content('property', property)) fail(`${file}: missing ${property}`);
    for (const name of ['twitter:title', 'twitter:description', 'twitter:image']) if (!content('name', name)) fail(`${file}: missing ${name}`);
    if (content('property', 'og:url') !== expectedUrl) fail(`${file}: og:url must be ${expectedUrl}`);
    if (content('name', 'twitter:card') !== 'summary_large_image') fail(`${file}: twitter:card must be summary_large_image`);
    if (content('property', 'og:image:width') !== String(OG_IMAGE.width) || content('property', 'og:image:height') !== String(OG_IMAGE.height)) fail(`${file}: og:image width/height must be ${OG_IMAGE.width}x${OG_IMAGE.height}`);
    if (content('property', 'og:image:type') !== OG_IMAGE.type) fail(`${file}: og:image:type must be ${OG_IMAGE.type}`);
    for (const image of [content('property', 'og:image'), content('name', 'twitter:image')]) {
      if (image !== SITE_URL + OG_IMAGE.file) { fail(`${file}: social image must be ${SITE_URL}${OG_IMAGE.file}`); continue; }
      check(file, image);
    }

    const structured = page.scripts.filter(script => script.attributes.type === 'application/ld+json');
    if (!structured.length) fail(`${file}: missing JSON-LD`);
    for (const script of structured) {
      counts.jsonLd++;
      let data;
      try { data = JSON.parse(script.body); } catch (error) { fail(`${file}: invalid JSON-LD (${error.message})`); continue; }
      const types = [].concat(data['@type']);
      if (!types.includes('SoftwareApplication')) fail(`${file}: JSON-LD must describe a SoftwareApplication`);
      if (/"(?:aggregateRating|review|ratingValue)"/.test(script.body)) fail(`${file}: JSON-LD must not contain ratings or reviews`);
      if (data.name !== 'Git Pro' || data.applicationCategory !== 'DeveloperApplication' || data.url !== SITE_URL) fail(`${file}: JSON-LD name, applicationCategory or url is wrong`);
      // No offers while the Marketplace listing is not live; if one is added later it must not carry a price.
      if ([].concat(data.offers || []).some(offer => Number(offer && offer.price) !== 0)) fail(`${file}: JSON-LD offers must not carry a price`);
      if (data.softwareVersion !== version) fail(`${file}: JSON-LD softwareVersion must be ${version}`);
      for (const key of ['image', 'screenshot']) if (data[key]) check(file, data[key]);
    }
  }

  for (const file of files) {
    const extension = path.extname(file);
    if (file.split('/')[0] === 'og' || file === 'README.md') fail(`${file}: source-only file was deployed`);
    if (!textTypes.has(extension)) continue;
    const text = fs.readFileSync(path.join(output, file), 'utf8');
    if (/\{\{[A-Z_]+\}\}/.test(text)) fail(`${file}: unreplaced {{placeholder}}`);
    if (/<!-- \/?unlisted -->/.test(text)) fail(`${file}: unbalanced <!-- unlisted --> marker`);
    if (extension === '.css') {
      for (const match of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
        if (/^(?:data:|#)/.test(match[2])) continue;
        counts.cssUrls++;
        check(file, match[2]);
      }
    }
  }

  const manifestFile = 'site.webmanifest';
  if (!files.has(manifestFile)) fail('site.webmanifest is missing');
  else {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(output, manifestFile), 'utf8'));
      if (!manifest.name || !Array.isArray(manifest.icons) || !manifest.icons.length) fail(`${manifestFile}: needs a name and icons`);
      for (const icon of manifest.icons || []) { counts.manifestIcons++; check(manifestFile, icon.src); }
    } catch (error) { fail(`${manifestFile}: invalid JSON (${error.message})`); }
  }

  if (!files.has('sitemap.xml')) fail('sitemap.xml is missing');
  else {
    const locations = [...fs.readFileSync(path.join(output, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].trim());
    if (!locations.length) fail('sitemap.xml lists no URLs');
    for (const location of locations) {
      counts.sitemapUrls++;
      if (!location.startsWith(SITE_URL)) fail(`sitemap.xml: ${location} is not under ${SITE_URL}`);
      else check('sitemap.xml', location, { expectHtml: true });
    }
  }

  if (!files.has('robots.txt')) fail('robots.txt is missing');
  else if (!fs.readFileSync(path.join(output, 'robots.txt'), 'utf8').includes(`Sitemap: ${SITE_URL}sitemap.xml`)) fail('robots.txt must reference the sitemap');

  for (const required of ['index.html', '404.html', 'styles.css', 'main.js', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon.png', OG_IMAGE.file, ...screenshots.map(name => `images/${name}.jpg`)]) {
    if (!files.has(required)) fail(`${required} is missing from site-dist`);
  }
  if (files.has(OG_IMAGE.file)) {
    const size = imageSize(path.join(output, OG_IMAGE.file));
    if (!size || size.width !== OG_IMAGE.width || size.height !== OG_IMAGE.height) fail(`${OG_IMAGE.file} must be ${OG_IMAGE.width}x${OG_IMAGE.height}`);
  }
  if (files.has('favicon-32.png')) {
    const size = imageSize(path.join(output, 'favicon-32.png'));
    if (!size || size.width !== 32 || size.height !== 32) fail('favicon-32.png must be 32x32');
  }
  return { files, pages };
}

let result = { files: new Set(), pages: new Map() };
try {
  build();
  result = validate();
} catch (error) {
  fail(error.message);
}
const bytes = [...result.files].reduce((total, file) => total + fs.statSync(path.join(output, file)).size, 0);
console.log(JSON.stringify({
  passed: errors.length === 0,
  output: 'site-dist',
  version,
  marketplaceUrl: MARKETPLACE_URL,
  marketplaceListed: MARKETPLACE_LISTED,
  files: result.files.size,
  bytes,
  pages: [...result.pages.keys()],
  checks: counts,
  errors
}, null, 2));
if (errors.length) process.exitCode = 1;
