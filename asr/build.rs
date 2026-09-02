fn main() {
    // `ort` (ONNX Runtime, used by Parakeet) and `sentencepiece-sys` each
    // statically vendor their own copy of protobuf. sentencepiece is pulled in
    // transitively because ct2rs's `whisper` feature force-enables
    // `all-tokenizers` (sentencepiece + tokenizers) even though Whisper itself
    // only uses the `tokenizers` crate. With both protobufs compiled in, a debug
    // link sees duplicate `google::protobuf` symbols. The release profile hides
    // them via LTO, but `cargo test` builds in debug and fails to link.
    //
    // Allow the duplicates on GNU/lld linkers — Linux is the only target that
    // runs `cargo test` in CI (the per-OS jobs only build in release). The flag
    // is harmless when there are no duplicates and picks the first definition
    // when there are; sentencepiece's protobuf is never called at runtime.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "linux" {
        println!("cargo:rustc-link-arg-bins=-Wl,--allow-multiple-definition");
        println!("cargo:rustc-link-arg-tests=-Wl,--allow-multiple-definition");
    }
}
