import { snapshotWindow, windowChanged } from '../capture/window'
import type { EventBus, WindowContext } from './events'

export interface WindowTracker {
  current(): WindowContext | undefined
  stop(): void
}

export function startWindowTracker(events: EventBus, pollMs = 1000): WindowTracker {
  let running = true
  let current: WindowContext | undefined
  let lastError: string | undefined

  async function loop() {
    while (running) {
      try {
        const next = await snapshotWindow()
        if (lastError) {
          events.publish({
            type: 'log',
            at: Date.now(),
            level: 'info',
            message: 'window focus tracking recovered',
          })
          lastError = undefined
        }
        if (windowChanged(current, next) && next) {
          events.publish({
            type: 'window_changed',
            at: Date.now(),
            window: next,
            previous: current,
          })
        }
        current = next
      } catch (err) {
        const message = String(err)
        if (message !== lastError) {
          events.publish({
            type: 'log',
            at: Date.now(),
            level: 'warn',
            message: 'window focus tracking unavailable',
            extra: message,
          })
          lastError = message
        }
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  loop()
  return {
    current: () => current,
    stop: () => {
      running = false
    },
  }
}
