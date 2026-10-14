# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# build stage
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build

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
EXPOSE 16601 80 443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:16601/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nunt", "-d", "/data"]
