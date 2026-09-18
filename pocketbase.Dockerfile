# PocketBase (accounts + SQLite + file storage). No official image exists, so we
# fetch the release binary. Pin the version AND its checksum; bump both
# deliberately (sha256 from the release's checksums.txt):
#   https://github.com/pocketbase/pocketbase/releases/download/v<ver>/checksums.txt
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
ARG PB_VERSION=0.39.4
ARG PB_SHA256=06a3ec70205b3eaf8343e226ab74c132013f7b1e9102e898dbca034bdd622d62
RUN apk add --no-cache unzip ca-certificates su-exec && adduser -D -H -u 1000 pb
# --checksum fails the build if the download is not byte-for-byte the release.
ADD --checksum=sha256:${PB_SHA256} https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb/ && rm /tmp/pb.zip && mkdir -p /pb/pb_data /pb/pb_migrations && chown -R pb:pb /pb
# To auto-provision schema on a fresh volume, drop migrations in ./pb_migrations
# and uncomment:
# COPY --chown=pb:pb ./pb_migrations /pb/pb_migrations
EXPOSE 8090
# Runs as the unprivileged `pb` user. Starts as root only to make a bind-mounted
# ./pb_data writable (it arrives owned by the host user), then drops for good.
ENTRYPOINT ["/bin/sh", "-c", "if [ \"$(id -u)\" = 0 ]; then su-exec pb test -w /pb/pb_data || chown -R pb:pb /pb/pb_data || true; exec su-exec pb /pb/pocketbase \"$@\"; fi; exec /pb/pocketbase \"$@\"", "--"]
CMD ["serve", "--http=0.0.0.0:8090"]
