# Verifier supplies a platform-specific immutable Ubuntu 24.04 digest.
ARG SYSTEMD_BASE
FROM ${SYSTEMD_BASE}
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home-dir /var/lib/zenithd --shell /usr/sbin/nologin zenithd \
 && usermod -a -G systemd-journal zenithd
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
