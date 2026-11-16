# syntax=docker/dockerfile:1.7
#
# zenithd image: a static zenithd on distroless, intended for TESTING the
# protocol and the operations that do not need the host (file.read, /proc
# views of the container, network checks). The supported production install is
# the binary plus a systemd unit on the VM (deploy/zenithd/), because zenithd
# is meant to observe the host: systemctl, journalctl and the host's /proc are
# not reachable from inside a container unless you deliberately mount them.
#
#   docker build -f docker/zenithd.Dockerfile -t zenithd:test --build-arg VERSION=1.0.0 .
ARG GO_VERSION=1.27

# TODO J11: resolve this base with scripts/deploy/pin-digests.mjs on the Mac.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
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
      -o /out/zenithd ./cmd/zenithd \
 && mkdir -p /out/state && chmod 0700 /out/state

# TODO J11: resolve this base with scripts/deploy/pin-digests.mjs on the Mac.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="zenithd" \
      org.opencontainers.image.description="Zenith machine agent (test image; install on VMs with the systemd unit)" \
      org.opencontainers.image.source="https://github.com/GODOSTROYER/zenith" \
      org.opencontainers.image.version="${VERSION}"
COPY --from=build --chown=65532:65532 /out/state /var/lib/zenithd
COPY --from=build /out/zenithd /usr/local/bin/zenithd
ENV ZENITH_STATE_DIR=/var/lib/zenithd \
    ZENITH_CONFIG=/etc/zenithd/config.yaml
USER 65532:65532
VOLUME ["/var/lib/zenithd"]
ENTRYPOINT ["/usr/local/bin/zenithd"]
CMD ["run"]
