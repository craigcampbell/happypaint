# PocketBase (accounts + SQLite + file storage). No official image exists, so we
# fetch the release binary. Pin the version; bump deliberately.
FROM alpine:latest
ARG PB_VERSION=0.39.4
RUN apk add --no-cache unzip ca-certificates
ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb/ && rm /tmp/pb.zip
# To auto-provision schema on a fresh volume, drop migrations in ./pb_migrations
# and uncomment:
# COPY ./pb_migrations /pb/pb_migrations
EXPOSE 8090
ENTRYPOINT ["/pb/pocketbase"]
CMD ["serve", "--http=0.0.0.0:8090"]
