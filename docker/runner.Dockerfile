# syntax=docker/dockerfile:1.7
#
# zenith-runner image: the static runner binary plus a pinned OpenTofu, on a
# distroless static base (no shell, no package manager, non-root).
#
# Build context is the repository root:
#   docker build -f docker/runner.Dockerfile -t zenith-runner:1.0.0 \
#     --build-arg VERSION=1.0.0 --build-arg COMMIT=$(git rev-parse --short=12 HEAD) .
#
# OpenTofu is downloaded from the official GitHub release and verified against
# the SHA-256 published in that release's tofu_<version>_SHA256SUMS. The build
# FAILS if a checksum is empty or does not match; there is no way to skip the
# verification. To change the pinned version, update src/lib/tofu/types.ts
# (TOFU_VERSION), then TOFU_VERSION and both checksums here, copied from
#   https://github.com/opentofu/opentofu/releases/download/v<ver>/tofu_<ver>_SHA256SUMS
#
# Run it read-only (see deploy/helm/zenith-runner): the runner writes only to
# /var/lib/zenith-runner (identity key, replay cache, saved plans: mount a
# volume so it survives restarts) and to /tmp (per-job working directories).

ARG GO_VERSION=1.27
ARG ALPINE_VERSION=3.22
ARG TOFU_VERSION=1.12.5
# tofu_1.12.5_linux_amd64.tar.gz / tofu_1.12.5_linux_arm64.tar.gz
ARG TOFU_SHA256_AMD64=a6894d45ae7a17ce83189cce8fe04b5a65f68cefceb62455b5a6a89fa53ab38f
ARG TOFU_SHA256_ARM64=e67e9da2b1ddf5050ebee62a584cb826eafe1dfd3827d7ec20899ac62791ed1a

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=0.0.0-dev
ARG COMMIT=unknown
WORKDIR /src/go
COPY go/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath \
      -ldflags "-s -w -X github.com/GODOSTROYER/zenith/go/internal/version.Version=${VERSION} -X github.com/GODOSTROYER/zenith/go/internal/version.Commit=${COMMIT}" \
      -o /out/zenith-runner ./cmd/zenith-runner \
 && mkdir -p /out/state && chmod 0700 /out/state

FROM --platform=$BUILDPLATFORM alpine:${ALPINE_VERSION} AS tofu
ARG TARGETARCH
ARG TOFU_VERSION
ARG TOFU_SHA256_AMD64
ARG TOFU_SHA256_ARM64
RUN apk add --no-cache curl
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) sha="${TOFU_SHA256_AMD64}" ;; \
      arm64) sha="${TOFU_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    [ -n "${sha}" ] || { echo "a SHA-256 for OpenTofu ${TOFU_VERSION} ${TARGETARCH} is required; refusing to download unverified code" >&2; exit 1; }; \
    [ -n "${TOFU_VERSION}" ] || { echo "TOFU_VERSION is required" >&2; exit 1; }; \
    curl -fsSL --retry 3 -o /tmp/tofu.tar.gz \
      "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    echo "${sha}  /tmp/tofu.tar.gz" | sha256sum -c -; \
    mkdir -p /out && tar -xzf /tmp/tofu.tar.gz -C /out tofu; \
    chmod 0755 /out/tofu

FROM gcr.io/distroless/static-debian12:nonroot
ARG VERSION=0.0.0-dev
ARG TOFU_VERSION
LABEL org.opencontainers.image.title="zenith-runner" \
      org.opencontainers.image.description="Zenith runner: executes signed infrastructure jobs with the workload identity of the network it runs in" \
      org.opencontainers.image.source="https://github.com/GODOSTROYER/zenith" \
      org.opencontainers.image.version="${VERSION}" \
      io.zenith.opentofu.version="${TOFU_VERSION}"
COPY --from=build --chown=65532:65532 /out/state /var/lib/zenith-runner
COPY --from=build /out/zenith-runner /usr/local/bin/zenith-runner
COPY --from=tofu /out/tofu /usr/local/bin/tofu
ENV ZENITH_STATE_DIR=/var/lib/zenith-runner \
    ZENITH_CONFIG=/etc/zenith-runner/config.yaml
USER 65532:65532
VOLUME ["/var/lib/zenith-runner"]
ENTRYPOINT ["/usr/local/bin/zenith-runner"]
CMD ["run"]
