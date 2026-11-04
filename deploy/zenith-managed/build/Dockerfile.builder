# Resolve both arguments to real digests on the verifier. No mutable base is admitted.
ARG GO_IMAGE
ARG BUILDKIT_IMAGE
FROM ${GO_IMAGE} AS compile
WORKDIR /src
COPY deploy/zenith-managed/build/builder.go .
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -ldflags="-s -w" -o /zenith-builder builder.go
FROM ${BUILDKIT_IMAGE}
USER root
# Subordinate mappings live INSIDE the outer pod userns (65536 IDs).
RUN printf 'user:0:65536\n' > /etc/subuid && printf 'user:0:65536\n' > /etc/subgid
COPY --from=compile /zenith-builder /usr/local/bin/zenith-builder
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/zenith-builder"]

