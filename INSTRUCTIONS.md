## What It Captures

- **Screenshots** every N seconds, default 5s, with OCR hooks
- **Microphone audio** in chunks, default 30s, with transcription hooks
- **System audio** in chunks, with transcription hooks
- **Active window context**: app name, title, and browser URL when available
  is stored on both screenshots and audio chunks

Everything stays local under `~/.hyprmnesia/`. There is no upload and no
telemetry.

## Install

For development:

```sh
git clone https://github.com/hyprmnesia/hyprmnesia.git
cd hyprmnesia
bun install
```

Build requirements:

- [Bun](https://bun.sh)
- [Rust/Cargo](https://rustup.rs), used to build the native tray, OCR, and ASR
  helpers (install via `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- [CMake](https://cmake.org), required to build the `sentencepiece-sys`
  native dependency pulled in by the embed/tokenizer stack. On macOS:
  `brew install cmake`; on Debian/Ubuntu: `sudo apt install cmake`.

On **Windows**, system-audio capture requires [Screen Capturer Recorder](https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases),
which registers the `virtual-audio-capturer` dshow device. Use
`--no-system-audio` to skip system audio.

On **Linux** (Debian/Ubuntu), install the system packages used by the native
tray helper, screen capture and audio capture:

```sh
sudo apt install \
  build-essential cmake pkg-config \
  libxdo-dev libdbus-1-dev libgtk-3-dev libayatana-appindicator3-dev \
  libssl-dev imagemagick ffmpeg
```

- `build-essential` + `cmake`: the OCR/ASR helpers compile C/C++ sources at
  build time (CTranslate2 via `ct2rs`, `sentencepiece-sys`).
- `pkg-config`: used by every `-sys` crate below to locate system libraries.
- `libxdo-dev`: required to link the Rust tray helper (`tray/`).
- `libdbus-1-dev`: the tray helper's `tao` / `notify-rust` deps link against
  D-Bus via `libdbus-sys`.
- `libgtk-3-dev`: GTK3 stack the tray (`tray-icon`) builds against on Linux —
  covers the `gtk-sys` / `gdk-sys` / `glib-sys` / `cairo` / `pango` / `atk` /
  `gdk-pixbuf` `-sys` crates.
- `libayatana-appindicator3-dev`: the tray indicator backend (`libappindicator-sys`).
  Use `libappindicator3-dev` on older distros if the ayatana package is missing.
- `libssl-dev`: the OCR/ASR helpers' `hf-hub` model downloader links against
  system OpenSSL via `openssl-sys`.
- `imagemagick`: provides the `import` command that `screenshot-desktop`
  invokes under the hood.
- `ffmpeg`: needed for mic/system audio capture. The bundled `ffmpeg-static`
  binary lacks PulseAudio/PipeWire support, so on Linux Hyprmnesia uses the
  system `ffmpeg` (Debian/Ubuntu builds enable `libpulse` by default;
  `pipewire-pulse` provides the PA socket on modern desktops).

Screen capture currently requires an **Xorg session** — `import` is X11-only.
Wayland support is tracked in
[#8](https://github.com/hyprmnesia/hyprmnesia/issues/8). To switch, log out
and pick "Ubuntu on Xorg" (or your distro's equivalent) at the login screen.

## Multi-Device Storage (Syncthing)

Hyprmnesia records on every machine and reads all of them at once. Each machine
owns one subdirectory of a shared Syncthing folder: it writes its own, and reads
the others. Nothing in Hyprmnesia ever opens another machine's database or blobs
for writing.

This section is written to be executed step by step, including by an agent. Every
command is non-interactive; no web UI is needed.

### Layout

The shared folder, identical on every machine, send-receive everywhere:

```
~/hyprmnesia-sync/
  .stignore                 # *.tmp, *-wal, *-shm
  rpi5/
    index.db                # snapshot, written only by rpi5
    data/screenshot/2026/09/02/<uuid>.webp
    data/audio_mic/...
    data/audio_system/...
  dell/
    index.db
    data/...
```

`~/.hyprmnesia/` stays local and is **never** synced. It holds `config.yaml`,
`daemon.log`, `daemon.pid`, `tray.lock`, `engines/`, and the live WAL database
`index.db` that the daemon writes. Every 5 minutes (and once on clean shutdown)
the daemon publishes a consistent copy of that database to
`~/hyprmnesia-sync/<host_id>/index.db` with `VACUUM INTO` plus an atomic rename,
so Syncthing never sees a half-written file.

Blob paths in the database are relative to the machine's own directory, which is
what makes them resolvable after a copy.

### 1. Install Syncthing

Debian/Ubuntu/Raspberry Pi OS:

```sh
sudo apt install -y syncthing
systemctl --user enable --now syncthing
```

macOS:

```sh
brew install syncthing
brew services start syncthing
```

Verify it answers:

```sh
syncthing cli show system | head -5
```

`syncthing cli` talks to the running daemon over its local REST API and picks up
the API key from `~/.config/syncthing/config.xml` (or `~/Library/Application
Support/Syncthing/`) on its own. If it prints a connection error, the daemon is
not running.

### 2. Create the shared directory

On every machine, before adding the folder to Syncthing:

```sh
mkdir -p ~/hyprmnesia-sync
cat > ~/hyprmnesia-sync/.stignore <<'EOF'
*.tmp
*-wal
*-shm
EOF
```

Those three patterns keep SQLite's transient files out of the sync. Syncing a
`-wal` file would hand other machines a database that cannot be opened.

### 3. Collect the device IDs

On each machine:

```sh
syncthing --device-id
```

Prints one line, for example
`2MKJZT7-TN2LEZ6-HDK7QDO-M5PUXXZ-3PNGN6U-FL5TTFB-GQWF7TK-2ZYW4QL`. Collect one
per machine before continuing; the next step needs all of them.

### 4. Pair the machines

On every machine, add every *other* machine as a device:

```sh
syncthing cli config devices add --device-id=<OTHER_DEVICE_ID> --name=<other-host>
```

Check the result:

```sh
syncthing cli config devices list
```

Pairing is symmetric: machine A must list B and B must list A, otherwise the
connection is never established.

### 5. Create the shared folder

On every machine, with the same folder ID everywhere:

```sh
syncthing cli config folders add --id=hyprmnesia --label=Hyprmnesia \
  --path="$HOME/hyprmnesia-sync" --type=sendreceive
```

Then share it with each other device:

```sh
syncthing cli config folders hyprmnesia devices add --device-id=<OTHER_DEVICE_ID>
```

Check:

```sh
syncthing cli config folders list
syncthing cli config folders hyprmnesia devices list
syncthing cli show connections
```

Do not enable file versioning on this folder. Captures are written once and never
modified, so versioning only doubles the disk usage.

### 6. Give each machine a unique host id

`storage.host_id` in `~/.hyprmnesia/config.yaml` is the name of the machine's
subdirectory. It defaults to the system hostname, lowercased with anything
outside `a-z0-9-` replaced by `-`.

```yaml
storage:
  path: ~/hyprmnesia-sync
  host_id: rpi5
  snapshot_interval_minutes: 5
```

Two machines sharing a `host_id` would write the same database and the same blob
paths, and Syncthing would produce conflict files out of it. Check the values are
distinct before starting the daemons:

```sh
grep -A2 '^storage:' ~/.hyprmnesia/config.yaml
```

### 7. Verify

Start Hyprmnesia (`hpm start`), wait a few minutes, then on the recording
machine:

```sh
ls ~/hyprmnesia-sync/$(hostname | tr 'A-Z' 'a-z')/data/screenshot/*/*/*/ | head
ls -l ~/hyprmnesia-sync/*/index.db
```

From another machine, an API search should return results carrying a `host` field
for each machine present in the folder.

### Warnings

- Never put `~/.hyprmnesia/` itself in a Syncthing folder. The live database is in
  WAL mode; copying it file by file between machines corrupts it.
- Never share this folder with a phone. It grows without bound: roughly 40 MB per
  half-day of recording per machine, with no retention policy in Hyprmnesia yet.
  Every machine holds every other machine's captures.
- Every machine must use the same embedding model and dimension
  (`multilingual-e5-small`, 384) or semantic search on one machine will only
  surface its own results.

## Usage

During development:

```sh
bun run src/cli.ts            # launch tray and start the background daemon
bun run src/cli.ts start      # same as above
bun run src/cli.ts logs       # tail the daemon log (default: last 10 + follow)
bun run src/cli.ts stop       # stop the daemon
bun run src/cli.ts status     # print daemon status
bun run src/cli.ts status --json
bun run src/cli.ts api        # run the read-only REST API server
```

After building:

```sh
bun run build                 # produces dist/hpm
./dist/hpm                    # launch tray and start the background daemon
./dist/hpm start              # same as above
./dist/hpm ui                 # open the local web app (dashboard, search, settings, live)
./dist/hpm replay             # open the replay window (deep-link: --from --to)
./dist/hpm logs -n 50         # show last 50 log lines + follow
./dist/hpm status --json
./dist/hpm api                # read-only REST API server
```

`dist/hpm` is the user-facing entrypoint. Native helpers are built
automatically into `dist/native/` and should not be launched directly.

## API Server

Hyprmnesia exposes a local **read-only** REST API over HTTP. It reads the
local database `~/.hyprmnesia/index.db` plus every other machine's database found
under the shared storage root, never starts the tray, never starts the daemon, and
does not write migrations, reindex data, delete captures, or return screenshot
/ audio bytes by default.

During development:

```sh
bun run src/cli.ts api
bun run src/cli.ts api --db ~/.hyprmnesia/index.db
bun run src/cli.ts api --bind 127.0.0.1 --port 37373
```

`--db` reads that one database alone; without it, every machine in the shared
storage root is read.

Default API config:

```yaml
api:
  bind: 127.0.0.1
  port: 37373
  auth:
    enabled: true
```

Hyprmnesia refuses non-local binds such as `0.0.0.0`. Auth is enabled by
default; get a token with `hpm api auth setup` and send it as a Bearer header:

```sh
TOKEN=$(hpm api auth setup | tail -1)
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:37373/search?query=invoice'
```

Available routes:

| Route | Purpose |
| --- | --- |
| `GET /search` | FTS/semantic search over OCR text, window context, and transcript segments |
| `GET /recent-activity` | grouped activity over a recent, short time window |
| `GET /period-activity` | sessions and per-day aggregates over a required `from` / `to` range |
| `GET /timeline` | chronological chunks for a required `from` / `to` range |
| `GET /recall/:id` | full chunk details plus linked transcript segments |
| `GET /transcript-segment/:id` | one precise transcript segment, optionally with its parent chunk |

Common filters are `from`, `to`, `source` (`screen`, `mic`, `system`), `app`,
`limit`, and `offset`, passed as query-string parameters. Times can be ISO
strings or epoch milliseconds; ISO strings without a timezone are interpreted
in the user's local timezone. Results include both UTC fields (`utc_*` /
legacy `iso_*`) and local fields (`local_*` + `timezone`); agents should use
`local_*` when answering the user. `recall` only includes local `blob_path`
metadata when `include_blob=true`; v1 does not stream screenshots or audio
through the API.

## Tray App

The tray app lives next to the system clock and supervises the capture daemon.
Launch it with `hpm` or `hpm start`; both commands ensure the tray and daemon
are alive. The tray reflects state changes via the icon color, tooltip, and OS
notifications.

Tray menu:

- `Open Dashboard`: opens the local web app (`hpm ui`) in the browser
- `Open Replay...`: opens the replay window (`hpm replay`)
- `Start daemon`: starts background captures
- `Stop daemon`: stops background captures
- `Open log folder`: opens `~/.hyprmnesia/`
- `Enable launch at login` / `Disable launch at login`
- `Quit Hyprmnesia`: removes the tray icon only; it does not stop captures

## Daemon Model

The daemon is a detached `hpm _capture` process controlled by local files:

- `~/.hyprmnesia/daemon.pid`: running daemon PID
- `~/.hyprmnesia/daemon.log`: daemon NDJSON log (one event per line)
- `~/.hyprmnesia/daemon.log.1`: rotated copy when the active log exceeds 10 MB
- `~/.hyprmnesia/daemon.err.log`: Windows daemon stderr log
- `~/.hyprmnesia/daemon.start.lock`: start lock to prevent duplicate daemons
- `~/.hyprmnesia/levels.json`: latest mic/system RMS, refreshed every 100 ms
- `~/.hyprmnesia/tray.lock`: tray single-instance lock

`hpm start` is guarded by a start lock, so concurrent invocations converge on
one running daemon instead of spawning duplicates.

## Flags

```sh
--config <path>           config file, default ~/.hyprmnesia/config.yaml
--data-dir <path>         where to store blobs and the index
--screen-interval <ms>    screen capture interval
--audio-chunk <ms>        chunk duration for mic and system audio
--mic-device <name>       override mic device
--system-device <name>    override system audio device
--no-screen               disable screen capture
--no-audio                disable both audio streams
--no-mic                  disable mic only
--no-system-audio         disable system audio only
```

## Configuration

Default YAML config is created automatically at `~/.hyprmnesia/config.yaml`
when Hyprmnesia starts. Existing `config.json` files are still read and migrated
into YAML if no YAML file exists.

```yaml
capture:
  screen:
    enabled: true
    interval_ms: 5000
    monitor: primary
    format: png
  audio:
    sample_rate: 16000
    echo_suppression:
      enabled: true
      system_threshold_db: -45
      mic_margin_db: 6
      hold_ms: 500
    mic:
      enabled: true
      device: default
      chunk_ms: 30000
    system:
      enabled: true
      device: default
      chunk_ms: 30000
processing:
  ocr:
    engine: auto
    options:
      lang: eng
  transcription:
    engine: parakeet
    options:
      model: parakeet-tdt-0.6b-v3
      live:
        enabled: true
        min_segment_ms: 750
        target_segment_ms: 4000
        max_segment_ms: 6000
        silence_ms: 700
        rms_gate: 0.003
storage:
  path: ~/hyprmnesia-sync
  host_id: rpi5
  snapshot_interval_minutes: 5
api:
  bind: 127.0.0.1
  port: 37373
  auth:
    enabled: true
```

`storage.path` is the shared Syncthing root, `storage.host_id` the name of
this machine's subdirectory inside it, and `storage.snapshot_interval_minutes`
how often the live database is republished there. See
[Multi-Device Storage](#multi-device-storage-syncthing).

OCR engines: `auto`, `native`, `tesseract`, `noop`.
Transcription engines: `parakeet`, `noop`. Old `auto` / `whisper` configs are
treated as Parakeet for compatibility; `whisper-cli` is no longer used in the
normal runtime path.
Parakeet model: `parakeet-tdt-0.6b-v3`. The ASR helper auto-downloads the model
to the Hugging Face cache on first use; capture continues while it is loading,
but audio recorded before the model is ready is not transcribed.

`capture.audio.echo_suppression` is a transcript guard for speaker bleed: when
system audio is active, mic frames are only sent to ASR if the mic is clearly
louder than the mixer. It reduces duplicated speaker text in the mic transcript;
it is not full acoustic echo cancellation of the saved mic WAV.

## Architecture

```text
hpm
|-- tray controller (native helper in dist/native)
|   |-- starts/stops daemon through hpm commands
|   |-- opens the local web app and the replay window
|
|-- daemon
    |-- hpm _capture
    |-- Orchestrator -> EventBus -> captures
        |-- screen
        |-- audio -> PCM stream -> hpm-asr Parakeet worker
        |-- active window
        `-- blob store / index
```

Captures emit typed events on a shared event bus. The orchestrator tracks
status, the local web app subscribes for live updates, and the headless logger
writes JSON logs.

## Platform Support

|                | Windows                                | macOS (TODO)              | Linux  (TODO)                            |
| -------------- | -------------------------------------- | ------------------- | ---------------------------------- |
| Screen capture | OK                                     | OK                  | OK (X11), Wayland TBD              |
| Mic            | OK (dshow)                             | OK (avfoundation)   | OK (pulse)                         |
| System audio   | needs Screen Capturer Recorder         | needs BlackHole 2ch | `@DEFAULT_MONITOR@` via pulse      |
| Window context | OK                                     | OK + URL            | OK on X11, none on Wayland         |

## Roadmap

- [ ] Harden Parakeet ASR across Windows/macOS/Linux
- [x] SQLite FTS5 query APIs over OCR + transcript segments
- [ ] Encrypted at-rest blob storage
- [x] Read-only REST API exposing `search`, `timeline`, `recall`, segments
- [ ] macOS / Linux smoke testing

## License

TBD.
