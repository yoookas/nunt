# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# web stage: build the Vue admin interface into internal/webui/assets
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:24-alpine AS web

WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./
# vite writes ../internal/webui/assets relative to this directory.
RUN npm run build

# ---------------------------------------------------------------------------
# build stage
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine AS build

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
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata libcap su-exec \
 && addgroup -g 1000 -S nunt \
 && adduser -u 1000 -S -G nunt -h /data nunt \
 && mkdir -p /data \
 && chown -R nunt:nunt /data

COPY --from=build /out/nunt /usr/local/bin/nunt
# Allow the unprivileged runtime user to bind ports 80 and 443.
RUN setcap 'cap_net_bind_service=+ep' /usr/local/bin/nunt

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/data"]
EXPOSE 3113 80 443
# The admin console port follows the same priority as the application:
#   1. NUNT_ADMIN_PORT
#   2. the port part of NUNT_ADMIN_LISTEN
#   3. system.adminListen from the stored configuration (/data/config.json),
#      which the settings page can change at runtime without a restart
#   4. the built-in default (3113)
# Reading the configuration file is what keeps the health check correct after
# somebody moved the console from the settings page.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD port="${NUNT_ADMIN_PORT:-}"; \
      if [ -z "$port" ] && [ -n "${NUNT_ADMIN_LISTEN:-}" ]; then port="${NUNT_ADMIN_LISTEN##*:}"; fi; \
      if [ -z "$port" ] && [ -r /data/config.json ]; then \
        port=$(sed -n 's/.*"adminListen"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /data/config.json | head -n 1 | sed 's/^.*://'); \
      fi; \
      [ -n "$port" ] || port=3113; \
      wget -q -O /dev/null "http://127.0.0.1:${port}/healthz" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nunt", "-d", "/data"]
