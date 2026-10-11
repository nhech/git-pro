# Serves site-dist/ for git-pro.longtd.me behind the Cloudflare Tunnel. Build with scripts/deploy-site.cjs,
# which builds the site and generates .generated/security-headers.conf first. Context: the repository root.
FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY site/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY site/deploy/.generated/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY site-dist/ /usr/share/nginx/html/
