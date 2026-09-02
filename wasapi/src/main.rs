// hpm-wasapi — Windows-only system-audio loopback helper.
// Captures the render endpoint mix via WASAPI loopback (which keeps producing
// audio when the audible output is muted), converts to mono PCM s16le at the
// requested sample rate, and writes raw little-endian bytes to stdout. This
// matches the PCM stream the TypeScript pipeline already reads from ffmpeg.
//
// On other platforms the binary is a no-op so the workspace still builds.

#[cfg(target_os = "windows")]
mod win;

#[cfg(target_os = "windows")]
fn main() -> anyhow::Result<()> {
    win::run()
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("hpm-wasapi is only supported on Windows");
    std::process::exit(2);
}
