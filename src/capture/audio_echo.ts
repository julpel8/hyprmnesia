// Echo suppression and ASR-frame gating for the audio capture pipeline. When
// system audio is loud, mic frames that look like a quieter echo of it are
// dropped before reaching the transcriber, so the assistant's own voice (or
// speaker bleed) doesn't get transcribed as the user.
import type { AudioCaptureConfig } from '../config'
import type { AudioSource } from '../core/events'
import { pcm16Levels } from './wav'

export interface EchoSuppressionRuntime {
  enabled: boolean
  systemThresholdDb: number
  micMarginDb: number
  holdMs: number
  activeUntil: number
  lastSystemPeakDb: number
}

export function finiteLevel(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined
}

export function peakOrFloor(value: number): number {
  return Number.isFinite(value) ? value : -Infinity
}

export function makeEchoSuppression(cfg: AudioCaptureConfig): EchoSuppressionRuntime {
  return {
    enabled: cfg.echo_suppression?.enabled ?? true,
    systemThresholdDb: cfg.echo_suppression?.system_threshold_db ?? -45,
    micMarginDb: cfg.echo_suppression?.mic_margin_db ?? 6,
    holdMs: cfg.echo_suppression?.hold_ms ?? 500,
    activeUntil: 0,
    lastSystemPeakDb: -Infinity,
  }
}

export function shouldSubmitAsrFrame(
  source: AudioSource,
  at: number,
  frame: Buffer,
  echo: EchoSuppressionRuntime,
): boolean {
  if (!echo.enabled) return true
  const levels = pcm16Levels(frame)
  const peak = Number.isFinite(levels.peak_db) ? levels.peak_db : -Infinity

  if (source === 'system') {
    if (peak >= echo.systemThresholdDb) {
      echo.activeUntil = Math.max(echo.activeUntil, at + echo.holdMs)
      echo.lastSystemPeakDb = peak
    }
    return true
  }

  if (at > echo.activeUntil) return true
  return peak >= echo.lastSystemPeakDb + echo.micMarginDb
}

export function chunkKind(source: AudioSource): 'audio_mic' | 'audio_system' {
  return source === 'mic' ? 'audio_mic' : 'audio_system'
}
