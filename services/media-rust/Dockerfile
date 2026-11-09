# Service building stage
FROM rust:bookworm as builder
RUN apt-get update && apt-get install -y protobuf-compiler cmake && rm -rf /var/lib/apt/lists/*
ENV CMAKE_POLICY_VERSION_MINIMUM=3.5
WORKDIR /usr/src/app
# Copy proto definitions (needed by build.rs)
COPY proto/ proto/
# Copy media-rust source
COPY services/media-rust/ services/media-rust/
WORKDIR /usr/src/app/services/media-rust
RUN cargo install --path .

# Optimized runtime image
FROM debian:bookworm-slim
# Install necessary runtime dependencies (e.g. openssl if needed, though rust is statically linked mostly)
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/cargo/bin/media-sfu /usr/local/bin/media-sfu
ENV RUST_LOG=info
CMD ["media-sfu"]
