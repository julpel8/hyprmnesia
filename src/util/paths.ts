import { homedir } from 'node:os'
import { join } from 'node:path'

export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1))
  }
  return p
}

export const defaultConfigPath = () => join(homedir(), '.hyprmnesia', 'config.yaml')
export const legacyConfigPath = () => join(homedir(), '.hyprmnesia', 'config.json')
const _enginesDir = () => join(homedir(), '.hyprmnesia', 'engines')
// The live index DB stays local and out of Syncthing: SQLite in WAL mode must
// never be replicated file-by-file. What ships to the other machines is the
// snapshot written under hostDir().
export const defaultDbPath = () => join(homedir(), '.hyprmnesia', 'index.db')

// A machine only ever writes inside its own host directory, and reads the ones
// belonging to the other machines.
export function hostDir(cfg: StoragePaths): string {
  return join(expandHome(cfg.storage.path), cfg.storage.host_id)
}

// Where this machine publishes its index snapshot for the others to read.
export function hostSnapshotPath(cfg: StoragePaths): string {
  return join(hostDir(cfg), 'index.db')
}

export interface StoragePaths {
  storage: { path: string; host_id: string }
}
export const defaultWaylandTokenPath = () => join(homedir(), '.hyprmnesia', 'wayland-portal-token')
export const updateCheckPath = () => join(homedir(), '.hyprmnesia', 'update-check.json')
