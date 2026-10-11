// Serves site-dist/ at http://127.0.0.1:4173 for a local preview. No dependencies; run `npm run site:build` first.
// Every file access is guarded, so a missing or rebuilt site-dist/ answers 404/500 instead of stopping the server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'site-dist');
const port = Number(process.env.PORT) || 4173;
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8'
};
const headers = type => ({ 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });

function statOrNull(file) {
  try { return fs.statSync(file); } catch { return null; }
}

// Resolves a request path to a file inside site-dist/, or null.
function resolve(pathname) {
  let file = path.join(root, pathname);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  let stats = statOrNull(file);
  if (stats && stats.isDirectory()) { file = path.join(file, 'index.html'); stats = statOrNull(file); }
  return stats && stats.isFile() ? file : null;
}

function sendText(response, status, text, method) {
  if (!response.headersSent) response.writeHead(status, headers('text/plain; charset=utf-8'));
  response.end(method === 'HEAD' ? undefined : text);
}

function sendFile(response, status, file, method) {
  if (method === 'HEAD') { response.writeHead(status, headers(types[path.extname(file)] || 'application/octet-stream')).end(); return; }
  const stream = fs.createReadStream(file);
  stream.on('open', () => { response.writeHead(status, headers(types[path.extname(file)] || 'application/octet-stream')); stream.pipe(response); });
  stream.on('error', () => {
    if (response.headersSent) response.destroy();
    else sendText(response, 500, 'Could not read the file. Run `npm run site:build` and try again.\n', method);
  });
}

http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  let pathname = null;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); } catch { /* malformed URL: 404 */ }
  const file = pathname === null ? null : resolve(pathname);
  if (file) { sendFile(response, 200, file, request.method); return; }
  const notFound = resolve('404.html');
  if (notFound) sendFile(response, 404, notFound, request.method);
  else sendText(response, 404, 'Not found. Run `npm run site:build` first.\n', request.method);
}).listen(port, '127.0.0.1', () => {
  if (!statOrNull(path.join(root, 'index.html'))) console.warn('site-dist/ is empty: run `npm run site:build` first.');
  console.log(`Serving site-dist/ at http://127.0.0.1:${port}/ (Ctrl+C to stop)`);
});
