# Git Pro landing page

Static source for <https://git-pro.longtd.me>. No framework, no npm dependencies, no external fonts or scripts. This README, `site/og/` and `site/deploy/` are source-only and are not deployed.

| Path | Purpose |
|---|---|
| `site/index.html` | The single landing page. Uses the `{{MARKETPLACE_URL}}` and `{{VERSION}}` placeholders. |
| `site/404.html` | Not-found page. Uses root-relative URLs because nginx serves it for missing paths at any depth. |
| `site/deploy/` | Production origin: `Dockerfile`, `nginx.conf` and `compose.yml` for the nginx container behind the Cloudflare Tunnel. Source-only, never copied into `site-dist/`. |
| `site/styles.css` | Design tokens (dark default, light via `prefers-color-scheme` or the stored toggle), layout and motion. |
| `site/main.js` | Progressive enhancement only: theme toggle, copy buttons, reveal on scroll, lightbox, current-section highlight, mobile menu. The inline head script adds the `js` class (so the layout is final at first paint); `main.js` adds `js-ready` once the theme toggle and the menu work. If `js-ready` is missing at `DOMContentLoaded` (the file was blocked, missing or failed), the head script removes `js` and the page falls back to the no-JS layout, with the menu links visible. |
| `site/favicon.svg` | Vector of `media/icon.png`, built from the geometry in `scripts/generate-icon.cjs`. |
| `site/og.jpg` | 1200 × 630 social card (JPEG, about 75 KB, under the ~300 KB limit some link previews apply), rendered from `site/og/og-card.html`. |
| `site/robots.txt`, `site/sitemap.xml`, `site/site.webmanifest` | Crawling and install metadata. |

`scripts/build-site.cjs` writes `site-dist/` (ignored by Git and excluded from the VSIX):

- copies `site/` except `site/og/`, `site/deploy/` and this README, replacing the placeholders;
- copies `docs/images/{changes-and-commit,file-actions,history}.jpg` to `images/`;
- copies `media/icon.png` to `icon.png` and `apple-touch-icon.png`, and box-filters it to `favicon-32.png`;
- validates the result: every local `href`/`src` (including root-relative and `https://git-pro.longtd.me/...` URLs) resolves to a file, every `#fragment` has a matching `id`, ids are unique, each page has one `<h1>`, every `<img>` has `alt`, `width` and `height` matching the image's aspect ratio, required meta tags, canonical, Open Graph and Twitter tags are present, the JSON-LD is valid and has no ratings, reviews or priced offers, `og.jpg` is 1200 × 630 and declared as `image/jpeg`, and no placeholder or `<!-- unlisted -->` marker is left.

It prints a JSON summary and exits with code 1 on any failure.

## Change the Marketplace link or version

The Marketplace URL lives in one constant, `MARKETPLACE_URL`, at the top of `scripts/build-site.cjs`. The version comes from `package.json`. Edit those, not the HTML.

The Marketplace listing is not live yet, so the install steps carry short "not live yet" notes wrapped in `<!-- unlisted -->` ... `<!-- /unlisted -->` in `site/index.html`. When the listing goes live, set `MARKETPLACE_LISTED` to `true` in `scripts/build-site.cjs` and rebuild: the build drops those blocks. Check that the Marketplace URL opens the listing first.

## Structured data

The JSON-LD describes a `SoftwareApplication` with no `offers`, ratings or reviews: the project is described as MIT licensed (`license`), not with a price. Google's Software App rich result requires `aggregateRating` or `review`, so the Rich Results Test and Search Console report the item as ineligible or "missing field". That is expected. Do not fix it with made-up ratings or reviews; the build fails on them. Add only properties the project's docs support (for example, no `operatingSystem` list: the docs make no OS support statement).

## Preview locally

```sh
npm run site:build   # node scripts/build-site.cjs
npm run site:serve   # node scripts/serve-site.cjs -> http://127.0.0.1:4173/
```

Always preview `site-dist/`: the files in `site/` still contain placeholders and do not include the screenshots. Any static server works; `scripts/serve-site.cjs` binds to 127.0.0.1 only, sets content types and serves `404.html` for missing paths. It keeps running while `npm run site:build` replaces `site-dist/`, and answers a plain-text 404 while `site-dist/` is empty. Set `PORT` to use another port.

## Update the social card

Edit `site/og/og-card.html` (it links `../styles.css` and the real History screenshot), then run:

```sh
npm run site:og      # node scripts/render-og.cjs
```

