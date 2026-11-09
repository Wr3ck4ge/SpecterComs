//! Thin entry point; the relay itself is the `media_sfu` library (src/lib.rs).

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    if let Err(e) = media_sfu::run().await {
        // `{:#}` prints the whole context chain on one line.
        log::error!("media-sfu cannot start: {:#}", e);
        std::process::exit(1);
    }
}
