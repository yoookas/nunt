# nunt - common development tasks

BINARY := nunt
VERSION ?= dev
COMMIT  := $(shell git rev-parse --short=12 HEAD 2>/dev/null || echo none)
BUILDTIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w \
  -X github.com/nunt/nunt/internal/version.Version=$(VERSION) \
  -X github.com/nunt/nunt/internal/version.Commit=$(COMMIT) \
  -X github.com/nunt/nunt/internal/version.BuildTime=$(BUILDTIME)

.PHONY: all build web run test vet fmt lint clean docker release

all: build

# Rebuild the admin interface into internal/webui/assets. The bundle is
# committed, so a plain "make build" needs no Node toolchain.
web:
	cd frontend && npm ci --no-audit --no-fund && npm run build

build:
	CGO_ENABLED=0 go build -trimpath -tags "nomsgpack" -ldflags "$(LDFLAGS)" -o $(BINARY) ./cmd/nunt

run: build
	./$(BINARY) -d ./data -log-level debug

test:
	go test ./... -count=1

vet:
	go vet ./...

fmt:
	gofmt -s -w .

lint: vet
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then echo "unformatted files:"; echo "$$unformatted"; exit 1; fi

clean:
	rm -rf $(BINARY) dist

docker:
	docker build --build-arg VERSION=$(VERSION) -t nunt:$(VERSION) .

# Build the loadable image archive the release workflow produces.
release-archive:
	mkdir -p dist
	docker buildx build --platform linux/amd64 --build-arg VERSION=$(VERSION) \
	  --output type=docker,dest=dist/$(BINARY)-$(VERSION)-amd64.tar .
	gzip -9 -c dist/$(BINARY)-$(VERSION)-amd64.tar > dist/$(BINARY)-$(VERSION)-amd64.tar.gz
	cd dist && sha256sum *.tar.gz > SHA256SUMS
