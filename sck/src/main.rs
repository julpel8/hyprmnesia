// hpm-sck — macOS-only helper.
// On other platforms the binary is a no-op so the workspace still builds.

#[cfg(target_os = "macos")]
mod mac;

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    mac::run()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("hpm-sck is only supported on macOS");
    std::process::exit(2);
}
