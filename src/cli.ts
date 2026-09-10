#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { apiAuthStatus, createDefaultApiAuthStore, rotateApiAuth, setupApiAuth } from './api/auth'
import { type Config, ensureDefaultConfig, loadConfig } from './config'
import {
  clearStopRequest,
  daemonPid,
  ERR_LOG_FILE,
  isDaemonAlive,
  isStopRequested,
  LEVELS_FILE,
  LOG_FILE,
  readLevels,
  spawnDaemon,
  stopDaemon,
} from './core/daemon'
import { subscribeLevelsFile, subscribeNdjsonStdout } from './core/logger'
import { makeOrchestrator } from './core/orchestrator'
import { isTrayAlive, requestTrayQuit } from './core/tray'
import {
  autostartStatus,
  disableAutostart,
  enableAutostart,
  installLauncher,
  uninstallLauncher,
} from './install/launcher'
import { log } from './log'
import { checkForUpdate, envOptOut, formatUpdateNotice, RELEASES_URL } from './update/check'
import { VERSION } from './version'

/**
 * Parses the small hand-rolled CLI flag format used by `hpm`.
 *
 * Supports `--flag`, `--flag value`, `-x`, and `-x value`. Short and long
 * flags share the same key namespace without the leading dashes.
 */
function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    let key: string | undefined
    if (a.startsWith('--')) {
      const raw = a.slice(2)
      const eq = raw.indexOf('=')
      if (eq !== -1) {
        out[raw.slice(0, eq)] = raw.slice(eq + 1)
        continue
      }
      key = raw
    } else if (a.startsWith('-') && a.length > 1) key = a.slice(1)
    else continue
    const next = argv[i + 1]
    if (next && !next.startsWith('-')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function positionalArgs(argv: string[], valueFlags: Set<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (valueFlags.has(key) && argv[i + 1] && !argv[i + 1]!.startsWith('-')) i++
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1)
      if (valueFlags.has(key) && argv[i + 1] && !argv[i + 1]!.startsWith('-')) i++
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * Applies capture daemon overrides from CLI flags onto an already loaded config.
 *
 * These flags are runtime-only: they affect the daemon invocation but are not
 * persisted back to `config.yaml`.
 */
function applyFlags(cfg: Config, flags: Record<string, string | boolean>) {
  /** Converts string-valued numeric flags and leaves malformed values as `NaN`. */
  const n = (v: unknown) => (typeof v === 'string' ? Number(v) : NaN)
  /** Extracts string-valued flags while ignoring boolean switches. */
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  if (flags['screen-interval']) cfg.capture.screen.interval_ms = n(flags['screen-interval'])
  if (flags['screen-format']) {
    const format = s(flags['screen-format'])
    if (format === 'png' || format === 'jpg' || format === 'webp')
      cfg.capture.screen.format = format
  }
  if (flags['screen-quality']) cfg.capture.screen.quality = n(flags['screen-quality'])
  if (flags['screen-max-width']) cfg.capture.screen.max_width = n(flags['screen-max-width'])
  if (flags['audio-format']) {
    const format = s(flags['audio-format'])
    if (format === 'webm' || format === 'wav') cfg.capture.audio.format = format
  }
  if (flags['audio-bitrate']) cfg.capture.audio.bitrate_kbps = n(flags['audio-bitrate'])
  if (flags['audio-chunk']) {
    const ms = n(flags['audio-chunk'])
    cfg.capture.audio.mic.chunk_ms = ms
    cfg.capture.audio.system.chunk_ms = ms
  }
  if (flags['no-screen']) cfg.capture.screen.enabled = false
  if (flags['no-audio']) {
    cfg.capture.audio.mic.enabled = false
    cfg.capture.audio.system.enabled = false
  }
  if (flags['no-mic']) cfg.capture.audio.mic.enabled = false
  if (flags['no-system-audio']) cfg.capture.audio.system.enabled = false
  const mic = s(flags['mic-device'])
  if (mic) cfg.capture.audio.mic.device = mic
  const sys = s(flags['system-device'])
  if (sys) cfg.capture.audio.system.device = sys
  const dataDir = s(flags['data-dir'])
  if (dataDir) cfg.storage.path = dataDir
}

/**
 * Prints public CLI usage.
 *
 * Internal commands prefixed with `_` are intentionally omitted because they are
 * process entrypoints used by the tray and daemon spawner, not user commands.
 */
function help() {
  console.log(`hpm - hyprmnesia

usage:
  hpm [flags]            launch tray and start the capture daemon
  hpm start [flags]      launch tray and start the capture daemon
  hpm logs [-n N] [--no-follow]
                         tail the daemon log (default: last 10 lines + follow)
  hpm stop               stop the running daemon
  hpm quit               stop the daemon and quit the tray icon
  hpm status [--json]    print daemon status
  hpm api [flags]        run the read-only REST API server
  hpm api auth <command> manage API local auth token
  hpm replay [--from <time> --to <time>]
                         open an interactive local replay window
  hpm ui [--no-open]     open the local Hyprmnesia web app (dashboard, search,
                         settings, live transcript)
  hpm launcher install   add a desktop-launcher entry for this binary
                         (Linux .desktop / macOS Hyprmnesia.app); the .deb/.pkg
                         already install one, so this is for the portable build
  hpm launcher uninstall remove the desktop-launcher entry
  hpm autostart enable   start Hyprmnesia automatically at login (opt-in)
  hpm autostart disable  remove the login autostart entry
  hpm autostart status   show whether login autostart is enabled
  hpm update [--check] [--json]
                         check GitHub for a newer release (notify only, never
                         installs); opt out of the automatic check on start with
                         HPM_NO_UPDATE_CHECK=1, CI=1, or update.check: false
  hpm version            print version

flags (for hpm/start):
  --config <path>        config file (default: ~/.hyprmnesia/config.yaml)
  --screen-interval <ms> override screen capture interval
  --screen-format <fmt>  image format: webp, jpg, or png
  --screen-quality <n>   lossy quality 1-100 (webp/jpg only)
  --screen-max-width <n> downscale captures to fit width in px (0 = native)
  --audio-format <fmt>   audio blob format: webm or wav
  --audio-bitrate <n>    Opus bitrate kbps (webm only)
  --audio-chunk <ms>     override chunk duration for both mic and system
  --mic-device <name>    override mic device (default: auto)
  --system-device <name> override system audio device (default: default)
  --no-screen            disable screen capture
  --no-audio             disable both mic and system audio
  --no-mic               disable mic capture only
  --no-system-audio      disable system audio capture only
  --data-dir <path>      override storage path

flags (for hpm api):
  --config <path>        config file (default: ~/.hyprmnesia/config.yaml)
  --db <path>            SQLite index path (default: ~/.hyprmnesia/index.db)
  --bind <addr>          HTTP bind address (default: 127.0.0.1)
  --port <n>             HTTP port (default: 37373)
  --no-auth              confirm running only when config api.auth.enabled=false

commands (for hpm api auth):
  setup                  create and print an API token once
  status                 show API auth status without printing the token
  rotate                 replace and print a new API token once

flags (for hpm replay):
  --from <epoch_ms|iso>  replay start time (optional deep-link)
  --to <epoch_ms|iso>    replay end time (optional deep-link)
  --db <path>            SQLite index path (default: ~/.hyprmnesia/index.db)
  --no-open              print the local URL without opening the browser
`)
}

/**
 * Runs the detached capture worker process.
 *
 * This is launched through `_capture` by the daemon spawner. It owns the
 * orchestrator lifecycle, log subscriptions, and sentinel-file shutdown path.
 */
async function cmdCapture(flags: Record<string, string | boolean>) {
  // Internal worker invoked by spawnDaemon. The `_` prefix hides it from help
  // output and signals "not for direct CLI use": users launch the tray with
  // `hpm`/`hpm start`, while the daemon spawner runs this capture worker.
  const configPath = typeof flags['config'] === 'string' ? flags['config'] : undefined
  const cfg = loadConfig(configPath)
  applyFlags(cfg, flags)
  clearStopRequest()

  const orch = makeOrchestrator(cfg)
  subscribeNdjsonStdout(orch.events)
  subscribeLevelsFile(orch.events, LEVELS_FILE)

  try {
    await orch.start()
  } catch (err) {
    log.error('failed to start orchestrator', { err: String(err) })
    await orch.stop().catch(() => {})
    process.exit(1)
  }

  let shuttingDown = false
  let stopWatch: ReturnType<typeof setInterval>
  /**
   * Stops captures exactly once, whether triggered by a process signal or by
   * the daemon stop sentinel written by `hpm stop`.
   */
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    void (async () => {
      try {
        clearInterval(stopWatch)
        await orch.stop()
        clearStopRequest()
        process.exit(0)
      } catch (err) {
        log.error('failed to stop orchestrator cleanly', { err: String(err) })
        clearStopRequest()
        process.exit(1)
      }
    })()
  }
  stopWatch = setInterval(() => {
    if (isStopRequested()) shutdown()
  }, 250)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * Starts the read-only REST API server.
 *
 * Unlike normal runtime commands, the API is a headless integration surface
 * and should not depend on tray or daemon state.
 */
async function cmdApi(flags: Record<string, string | boolean>, argv: string[]) {
  const positionals = positionalArgs(argv, new Set(['config', 'db', 'bind', 'port']))
  if (positionals[0] === 'auth') {
    cmdApiAuth(positionals.slice(1), flags)
    return
  }

  const configPath = typeof flags['config'] === 'string' ? flags['config'] : undefined
  const cfg = loadConfig(configPath)
  applyApiFlags(cfg, flags)
  if (flags['no-auth'] && cfg.api.auth.enabled) {
    console.error('api: --no-auth requires api.auth.enabled: false in config.yaml')
    process.exit(1)
  }
  if (!cfg.api.auth.enabled && !flags['no-auth']) {
    console.error('api: API auth is disabled in config.yaml; pass --no-auth to confirm')
    process.exit(1)
  }
  const { startApiServer } = await import('./api/server')
  await startApiServer({
    dbPath: typeof flags['db'] === 'string' ? flags['db'] : undefined,
    bind: cfg.api.bind,
    port: cfg.api.port,
    auth: {
      enabled: cfg.api.auth.enabled,
    },
  })
}

function cmdApiAuth(args: string[], flags: Record<string, string | boolean>): void {
  const command = args[0]
  const configPath = typeof flags['config'] === 'string' ? flags['config'] : undefined
  const cfg = loadConfig(configPath)
  const store = createDefaultApiAuthStore()

  if (command === 'setup') {
    const result = setupApiAuth(store)
    if (result.alreadyConfigured) {
      console.log('API auth token already configured.')
      console.log('Run `hpm api auth rotate` to replace it.')
      console.log(`backend: ${result.backend}`)
      return
    }
    console.error(
      'API auth token created. Send it as a Bearer token: Authorization: Bearer <token>.',
    )
    console.error(`backend: ${result.backend}`)
    console.log(result.token)
    return
  }

  if (command === 'status') {
    const status = apiAuthStatus(cfg.api.auth.enabled, store)
    console.log(`API auth: ${status.enabled ? 'enabled' : 'disabled'}`)
    console.log(`token: ${status.configured ? 'configured' : 'not configured'}`)
    console.log(`backend: ${status.backend}`)
    return
  }

  if (command === 'rotate') {
    const result = rotateApiAuth(store)
    console.error(
      'API auth token rotated. Send it as a Bearer token: Authorization: Bearer <token>.',
    )
    console.error(`backend: ${result.backend}`)
    console.log(result.token)
    return
  }

  console.error(`unknown API auth command: ${command ?? '(missing)'}`)
  console.error('expected: setup, status, or rotate')
  process.exit(1)
}

/**
 * Opens a temporary local browser replay for a captured time window.
 *
 * The UI server is read-only, tokenized, and foreground-bound so Ctrl-C can
 * stop it cleanly. It does not start the capture daemon.
 */
async function cmdReplay(flags: Record<string, string | boolean>) {
  const from = typeof flags['from'] === 'string' ? flags['from'] : undefined
  const to = typeof flags['to'] === 'string' ? flags['to'] : undefined
  if ((from === undefined) !== (to === undefined)) {
    console.error('replay: --from and --to must be provided together')
    process.exit(1)
  }

  const { startUiServer } = await import('./ui/server')
  try {
    await startUiServer({
      dbPath: typeof flags['db'] === 'string' ? flags['db'] : undefined,
      from,
      to,
      openBrowser: !flags['no-open'],
      view: 'replay',
    })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

/**
 * Opens the local Hyprmnesia web app (dashboard, search, settings, live).
 *
 * Same ephemeral, tokenized, foreground-bound server as `hpm replay`; it does
 * not start the capture daemon (live views degrade when it is stopped).
 */
async function cmdUi(flags: Record<string, string | boolean>) {
  const { startUiServer } = await import('./ui/server')
  try {
    await startUiServer({
      dbPath: typeof flags['db'] === 'string' ? flags['db'] : undefined,
      openBrowser: !flags['no-open'],
      view: 'ui',
    })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

/**
 * Applies one-shot API bind/port overrides on top of persisted API config.
 */
function applyApiFlags(cfg: Config, flags: Record<string, string | boolean>) {
  if (typeof flags['bind'] === 'string') cfg.api.bind = flags['bind']
  if (typeof flags['port'] === 'string') {
    const port = Number(flags['port'])
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`invalid API port: ${flags['port']}`)
      process.exit(1)
    }
    cfg.api.port = port
  }
}

/**
 * Converts parsed flags back into argv form for spawned helper processes.
 */
function flagsToArgv(flags: Record<string, string | boolean>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(flags)) {
    if (typeof v === 'boolean') {
      if (v) out.push(`--${k}`)
    } else {
      out.push(`--${k}`, v)
    }
  }
  return out
}

/**
 * Starts the detached daemon if it is not already alive.
 *
 * Start locking and duplicate-daemon prevention live in `spawnDaemon`.
 */
function cmdStartDaemon(flags: Record<string, string | boolean>) {
  if (isDaemonAlive()) {
    console.log(`daemon already running (pid ${daemonPid()})`)
    return
  }
  try {
    const pid = spawnDaemon(flagsToArgv(flags))
    console.log(`hyprmnesia started (pid ${pid})`)
    console.log(`logs: ${LOG_FILE}`)
    if (process.platform === 'win32') console.log(`errors: ${ERR_LOG_FILE}`)
  } catch (err) {
    console.error(String(err))
    process.exit(1)
  }
}

/**
 * Stops the capture daemon without changing tray state.
 */
function cmdStop() {
  const r = stopDaemon()
  if (r.stopped) console.log(`daemon stopped (pid ${r.pid})`)
  else if (r.pid) {
    console.error(`failed to stop daemon (pid ${r.pid})`)
    process.exit(1)
  } else console.log('no daemon running')
}

/**
 * Requests a graceful tray quit. Pair with `cmdStop()` for a full shutdown —
 * the `quit` command stops the daemon first, then signals the tray.
 *
 * The native tray consumes the quit sentinel on its next refresh tick and
 * exits its event loop.
 */
function cmdQuit() {
  const r = requestTrayQuit()
  if (r.requested) console.log(`tray quit requested (pid ${r.pid})`)
  else console.log('no tray running')
}

/**
 * Manages the desktop-launcher entry (Linux `.desktop` / macOS app bundle).
 *
 * This is the portable and post-install repair path; system installers write
 * the same content at packaging time. It only touches files — it never starts
 * the tray as a side effect.
 */
function cmdLauncher(args: string[]) {
  const sub = args[0]
  if (sub === 'install') installLauncher()
  else if (sub === 'uninstall') uninstallLauncher()
  else {
    console.error(`unknown launcher command: ${sub ?? '(missing)'}`)
    console.error('expected: install or uninstall')
    process.exit(1)
  }
}

/**
 * Manages opt-in login autostart (Linux XDG autostart / macOS LaunchAgent).
 *
 * Files only, plus `launchctl` on macOS; never starts the tray directly.
 */
function cmdAutostart(args: string[]) {
  const sub = args[0]
  if (sub === 'enable') enableAutostart()
  else if (sub === 'disable') disableAutostart()
  else if (sub === 'status') autostartStatus()
  else {
    console.error(`unknown autostart command: ${sub ?? '(missing)'}`)
    console.error('expected: enable, disable, or status')
    process.exit(1)
  }
}

/**
 * Builds the machine-readable daemon status payload used by `status --json`.
 */
function statusPayload() {
  const pid = daemonPid()
  const running = pid !== undefined && isDaemonAlive()
  return {
    running,
    pid: running ? pid : null,
    logs: LOG_FILE,
    errors: process.platform === 'win32' ? ERR_LOG_FILE : LOG_FILE,
    levels: readLevels(),
  }
}

/**
 * Prints daemon status as JSON or human-readable terminal text.
 */
function cmdStatus(flags: Record<string, string | boolean>) {
  if (flags['json']) {
    console.log(JSON.stringify(statusPayload()))
    return
  }

  const pid = daemonPid()
  if (pid === undefined) {
    console.log('daemon: not running')
    return
  }
  if (isDaemonAlive()) {
    console.log(`daemon: running (pid ${pid})`)
    console.log(`logs: ${LOG_FILE}`)
    if (process.platform === 'win32') console.log(`errors: ${ERR_LOG_FILE}`)
  } else {
    console.log(`daemon: stale pid ${pid} (process dead, file will be cleaned up on next start)`)
  }
}

/**
 * Checks GitHub for a newer release and reports it. Notification-only: it never
 * downloads or installs anything. Always performs a fresh, opt-out-bypassing
 * check because the user asked explicitly.
 */
async function cmdUpdate(flags: Record<string, string | boolean>) {
  const status = await checkForUpdate({ force: true })

  if (flags['json']) {
    console.log(JSON.stringify(status))
    return
  }

  if (status.offline && status.latestVersion === null) {
    console.error('update check failed: could not reach GitHub. Try again later.')
    process.exit(1)
  }

  if (status.offline) {
    console.error('update check could not reach GitHub; showing cached release information.')
  }

  if (status.updateAvailable && status.latestVersion) {
    console.log(
      `A new Hyprmnesia release is available: ${status.currentVersion} -> ${status.latestVersion}`,
    )
    console.log(`  ${status.releaseUrl ?? RELEASES_URL}`)
    console.log(
      'Hyprmnesia does not self-update; download the release or use your package manager.',
    )
    return
  }

  console.log(`Hyprmnesia ${status.currentVersion} is up to date.`)
}

/**
 * Prints a one-time-per-day update notice after `hpm start`, reading from the
 * daily cache and refreshing it in the foreground only when stale. Stays silent
 * on opt-out (env or config) and never lets a failed check affect startup.
 *
 * Runs after the daemon is already spawned and detached, so a slow check delays
 * only the returning prompt — never capture.
 */
async function maybeNotifyUpdate(flags: Record<string, string | boolean>) {
  if (envOptOut()) return
  try {
    const configPath = typeof flags['config'] === 'string' ? flags['config'] : undefined
    if (!loadConfig(configPath).update.check) return
    const notice = formatUpdateNotice(await checkForUpdate())
    if (notice) console.log(`\n${notice}`)
  } catch {
    // Update checks are best-effort; never surface their failures on start.
  }
}

function isInsideDir(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Hidden release-only smoke test. It exercises runtime asset lookup from the
 * packaged executable so CI catches build-machine paths baked into releases.
 */
async function cmdSmokeRelease() {
  const { getFfmpegPath } = await import('./capture/ffmpeg')
  const ffmpeg = getFfmpegPath()
  if (process.platform !== 'linux' && !isInsideDir(ffmpeg, dirname(process.execPath))) {
    console.error(`ffmpeg resolved outside packaged app: ${ffmpeg}`)
    process.exit(1)
  }

  const result = spawnSync(ffmpeg, ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    const details = [String(result.error ?? ''), result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n')
      .trim()
    console.error(`ffmpeg smoke failed${details ? `: ${details}` : ''}`)
    process.exit(1)
  }

  console.log(`ffmpeg: ${ffmpeg}`)
  console.log('release smoke ok')
}

/**
 * Tails the daemon log, optionally following it across rotation.
 */
function cmdLogs(flags: Record<string, string | boolean>) {
  const rawN = flags['n']
  const n = typeof rawN === 'string' ? Math.max(0, Number(rawN)) : 10
  if (!Number.isFinite(n)) {
    console.error(`invalid -n value: ${rawN}`)
    process.exit(1)
  }
  const follow = !flags['no-follow']

  if (!existsSync(LOG_FILE)) {
    console.error(`no log file at ${LOG_FILE}`)
    if (!follow) process.exit(1)
  }

  let position = 0
  if (existsSync(LOG_FILE)) {
    const content = readFileSync(LOG_FILE, 'utf8')
    const lines = content.split('\n')
    const nonEmpty = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    const tail = nonEmpty.slice(Math.max(0, nonEmpty.length - n))
    for (const line of tail) process.stdout.write(line + '\n')
    position = Buffer.byteLength(content, 'utf8')
  }

  if (!follow) return

  const watcher = watch(LOG_FILE, () => {
    try {
      const stats = statSync(LOG_FILE)
      // A shrunk file means spawnDaemon rotated it under us; start over from
      // the new head so we don't seek past the end of the fresh log.
      if (stats.size < position) position = 0
      if (stats.size === position) return
      const fd = openSync(LOG_FILE, 'r')
      const buf = Buffer.alloc(stats.size - position)
      readSync(fd, buf, 0, buf.length, position)
      closeSync(fd)
      process.stdout.write(buf.toString('utf8'))
      position = stats.size
    } catch {
      // file may have been rotated; the next watch event will re-read
    }
  })

  /**
   * Closes the filesystem watcher before exiting on Ctrl-C/SIGTERM.
   */
  const cleanup = () => {
    watcher.close()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

/**
 * Returns the platform-specific native tray executable name.
 */
function trayBinaryName(): string {
  return process.platform === 'win32' ? 'hpm-tray.exe' : 'hpm-tray'
}

/**
 * Finds the tray helper in packaged, development, or Cargo output locations.
 */
function findTrayBinary(): string | undefined {
  const name = trayBinaryName()
  const candidates = [
    join(dirname(process.execPath), 'native', name),
    join(dirname(process.execPath), name),
    join(process.cwd(), 'dist', 'native', name),
    join(process.cwd(), 'dist', name),
    join(process.cwd(), 'tray', 'target', 'release', name),
    join(process.cwd(), 'tray', 'target', 'debug', name),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

/**
 * Launches the native tray supervisor as a detached process.
 */
function launchTray(flags: Record<string, string | boolean>, opts: { autoStart: boolean }) {
  const tray = findTrayBinary()
  if (!tray) {
    console.error(`tray binary not found; run: bun run build`)
    process.exit(1)
  }

  const proc = spawn(tray, flagsToArgv(flags), {
    detached: true,
    env: opts.autoStart ? process.env : { ...process.env, HPM_TRAY_NO_AUTOSTART: '1' },
    stdio: 'ignore',
    windowsHide: true,
  })
  proc.unref()
}

/**
 * Ensures the default config exists and starts the tray for UI-oriented commands.
 */
function ensureTray(
  flags: Record<string, string | boolean> = {},
  opts: { autoStart?: boolean } = {},
) {
  ensureDefaultConfig(typeof flags['config'] === 'string' ? flags['config'] : undefined)
  if (isTrayAlive()) return
  launchTray(flags, { autoStart: opts.autoStart ?? false })
}

const argv = process.argv.slice(2)
const firstArg = argv[0]
const cmd = firstArg && !firstArg.startsWith('-') ? firstArg : undefined
const rest = cmd === undefined ? argv : argv.slice(1)
const flags = parseFlags(rest)

if (flags['help'] || flags['h']) {
  help()
  process.exit(0)
}

switch (cmd) {
  case undefined:
  case 'start':
    ensureTray(flags)
    cmdStartDaemon(flags)
    await maybeNotifyUpdate(flags)
    break
  case '_daemon':
    cmdStartDaemon(flags)
    break
  case '_capture':
    await cmdCapture(flags)
    break
  case 'logs':
    ensureTray()
    cmdLogs(flags)
    break
  case 'stop':
    cmdStop()
    break
  case 'quit':
    cmdStop()
    cmdQuit()
    break
  case 'status':
    ensureTray()
    cmdStatus(flags)
    break
  case '_status':
    cmdStatus(flags)
    break
  case '_smoke-release':
    await cmdSmokeRelease()
    break
  case 'api':
    await cmdApi(flags, rest)
    break
  case 'replay':
    ensureTray()
    await cmdReplay(flags)
    break
  case 'ui':
    ensureTray()
    await cmdUi(flags)
    break
  case 'launcher':
    cmdLauncher(positionalArgs(rest, new Set()))
    break
  case 'autostart':
    cmdAutostart(positionalArgs(rest, new Set()))
    break
  case 'update':
    await cmdUpdate(flags)
    break
  case 'version':
    console.log(VERSION)
    break
  case 'help':
  case '--help':
  case '-h':
    help()
    break
  default:
    console.error(`unknown command: ${cmd}`)
    help()
    process.exit(1)
}
