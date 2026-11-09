fn main() {
    prost_build::compile_protos(
        &["../../proto/specter/v1/specter.proto"],
        &["../../proto/"],
    )
    .unwrap();
}