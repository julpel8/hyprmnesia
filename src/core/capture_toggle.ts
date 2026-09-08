// On/off switches for the two audio capture sources, shared by the CLI, the
// tray, and the dashboard. The daemon reads capture config once at startup, so
// flipping a switch is a config write plus a daemon restart. Restarting is left
// to the caller: the CLI stops the daemon in-process, while the UI server must
// go through the orchestrator (see ui/api/daemon.ts).

import { loadConfigForEditing, saveConfig } from '../config'

export type AudioSource = 'mic' | 'system'

export type AudioCaptureState = Record<AudioSource, boolean>

export function isAudioSource(value: string): value is AudioSource {
  return value === 'mic' || value === 'system'
}

export function audioCaptureState(configPath?: string): AudioCaptureState {
  const cfg = loadConfigForEditing(configPath)
  return { mic: cfg.capture.audio.mic.enabled, system: cfg.capture.audio.system.enabled }
}

// Writes the flag and returns the resulting state. `enabled: undefined` flips
// whatever is currently persisted.
export function setAudioCapture(
  source: AudioSource,
  enabled: boolean | undefined,
  configPath?: string,
): AudioCaptureState {
  const cfg = loadConfigForEditing(configPath)
  const next = enabled ?? !cfg.capture.audio[source].enabled
  cfg.capture.audio[source].enabled = next
  saveConfig(cfg, configPath)
  return { mic: cfg.capture.audio.mic.enabled, system: cfg.capture.audio.system.enabled }
}
