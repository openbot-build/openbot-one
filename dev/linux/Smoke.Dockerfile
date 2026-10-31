ARG BUILDER_IMAGE=openbot-one-linux-build:local
FROM ${BUILDER_IMAGE} AS built
FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11
ARG DEBIAN_FRONTEND=noninteractive
COPY --from=built /opt/node /opt/node
COPY --from=built /src/node_modules /check/node_modules
COPY --from=built /src/dist/licenses /check/notices
COPY --from=built /src/src-tauri/target/debug/bundle/deb/*.deb /packages/openbot.deb
COPY --from=built /src/src-tauri/target/debug/bundle/appimage/*.AppImage /packages/openbot.AppImage
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates xvfb xauth dbus desktop-file-utils binutils \
 && apt-get install -y --no-install-recommends /packages/openbot.deb \
 && dpkg-deb -f /packages/openbot.deb Package > /check/deb-name.txt \
 && useradd --create-home --uid 10001 openbot-test \
 && mkdir -p /results /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
 && chown openbot-test:openbot-test /results
COPY e2e/linux-install.mjs e2e/linux-package-policy.mjs e2e/socket-fixture.mjs /check/
ENV PATH="/opt/node/bin:${PATH}"
WORKDIR /check
USER openbot-test
CMD ["node", "/check/linux-install.mjs"]
