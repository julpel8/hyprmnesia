// hpm-wlcap — Linux/Wayland screen capture helper.
// On other platforms the binary is a no-op so the workspace still builds.

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    linux::run()
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("hpm-wlcap is only supported on Linux");
    std::process::exit(2);
}
