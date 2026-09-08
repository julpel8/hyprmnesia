# Installation

> Back to the [README](../README.md).
## Contents

- [Windows](#windows)
- [macOS](#macos)
- [Linux (Debian/Ubuntu)](#linux-debianubuntu)

## Windows

Alpha installers are published from GitHub Releases when a `vX.Y.Z` tag is
pushed. They are unsigned for now, so Windows may show security warnings until
signing is added.

### Install from a GitHub Release

Download `hyprmnesia-<version>-windows-x64.msi` from the release and run it. The
MSI installs Hyprmnesia for the current user under
`%LocalAppData%\Programs\Hyprmnesia`, adds a Start Menu shortcut, and appends the
install directory to the user `PATH`.

### Install from source

Install these tools first:

| Tool | Why |
| --- | --- |
| [Bun](https://bun.sh) | JS/TS runtime used by the CLI and daemon |
| Rust toolchain (`cargo`) | Builds the native helpers |
| [CMake](https://cmake.org/download/) | Builds CTranslate2 for the Whisper (faster-whisper) ASR helper |
| Git | Cloning the repository |

Then clone, install JS dependencies, and build:

```powershell
git clone https://github.com/hyprmnesia/hyprmnesia.git
cd hyprmnesia
bun install
bun run build
.\dist\hpm.exe --help
```

`dist/hpm.exe` is the user-facing entry point. Native helpers are built
automatically into `dist/native/` and should not be launched directly.

### System audio

System-audio capture has two backends, selected by
`capture.audio.system.backend` in the config, or the "System backend" row in the
web settings editor:

- **`wasapi`** (preferred) - a bundled native helper (`hpm-wasapi`) captures the
  render endpoint via WASAPI loopback. It taps the engine mix, so it keeps
  capturing even when Windows output is muted or its volume is 0. No external
  driver is required; the helper ships in `dist/native/`.
- **`dshow`** (compatibility fallback) - records the `virtual-audio-capturer`
  DirectShow device from the
  [Screen Capturer Recorder](https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases)
  package. This device follows the audible output, so muting Windows silences
  the capture.
- **`auto`** (default) - uses `wasapi` when the helper is present, otherwise
  falls back to `dshow` and logs a warning that capture will follow mute.

The selected backend and device are recorded in the daemon log's `started` event
so you can confirm which path is active.

To use `dshow`, install Screen Capturer Recorder from the link above. To skip
system audio entirely, launch Hyprmnesia with `--no-system-audio`. If WASAPI
loopback still follows mute on your hardware or driver stack, route the app's
audio into a virtual audio cable/sink and capture that device via `backend:
dshow` with an explicit `device` name.

Microphone and screen capture work out of the box on Windows.

### Verify

Once installed, confirm the daemon starts, runs, and stops cleanly:

```powershell
hpm start
hpm status
hpm logs -n 20
hpm stop
```

For a source build, replace `hpm` with `.\dist\hpm.exe`.

Captured data lives under `~/.hyprmnesia/`. See the
[README](../README.md#daemon-model) for the list of files the daemon writes
there.

### Troubleshooting

**System audio is silent.**
First check the daemon log's `started` event for the `system` source to see which
backend is active.

- If `backend: "wasapi"` and audio is still silent, the helper may not be
  capturing. Confirm `dist/native/hpm-wasapi.exe` exists, built by
  `bun run build`, and check the log for an `hpm-wasapi ... exited` error.
- If `backend: "dshow"`, capture follows the Windows output: unmute the output,
  or switch `capture.audio.system.backend` to `wasapi`. Confirm the dshow device
  is registered with:

  ```powershell
  ffmpeg -list_devices true -f dshow -i dummy
  ```

  If `virtual-audio-capturer` doesn't appear, re-run the Screen Capturer
  Recorder installer.

As a last resort, launch Hyprmnesia with `--no-system-audio`.

## macOS

Alpha installers are published from GitHub Releases when a `vX.Y.Z` tag is
pushed. They are unsigned for now, so macOS may show security warnings until
signing and notarization are added.

### Install from a GitHub Release

Download `hyprmnesia-<version>-macos-<arch>.pkg` and install it. The package
places files in `/usr/local/hyprmnesia`, creates `/usr/local/bin/hpm`, and
installs `/Applications/Hyprmnesia.app` so Hyprmnesia shows up in
Spotlight/Finder/Launchpad. Launching the app runs `hpm start` (tray + daemon).

To start Hyprmnesia automatically at login, enable the opt-in LaunchAgent:

```sh
hpm autostart enable     # disable with: hpm autostart disable
```

Because the package is unsigned in alpha, you may need to approve it through
*System Settings -> Privacy & Security* after the first launch.

### Install from source

**Requirement:** macOS 13 or later, for ScreenCaptureKit.

Install these tools first:

| Tool | Why |
| --- | --- |
| [Bun](https://bun.sh) | JS/TS runtime used by the CLI and daemon |
| Rust toolchain (`cargo`) | Builds the native helpers |
| CMake | Builds CTranslate2 for the Whisper (faster-whisper) ASR helper |
| Git | Cloning the repository |

OCR uses the bundled native helper on macOS via Apple Vision. Tesseract is only
needed if you explicitly configure `processing.ocr.engine: tesseract`. CMake is
needed for the ASR helper; install both with Homebrew:

```sh
brew install cmake tesseract tesseract-lang
```

Then clone, install JS dependencies, and build:

```sh
git clone https://github.com/hyprmnesia/hyprmnesia.git
cd hyprmnesia
bun install
bun run build
./dist/hpm --help
```

`dist/hpm` is the user-facing entry point. Native helpers are built
automatically into `dist/native/` and should not be launched directly.

### Permissions

Screen capture and system-audio capture are handled by the native helper
`hpm-sck`, built from `sck/`. No BlackHole or loopback driver is required.

On first run, macOS prompts for **Screen Recording** permission in
*System Settings -> Privacy & Security*. Grant it to the terminal hosting `hpm`,
or to the bundled `hpm` itself once shipped as an app.

macOS also prompts for **Microphone** access the first time mic capture starts;
allow it for the same host.

### Verify

Once installed, confirm the daemon starts, runs, and stops cleanly:

```sh
hpm start
hpm status
hpm logs -n 20
hpm stop
```

For a source build, replace `hpm` with `./dist/hpm`.

Captured data lives under `~/.hyprmnesia/`. See the
[README](../README.md#daemon-model) for the list of files the daemon writes
there.

### Troubleshooting

**`hpm-sck` exits immediately or no capture happens.**
Re-check *System Settings -> Privacy & Security -> Screen Recording*. The
permission must be granted to the host process that launched `hpm`, often your
terminal app, for example Terminal.app, iTerm, or Ghostty. Quit and relaunch the
terminal after granting permission.

**Screenshots are captured but OCR text is empty in explicit Tesseract mode.**
Confirm Tesseract is installed with `tesseract --version`. If it is installed in
a custom location, set `processing.ocr.options.binary` in
`~/.hyprmnesia/config.yaml` to the absolute binary path. With the default `auto`
engine, OCR should use the bundled Apple Vision helper instead.

## Linux (Debian/Ubuntu)

Alpha installers are published from GitHub Releases when a `vX.Y.Z` tag is
pushed.

### Install from a GitHub Release

Download `hyprmnesia-<version>-linux-x64.deb` and install it:

```sh
sudo apt install ./hyprmnesia-<version>-linux-x64.deb
```

The DEB installs into `/opt/hyprmnesia` and creates `/usr/bin/hpm`. A portable
`.tar.gz` is also attached for non-Debian systems or manual testing.

### Install from source

Install these tools first:

| Tool | Why |
| --- | --- |
| [Bun](https://bun.sh) | JS/TS runtime used by the CLI and daemon |
| Rust toolchain (`cargo`) | Builds the native helpers |
| Git | Cloning the repository |

Install the system packages used by the native tray, screen capture, audio
capture, OCR, and the Linux capture helper:

```sh
sudo apt install -y \
  cmake \
  libxdo-dev \
  ffmpeg \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  tesseract-ocr
```

- **`cmake`** - builds CTranslate2 from source for the Whisper
  (faster-whisper) ASR helper (`asr/`). A C/C++ toolchain (`build-essential`)
  is also required; it is usually already present.
- **`libxdo-dev`** - required to link the Rust tray helper (`tray/`).
- **`ffmpeg`** - needed for mic and system-audio capture. The bundled
  `ffmpeg-static` binary lacks PulseAudio / PipeWire support, so on Linux
  Hyprmnesia uses the system `ffmpeg`. Debian/Ubuntu builds enable `libpulse`
  by default; `pipewire-pulse` provides the PA socket on modern desktops.
- **`tesseract-ocr`** - provides OCR for screenshots. Install any language
  packs you need separately; on Debian/Ubuntu, they are named
  `tesseract-ocr-<lang>`, for example `tesseract-ocr-fra` for French.
- **GStreamer packages** - required to build and run the Linux capture helper
  that uses the `gstreamer` Rust bindings.

Then clone, install JS dependencies, and build:

```sh
git clone https://github.com/hyprmnesia/hyprmnesia.git
cd hyprmnesia
bun install
bun run build
./dist/hpm --help
```

`dist/hpm` is the user-facing entry point. Native helpers are built
automatically into `dist/native/` and should not be launched directly.

### Session requirement

Screen capture requires a **Wayland** session. It goes through the
xdg-desktop-portal ScreenCast interface via the `hpm-wlcap` helper, which is why
the GStreamer packages above are needed. The first run asks for permission once
and keeps the restore token in `~/.hyprmnesia/`, so later runs are silent.

There is no X11 backend. The old one called ImageMagick's `import` once per
frame and has been removed.

### Verify

Once installed, confirm the daemon starts, runs, and stops cleanly:

```sh
hpm start
hpm status
hpm logs -n 20
hpm stop
```

For a source build, replace `hpm` with `./dist/hpm`.

Captured data lives under `~/.hyprmnesia/`. See the
[README](../README.md#daemon-model) for the list of files the daemon writes
there.

### Troubleshooting

**Screen capture fails on a fresh login.**
Check that the session really is Wayland: `echo $WAYLAND_DISPLAY` must print
something. On X11 the daemon logs `screen capture unavailable` and records
nothing but audio.

**No screenshots, and the log shows the portal was refused.**
The stored restore token no longer matches the session. Delete
`~/.hyprmnesia/wayland-portal-token` and restart the daemon to be asked again.

**Rust build fails with a missing `xdo.h`.**
`libxdo-dev` is not installed. Run `sudo apt install libxdo-dev` and rebuild.

**`ffmpeg` cannot find a PulseAudio source.**
Make sure either PulseAudio or `pipewire-pulse` is running. `pactl info` should
print a server name.

**Screenshots are captured but OCR text is empty.**
Confirm Tesseract is installed with `tesseract --version`. If it is installed in
a custom location, set `processing.ocr.options.binary` in
`~/.hyprmnesia/config.yaml` to the absolute binary path.
