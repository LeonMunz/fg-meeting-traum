FROM node:24.19.0-bookworm AS node-seed

RUN npm install --global npm@11.17.0
WORKDIR /seed/npm
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --cache /opt/npm-cache --no-audit --no-fund \
    && npm cache verify --cache /opt/npm-cache \
    && rm -rf node_modules apps/web/node_modules

FROM ghcr.io/astral-sh/uv:0.12.1 AS uv-bin

FROM python:3.13.14-bookworm AS python-seed
COPY --from=uv-bin /uv /uvx /usr/local/bin/
WORKDIR /seed/api
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN UV_CACHE_DIR=/opt/uv-cache \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    uv sync --locked --python /usr/local/bin/python \
    && rm -rf .venv

FROM postgres:17.11-bookworm AS postgres-source

FROM python:3.13.14-bookworm

COPY --from=postgres-source /etc/apt/sources.list.d/pgdg.list /etc/apt/sources.list.d/pgdg.list
COPY --from=postgres-source /usr/local/share/keyrings/postgres.gpg.asc /usr/local/share/keyrings/postgres.gpg.asc

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        git \
        postgresql-17=17.11-1.pgdg12+2 \
        postgresql-client-17=17.11-1.pgdg12+2 \
    && rm -rf /var/lib/apt/lists/* \
        /var/lib/postgresql/17/main \
        /etc/postgresql/17/main \
    && groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid agent --create-home --shell /bin/sh agent

COPY --from=uv-bin /uv /uvx /usr/local/bin/
COPY --from=node-seed /usr/local/bin/node /usr/local/bin/node
COPY --from=node-seed /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-seed /opt/npm-cache /opt/npm-cache
COPY --from=python-seed /opt/uv-cache /opt/uv-cache

ENV PATH=/usr/lib/postgresql/17/bin:$PATH

RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && chown -R root:root /opt/npm-cache /opt/uv-cache \
    && chmod -R a-w /opt/npm-cache /opt/uv-cache \
    && node --version \
    && npm --version \
    && python --version \
    && uv --version \
    && postgres --version

ENV HOME=/home/agent \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    UV_PYTHON_DOWNLOADS=0

USER agent
WORKDIR /workspace
CMD ["sleep", "infinity"]
