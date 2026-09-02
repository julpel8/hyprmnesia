import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME_DIR = join(homedir(), '.hyprmnesia')
const TRAY_LOCK_FILE = join(HOME_DIR, 'tray.lock')
const TRAY_STOP_FILE = join(HOME_DIR, 'tray.stop')

function ensureHome() {
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true })
}

function removeIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {}
}

function trayPid(): number | undefined {
  if (!existsSync(TRAY_LOCK_FILE)) return undefined
  try {
    const raw = readFileSync(TRAY_LOCK_FILE, 'utf8').trim().split(/\r?\n/)[0]
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

export function isTrayAlive(): boolean {
  ensureHome()
  const pid = trayPid()
  if (pid === undefined) return false
  if (isPidAlive(pid)) return true
  removeIfExists(TRAY_LOCK_FILE)
  removeIfExists(TRAY_STOP_FILE)
  return false
}

export function requestTrayQuit(): { requested: boolean; pid?: number } {
  ensureHome()
  const pid = trayPid()
  if (pid === undefined || !isPidAlive(pid)) {
    removeIfExists(TRAY_LOCK_FILE)
    removeIfExists(TRAY_STOP_FILE)
    return { requested: false, pid }
  }
  writeFileSync(TRAY_STOP_FILE, String(Date.now()))
  return { requested: true, pid }
}
