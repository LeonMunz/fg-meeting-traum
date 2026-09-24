# FG Workspace — frontend production image (image-level slice).
#
# Vite production build (Node builder) -> static dist/ served by Caddy
# on the unprivileged internal port 8080. No /api proxying, no TLS,
# no public hostname — those belong to the later Compose/network slice.
#
# The npm workspace lockfile lives at the repository root, so the build
# context is the repository root:
#
#   docker build -f apps/web/Dockerfile \
#     -t fg-workspace-web:frontend-production-container-test .

# Node major version matches the repository requirement (.nvmrc = 24,
# package.json engines >= 24). Dependencies are installed exclusively
# from the committed root package-lock.json via npm ci.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS builder

WORKDIR /build

# Workspace manifests + lockfile first (dependency cache layer),
# then the web workspace source.
COPY package.json package-lock.json ./
COPY apps/web ./apps/web

RUN npm ci --no-audit --no-fund

# Canonical production build: `tsc -b && vite build` -> apps/web/dist
RUN npm run build --workspace=web

# Runtime: built static assets + Caddy only (no Node toolchain).
FROM caddy:2.11.4@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52 AS runtime

# The base image does not provide a deterministic unprivileged account,
# so define the runtime user explicitly: UID/GID 10001, the same
# identity as the backend runtime. No new packages are needed (the
# Alpine busybox user tooling suffices). Static serving only (no TLS
# data, no ACME, admin API off) needs no writable volumes or source
# tree; /srv and the Caddyfile are world-readable by construction.
RUN addgroup -g 10001 app \
	&& adduser -D -H -S -u 10001 -s /sbin/nologin app app

COPY --chown=10001:10001 apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder --chown=10001:10001 /build/apps/web/dist /srv

USER 10001:10001

# Unprivileged internal port (bound by the Caddyfile site address).
EXPOSE 8080

# `caddy run` logs to stdout/stderr by default.
ENTRYPOINT ["caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
