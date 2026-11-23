# syntax=docker/dockerfile:1

# Base images are build arguments so a deployment can pin a digest without
# editing this file (and so CI can be told to rebuild against a patched base):
#   docker build --build-arg ALPINE_IMAGE=alpine@sha256:... .
# The tags below are the versions the project is tested against.
ARG NODE_IMAGE=node:24-alpine
ARG GO_IMAGE=golang:1.26.10-alpine
ARG ALPINE_IMAGE=alpine:3.21

# ---------------------------------------------------------------------------
# web stage: build the React admin interface into internal/webui/assets
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web

WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./
# vite writes ../internal/webui/assets relative to this directory.
RUN npm run build

# ---------------------------------------------------------------------------
# build stage
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG TARGETVARIANT=""
ARG VERSION=dev
ARG COMMIT=none
ARG BUILDTIME=unknown
# goproxy.cn is the default because the project targets a Chinese audience;
# override with --build-arg GOPROXY=https://proxy.golang.org,direct if needed.
ARG GOPROXY=https://goproxy.cn,direct

ENV CGO_ENABLED=0 \
    GOOS=$TARGETOS \
    GOARCH=$TARGETARCH \
    GOPROXY=$GOPROXY \
    GOTOOLCHAIN=auto

WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
# The bundle built above replaces whatever is committed, so the image never
# ships a stale admin interface.
COPY --from=web /src/internal/webui/assets ./internal/webui/assets
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOARM=${TARGETVARIANT#v} go build -trimpath -tags "nomsgpack" \
      -ldflags "-s -w \
        -X github.com/nunt/nunt/internal/version.Version=${VERSION} \
        -X github.com/nunt/nunt/internal/version.Commit=${COMMIT} \
        -X github.com/nunt/nunt/internal/version.BuildTime=${BUILDTIME}" \
      -o /out/nunt ./cmd/nunt

# ---------------------------------------------------------------------------
# runtime stage
# ---------------------------------------------------------------------------
FROM ${ALPINE_IMAGE}

# OCI metadata so `docker inspect` (and registry UIs) show what the image is,
# which commit built it and where the source lives.
ARG VERSION=dev
ARG COMMIT=none
ARG BUILDTIME=unknown
LABEL org.opencontainers.image.title="nunt" \
      org.opencontainers.image.description="Self hosted edge service: reverse proxy, redirects, static hosting, port forwarding, DDNS, ACME certificates and a Coraza WAF behind one admin UI" \
      org.opencontainers.image.url="https://github.com/nunt/nunt" \
      org.opencontainers.image.source="https://github.com/nunt/nunt" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.created="${BUILDTIME}" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache ca-certificates tzdata libcap su-exec \
 && addgroup -g 1000 -S nunt \
 && adduser -u 1000 -S -G nunt -h /data nunt \
 && mkdir -p /data \
 && chown -R nunt:nunt /data

COPY --from=build /out/nunt /usr/local/bin/nunt
# Allow the unprivileged runtime user to bind ports 80 and 443 without a
# capability on the container. Note that this is why the image cannot be run
# with `security_opt: [no-new-privileges]`: that option stops file capabilities
# from being applied, so binding 80/443 would fail. Use `cap_add:
# [NET_BIND_SERVICE]` instead when the file capability is not available
# (rootless Docker, Podman, --cap-drop=ALL).
RUN setcap 'cap_net_bind_service=+ep' /usr/local/bin/nunt

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/data"]
EXPOSE 3113 80 443
# Read by the entrypoint (data directory) and by the health check below.
ENV DATA_DIR=/data
# The check is a subcommand of the service itself: it resolves the admin
# address with exactly the server precedence (NUNT_ADMIN_LISTEN >
# NUNT_ADMIN_PORT > system.adminListen in /data/config.json > :3113) and calls
# /healthz, so no shell, sed or wget is involved and a minified configuration
# cannot break it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["nunt", "healthcheck"]
# The service handles SIGTERM itself and shuts down gracefully (15 s budget).
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nunt", "-d", "/data"]
