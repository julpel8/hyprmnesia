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
- [Rust/Cargo](https://rustup.rs), used to build the native tray, ASR, and
  Wayland-capture helpers (install via `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- [CMake](https://cmake.org), required to build the `sentencepiece-sys`
  native dependency pulled in by the embed/tokenizer stack: on Debian/Ubuntu,
  `sudo apt install cmake`.

On Debian/Ubuntu, install the system packages used by the native tray helper,
screen capture and audio capture:

```sh
sudo apt install \
  build-essential cmake pkg-config \
  libxdo-dev libdbus-1-dev libgtk-3-dev libayatana-appindicator3-dev \
  libssl-dev ffmpeg
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
- `ffmpeg`: needed for mic/system audio capture, via the system `ffmpeg`
  (Debian/Ubuntu builds enable `libpulse` by default; `pipewire-pulse`
  provides the PA socket on modern desktops).

Screen capture on Linux requires a **Wayland session**. It goes through the
xdg-desktop-portal ScreenCast interface via the `hpm-wlcap` helper, which asks
once for permission and stores the restore token in `~/.hyprmnesia/`. There is
no X11 backend: the old one shelled out to ImageMagick's `import` once per
frame and has been removed.

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

Verify it answers:

```sh
syncthing cli show system | head -5
```

`syncthing cli` talks to the running daemon over its local REST API and picks up
the API key from `~/.config/syncthing/config.xml` on its own. If it prints a
connection error, the daemon is not running.

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

From another machine, a search should return results drawn from every machine
present in the folder.

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
bun run src/cli.ts audio           # print the audio capture switches
bun run src/cli.ts audio mic off   # switch mic capture off (on|off|toggle)
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
./dist/hpm audio system toggle # flip the system-audio switch
```

`dist/hpm` is the user-facing entrypoint. Native helpers are built
automatically into `dist/native/` and should not be launched directly.

## REST API

`hpm api` serves the read API on 127.0.0.1 for scripts and agents. It runs until
you stop it, opens no browser, and needs no token: the port is bound to loopback
only, and any process on this machine already has the index file itself.

```sh
hpm api                # serves http://127.0.0.1:41890
hpm api --port 41999   # somewhere else
hpm api url            # print the address of the running server
```

The address is also written to `~/.hyprmnesia/api.json` while the server runs
and removed when it stops, so a caller can find it without being told:

```sh
BASE=$(hpm api url)
curl -s "$BASE/api/search?q=facture&limit=5"
```

Endpoints:

| route | what it returns |
| --- | --- |
| `GET /api/ping` | `{"ok":true}`, a liveness check |
| `GET /api/status` | daemon state and per-source capture status |
| `GET /api/search?q=&limit=&mode=` | full-text, semantic or hybrid search over screen text and transcripts |
| `GET /api/timeline?from=&to=` | captured chunks in a time range |
| `GET /api/activity?from=&to=` | chunks grouped into sessions by window and time |
| `GET /api/period-activity?from=&to=` | day and session summaries with excerpts |
| `GET /api/range` | the oldest and newest capture times on record |
| `GET /api/manifest?from=&to=` | everything replay needs for a range, transcript segments included |
| `GET /api/hosts` | the machines present in the shared storage tree |
| `GET /api/logs` | recent daemon log lines |
| `GET /api/events` | server-sent events: live status, audio levels, transcript segments |

Times are epoch milliseconds or ISO strings. Every timestamped response carries
both a local and a UTC rendering, so a caller never has to guess the timezone.

The same routes back the local web app, which is why `/api/config` and the
`/api/daemon/*` routes exist too. Those write, and a write from a browser page
on another origin is refused; `curl` sends no `Origin` header and is allowed.

This replaced the MCP server. There is no protocol to speak, no tool schema to
load, and no separate process to run: an agent curls the routes above.

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
- `Mic capture: on/off`: switches microphone capture (restarts a running daemon)
- `System audio: on/off`: switches system audio capture (same)
- `Open log folder`: opens `~/.hyprmnesia/`
- `Enable launch at login` / `Disable launch at login`
- `Quit Hyprmnesia`: removes the tray icon only; it does not stop captures

## Daemon Model

The daemon is a detached `hpm _capture` process controlled by local files:

- `~/.hyprmnesia/daemon.pid`: running daemon PID
- `~/.hyprmnesia/daemon.log`: daemon NDJSON log (one event per line)
- `~/.hyprmnesia/daemon.log.1`: rotated copy when the active log exceeds 10 MB
- `~/.hyprmnesia/daemon.start.lock`: start lock to prevent duplicate daemons
- `~/.hyprmnesia/levels.json`: latest mic/system RMS, refreshed every 100 ms
- `~/.hyprmnesia/tray.lock`: tray single-instance lock

`hpm start` is guarded by a start lock, so concurrent invocations converge on
one running daemon instead of spawning duplicates.

Audio switches also live in the dashboard's Sources panel and in
`hpm audio <mic|system> [on|off|toggle]`. All three write
`capture.audio.<source>.enabled` in the config; because the daemon only reads
capture config at startup, flipping a switch restarts it when it is running.

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
    device: gpu
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
```

`storage.path` is the shared Syncthing root, `storage.host_id` the name of
this machine's subdirectory inside it, and `storage.snapshot_interval_minutes`
how often the live database is republished there. See
[Multi-Device Storage](#multi-device-storage-syncthing).

OCR engines: `auto`, `tesseract`, `noop`.
Transcription engines: `parakeet`, `whisper`, or `off`. Either engine can be the
main one. `off` keeps recording audio and stops transcribing it; the old `noop`
name means the same thing. Old `auto` configs are treated as Parakeet, and
`whisper-cli` is no longer used in the normal runtime path.
Parakeet model: `parakeet-tdt-0.6b-v3`. Whisper models are the faster-whisper
CTranslate2 ones, `whisper-large-v3-turbo` down to `whisper-tiny`. The ASR
helper auto-downloads a model to the Hugging Face cache on first use; capture
continues while it is loading, but audio recorded before the model is ready is
not transcribed.

### Where transcription runs

`processing.transcription.device` picks the backend for both engines.

`gpu` (the default) runs the ggml servers over Vulkan, which reaches an Intel,
AMD or NVIDIA GPU through one backend. Parakeet is served by `parakeet-server`
from parakeet.cpp, Whisper by `whisper-server` from whisper.cpp. Each loads its
model once and keeps it resident; the daemon posts one WAV per stretch of
speech. Install them with:

```sh
bun run scripts/setup-gpu-asr.ts --models medium
```

That drops the servers in `dist/native/gpu` and the models in
`~/.hyprmnesia/gpu-models`. parakeet.cpp publishes a Vulkan binary, whisper.cpp
does not, so whisper.cpp is compiled by the script; the shader compiler it needs
is unpacked from its Debian package into a scratch prefix, so nothing is
installed system-wide and no root is required. The machine needs `libvulkan1`, a
Vulkan driver (`mesa-vulkan-drivers` for Intel and AMD), `cmake` and a C++
compiler.

`cpu` runs the bundled `hpm-asr` worker instead: CTranslate2 for Whisper, ONNX
for Parakeet, no GPU. Whisper there costs several times the duration of the
audio it transcribes, because Whisper encodes a fixed 30-second window whatever
the segment length.

Segmentation moves with the device. On `cpu` the Rust worker cuts speech with
webrtc-vad; on `gpu` the daemon does it, since the servers only transcribe a
buffer handed to them. Both read the same `live` settings.

### Running two engines at once

`processing.transcription.compare` names a second engine that transcribes the
same audio as the first, so both transcripts can be read side by side:

```yaml
  transcription:
    engine: parakeet
    options:
      model: parakeet-tdt-0.6b-v3
    compare:
      engine: whisper
      options:
        model: whisper-large-v3-turbo
        language: fr
```

Live and Replay then show the two takes on each stretch of speech, labelled by
engine. There is no key to set to turn this off: delete `compare` and only one
engine runs. The settings editor writes `off` for the same effect, which
normalizeConfig turns into a missing key.

Both engines are handed identical audio and the primary engine's `live`
segmentation settings, which is what makes their segments start and end together
and line up as pairs. The compare engine has no `live` block of its own for that
reason, and it cannot name the same family as the primary.

The primary engine stays the one of record: only its words become the chunk's
text, reach the search index and get embedded. The compare engine's segments are
stored and displayed and nothing else. It also costs a second model in memory
and a second transcription per segment, so leave it off unless you are actually
comparing.

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

Linux only, and only under a Wayland session:

| Capability     | Status                                        |
| -------------- | ---------------------------------------------- |
| Screen capture | OK (Wayland portal), no X11                    |
| Mic            | OK (pulse)                                     |
| System audio   | `@DEFAULT_MONITOR@` via pulse                  |
| Window context | OK on X11, none on Wayland                     |

Screen capture reads text off the frame afterwards, never while capturing: the
frame is stored first and `OcrQueue` fills in the text. A slow OCR engine costs
searchable text, never frames.

## Roadmap

- [ ] Harden Parakeet ASR
- [x] SQLite FTS5 query APIs over OCR + transcript segments
- [ ] Encrypted at-rest blob storage
- [ ] Linux smoke testing

## License

TBD.
