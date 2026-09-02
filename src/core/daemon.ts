import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME_DIR = join(homedir(), '.hyprmnesia')
const PID_FILE = join(HOME_DIR, 'daemon.pid')
export const LOG_FILE = join(HOME_DIR, 'daemon.log')
export const ERR_LOG_FILE = join(HOME_DIR, 'daemon.err.log')
export const LEVELS_FILE = join(HOME_DIR, 'levels.json')
const STOP_FILE = join(HOME_DIR, 'daemon.stop')
const ROTATED_LOG_FILE = join(HOME_DIR, 'daemon.log.1')
const LOG_ROTATE_THRESHOLD_BYTES = 10 * 1024 * 1024
const DAEMON_LOCK_FILE = join(HOME_DIR, 'daemon.start.lock')
const DAEMON_LOCK_MAX_AGE_MS = 15_000

export function readLevels(): { mic: number; system: number } {
  try {
    const raw = readFileSync(LEVELS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const mic = typeof parsed.mic === 'number' ? parsed.mic : -60
    const system = typeof parsed.system === 'number' ? parsed.system : -60
    return { mic, system }
  } catch {
    return { mic: -60, system: -60 }
  }
}

function rotateLogIfLarge() {
  try {
    const size = statSync(LOG_FILE).size
    if (size < LOG_ROTATE_THRESHOLD_BYTES) return
    try {
      unlinkSync(ROTATED_LOG_FILE)
    } catch {}
    renameSync(LOG_FILE, ROTATED_LOG_FILE)
  } catch {
    // File doesn't exist yet or rename failed; nothing to rotate.
  }
}

function ensureHome() {
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true })
}

export function daemonPid(): number | undefined {
  if (!existsSync(PID_FILE)) return undefined
  try {
    const raw = readFileSync(PID_FILE, 'utf8').trim()
    const pid = Number(raw)
    if (!Number.isFinite(pid) || pid <= 0) return undefined
    return pid
  } catch {
    return undefined
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function isDaemonAlive(): boolean {
  const pid = daemonPid()
  return pid !== undefined && isPidAlive(pid)
}

function aliveDaemonPidFromFile(): number | undefined {
  const pid = daemonPid()
  if (pid === undefined) return undefined
  if (isPidAlive(pid)) return pid
  try {
    unlinkSync(PID_FILE)
  } catch {}
  return undefined
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitForDaemonStarted(timeoutMs: number): number | undefined {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = aliveDaemonPidFromFile()
    if (pid !== undefined) return pid
    sleepSync(100)
  }
  return aliveDaemonPidFromFile()
}

function waitForPidStopped(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    sleepSync(100)
  }
  return !isPidAlive(pid)
}

function signalDaemonPid(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {}
  }
  try {
    process.kill(pid, signal)
  } catch {}
}

function forceStopDaemonPid(pid: number): void {
  signalDaemonPid(pid, 'SIGKILL')
}

function clearStaleStartLock(): void {
  try {
    const age = Date.now() - statSync(DAEMON_LOCK_FILE).mtimeMs
    if (age > DAEMON_LOCK_MAX_AGE_MS) unlinkSync(DAEMON_LOCK_FILE)
  } catch {}
}

function acquireStartLock(): number | undefined {
  clearStaleStartLock()
  try {
    const fd = openSync(DAEMON_LOCK_FILE, 'wx')
    writeFileSync(fd, `${process.pid}\n${Date.now()}\n`)
    return fd
  } catch {
    return undefined
  }
}

function releaseStartLock(fd: number): void {
  try {
    closeSync(fd)
  } catch {}
  try {
    unlinkSync(DAEMON_LOCK_FILE)
  } catch {}
}

export function isStopRequested(): boolean {
  return existsSync(STOP_FILE)
}

function requestDaemonStop(): void {
  ensureHome()
  writeFileSync(STOP_FILE, String(Date.now()))
}

export function clearStopRequest(): void {
  try {
    if (existsSync(STOP_FILE)) unlinkSync(STOP_FILE)
  } catch {}
}

function buildRespawnArgs(extraArgs: string[]): { command: string; args: string[] } {
  const script = process.argv[1]
  if (script && (script.endsWith('.ts') || script.endsWith('.js') || script.endsWith('.tsx'))) {
    return { command: process.execPath, args: [script, '_capture', ...extraArgs] }
  }
  return { command: process.execPath, args: ['_capture', ...extraArgs] }
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function spawnWindowsDaemon(command: string, args: string[]): number {
  // `detached: true` on Windows can allocate a visible console for console-subsystem
  // binaries. PowerShell's Start-Process can create the daemon hidden while still
  // returning the real child PID we need for `hpm status` and `hpm stop`.
  const script = `
$ErrorActionPreference = 'Stop'
$process = Start-Process -FilePath ${psQuote(command)} -ArgumentList @(${args.map(psQuote).join(', ')}) -WorkingDirectory ${psQuote(process.cwd())} -WindowStyle Hidden -RedirectStandardOutput ${psQuote(LOG_FILE)} -RedirectStandardError ${psQuote(ERR_LOG_FILE)} -PassThru
[Console]::Out.Write($process.Id)
`
  // -EncodedCommand avoids PowerShell quoting edge cases for paths/flags with spaces.
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true },
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
    throw new Error(`failed to spawn daemon via PowerShell${details ? `: ${details}` : ''}`)
  }

  const pid = Number(result.stdout.trim())
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`invalid daemon pid: ${result.stdout}`)
  writeFileSync(PID_FILE, String(pid))
  return pid
}

export function spawnDaemon(forwardFlags: string[] = []): number {
  ensureHome()
  clearStopRequest()
  rotateLogIfLarge()
  const lock = acquireStartLock()
  if (lock === undefined) {
    const pid = waitForDaemonStarted(5_000)
    if (pid !== undefined) return pid
    throw new Error('daemon start already in progress')
  }

  try {
    // Re-check after taking the lock. This closes the race where multiple tray
    // instances all observe "not running" before any one has written daemon.pid.
    const existing = aliveDaemonPidFromFile()
    if (existing !== undefined) return existing

    const { command, args } = buildRespawnArgs(forwardFlags)
    if (process.platform === 'win32') {
      return spawnWindowsDaemon(command, args)
    }

    // Unix-style daemonization: detach the child, redirect output, then let this
    // parent exit without keeping the event loop alive.
    const out = openSync(LOG_FILE, 'a')
    const proc = spawn(command, args, {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    })
    if (!proc.pid) throw new Error('failed to spawn daemon')
    proc.unref()
    writeFileSync(PID_FILE, String(proc.pid))
    return proc.pid
  } finally {
    releaseStartLock(lock)
  }
}

export function stopDaemon(): { stopped: boolean; pid?: number } {
  const pid = daemonPid()
  if (pid === undefined) return { stopped: false }
  let stopped = false
  try {
    requestDaemonStop()
    signalDaemonPid(pid, 'SIGTERM')
    stopped = waitForPidStopped(pid, 120_000)
    if (!stopped) {
      forceStopDaemonPid(pid)
      stopped = waitForPidStopped(pid, 5_000)
    }
  } catch {
    stopped = false
  }
  try {
    if (stopped && existsSync(PID_FILE)) unlinkSync(PID_FILE)
  } catch {}
  clearStopRequest()
  return { stopped, pid }
}