It renders the card as a JPEG with headless Microsoft Edge or Google Chrome (`OG_BROWSER` overrides the executable), checks that `site/og.jpg` is 1200 × 630 and under 300 KB, and prints its size. Commit `site/og.jpg`.

## How deployment works

`git-pro.longtd.me` is served the same way as `longtd.me`: through the Cloudflare Tunnel run by the `cloudflared` Windows service on the host machine. The origin is an nginx container on that machine.

```sh
npm run site:deploy            # node scripts/deploy-site.cjs
npm run site:deploy -- --verify   # only check the running container
```

`scripts/deploy-site.cjs`:

1. runs `scripts/build-site.cjs` (it stops on any validation error);
2. writes `site/deploy/.generated/security-headers.conf` (ignored by Git): a Content-Security-Policy with `default-src 'none'` that allows only same-origin files, plus a sha256 hash of each inline `<script>` and `style` attribute in the built pages, so there is no `'unsafe-inline'`; also `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and HSTS for this host only (no `includeSubDomains`);
3. runs `docker compose -f site/deploy/compose.yml up -d --build`: the image (`nginxinc/nginx-unprivileged`, non-root, read-only filesystem, all capabilities dropped) contains a copy of `site-dist/`, so a deploy swaps the whole container and the site is never half-updated;
4. checks `http://127.0.0.1:4280/`: the home page matches `site-dist/index.html`, the security headers are present, CSS/JS/images/manifest/robots/sitemap have the right content types, a missing path returns the 404 page, and `site/deploy/` files and dot paths are not served. It prints a JSON summary and exits with code 1 on any failure.

The container binds to `127.0.0.1` only (port `GIT_PRO_SITE_PORT`, default `4280`) and restarts with Docker (`restart: unless-stopped`). nginx sets `Cache-Control: no-cache` on HTML, one hour on CSS/JS and one day on images; Cloudflare adds TLS, HTTP/2/3 and compression at the edge.

To stop the site: `docker compose -f site/deploy/compose.yml down`, then remove the public hostname from the tunnel (see below) so visitors get a Cloudflare error instead of a dead origin.

## One-time setup (manual, in Cloudflare)

The tunnel and DNS are not changed by any script in this repository. Add the hostname to the existing tunnel once:

- **Tunnel managed in the dashboard** (the usual case for a `cloudflared` service installed with a token): Cloudflare **Zero Trust → Networks → Tunnels** → the tunnel that serves `longtd.me` → **Public Hostname → Add a public hostname**:

  | Subdomain | Domain | Path | Service type | URL |
  |---|---|---|---|---|
  | `git-pro` | `longtd.me` | *(empty)* | `HTTP` | `localhost:4280` |

  Save. Cloudflare creates the proxied `git-pro` DNS record (CNAME to `<tunnel-id>.cfargotunnel.com`) and the Universal SSL certificate for `longtd.me` already covers `git-pro.longtd.me`. Nothing else is needed.

- **Tunnel managed by a local `config.yml`**: add the rule above the final catch-all rule, keeping the existing `longtd.me` rules unchanged:

  ```yaml
  ingress:
    # ...existing longtd.me rules...
    - hostname: git-pro.longtd.me
      service: http://localhost:4280
    - service: http_status:404
  ```

  Then create the DNS record and restart the service (PowerShell as administrator):

  ```powershell
  cloudflared tunnel route dns <tunnel-name-or-id> git-pro.longtd.me
  Restart-Service Cloudflared
  ```

Recommended zone settings (usually already on for `longtd.me`): **SSL/TLS → Edge Certificates → Always Use HTTPS** on. The tunnel connection to the origin is already encrypted, so the origin speaks plain HTTP on loopback.

## Verify

```sh
npm run site:deploy -- --verify             # origin checks on 127.0.0.1:4280
nslookup git-pro.longtd.me                   # Cloudflare addresses (proxied record)
curl -I https://git-pro.longtd.me/           # HTTP/2 200, server: cloudflare, content-security-policy: ...
curl -I http://git-pro.longtd.me/            # 301 to https:// with Always Use HTTPS
curl -I https://git-pro.longtd.me/og.jpg     # content-type: image/jpeg
curl -I https://git-pro.longtd.me/missing    # 404 (served from 404.html)
```

On Windows PowerShell, `Resolve-DnsName git-pro.longtd.me` and `curl.exe -I https://git-pro.longtd.me/` give the same information.
