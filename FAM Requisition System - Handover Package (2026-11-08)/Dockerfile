FROM nginx:alpine

# Static app + PWA assets (explicit COPYs — never `COPY .`, so the
# git-ignored credential files never end up in the image).
COPY index.html config.js manifest.json sw.js robots.txt /usr/share/nginx/html/
COPY icon.svg apple-touch-icon.png icon-192.png icon-512.png icon-maskable-512.png /usr/share/nginx/html/
COPY manual.html manual.pdf /usr/share/nginx/html/

# Custom nginx config (security headers, cache policy for HTML / SW / icons)
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY fam-security-headers.conf /etc/nginx/fam-security-headers.conf

# Entrypoint injects the backend URL (PB_URL env) into config.js at start.
COPY docker-entrypoint.sh /docker-entrypoint-fam.sh
RUN chmod +x /docker-entrypoint-fam.sh

EXPOSE 80
# Use 127.0.0.1 (not "localhost"): newer alpine base resolves localhost to
# IPv6 ::1 first, which nginx wasn't listening on → false "unhealthy".
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO- http://127.0.0.1/ || exit 1

ENTRYPOINT ["/docker-entrypoint-fam.sh"]
