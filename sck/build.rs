fn main() {
    // The screencapturekit crate pulls in Swift dependencies. Most Swift libs
    // are linked by absolute path to `/usr/lib/swift/`, but a few (notably
    // libswift_Concurrency.dylib) ship with `@rpath/...` install names because
    // they are back-deployable. On modern macOS those libs live in the dyld
    // shared cache exposed via `/usr/lib/swift/`, so we need an LC_RPATH entry
    // pointing there or the binary fails at startup with
    //   dyld: Library not loaded: @rpath/libswift_Concurrency.dylib
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
