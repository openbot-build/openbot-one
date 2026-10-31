FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11 AS builder
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils build-essential pkg-config libssl-dev \
    libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libdbus-1-dev \
    libayatana-appindicator3-dev patchelf file cmake ninja-build python3 \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good libfuse2 squashfs-tools
ARG NODE_VERSION=26.12.1
RUN curl --fail --location --proto '=https' --tlsv1.2 \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && curl --fail --location --proto '=https' --tlsv1.2 \
      "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o /tmp/node-sha256.txt \
 && cd /tmp \
 && node_hash="$(awk -v file="node-v${NODE_VERSION}-linux-x64.tar.xz" '$2 == file {print $1}' node-sha256.txt)" \
 && test -n "$node_hash" \
 && echo "$node_hash  node.tar.xz" | sha256sum --check \
 && mkdir /opt/node \
 && tar -xJf node.tar.xz --strip-components=1 -C /opt/node
ENV PATH="/opt/node/bin:/opt/cargo/bin:${PATH}" \
    CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup
ARG RUST_VERSION=1.99.0
ARG RUSTUP_VERSION=1.28.2
RUN curl --fail --location --proto '=https' --tlsv1.2 \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" -o /tmp/rustup-init \
 && curl --fail --location --proto '=https' --tlsv1.2 \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init.sha256" -o /tmp/rustup.sha256 \
 && cd /tmp && echo "$(cut -d ' ' -f 1 rustup.sha256)  rustup-init" | sha256sum --check \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}"
RUN npm install --global corepack@0.36.0 && corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY . .
ARG OPENBOT_DEFAULT_API_ORIGIN=http://localhost:19380
ARG OPENBOT_NATIVE_CLIENT_ID=openbot-one
ENV OPENBOT_DEFAULT_API_ORIGIN="${OPENBOT_DEFAULT_API_ORIGIN}" \
    OPENBOT_NATIVE_CLIENT_ID="${OPENBOT_NATIVE_CLIENT_ID}" \
    CARGO_PROFILE_DEV_DEBUG=0 \
    APPIMAGE_EXTRACT_AND_RUN=1
RUN pnpm desktop:build --debug --bundles deb appimage --ci
