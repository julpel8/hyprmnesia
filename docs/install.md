# Installation

> Back to the [README](../README.md).

Hyprmnesia is Linux-only, and only under a Wayland session.

## Install from a GitHub Release

Alpha installers are published from GitHub Releases when a `vX.Y.Z` tag is
pushed.

Download `hyprmnesia-<version>-linux-x64.deb` and install it:

```sh
sudo apt install ./hyprmnesia-<version>-linux-x64.deb
```

The DEB installs into `/opt/hyprmnesia` and creates `/usr/bin/hpm`. A portable
`.tar.gz` is also attached for non-Debian systems or manual testing.

## Install from source

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
- **`ffmpeg`** - needed for mic and system-audio capture, via the system
  `ffmpeg`. Debian/Ubuntu builds enable `libpulse` by default;
  `pipewire-pulse` provides the PA socket on modern desktops.
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

## Session requirement

Screen capture requires a **Wayland** session. It goes through the
xdg-desktop-portal ScreenCast interface via the `hpm-wlcap` helper, which is why
the GStreamer packages above are needed. The first run asks for permission once
and keeps the restore token in `~/.hyprmnesia/`, so later runs are silent.

There is no X11 backend. The old one called ImageMagick's `import` once per
frame and has been removed.

## Verify

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

## Troubleshooting

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
