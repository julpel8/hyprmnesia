type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const current: Level = (process.env.HPM_LOG as Level) ?? 'info'

function ts() {
  return new Date().toISOString()
}

function emit(level: Level, msg: string, extra?: unknown) {
  if (ORDER[level] < ORDER[current]) return

  if (!process.stdout.isTTY) {
    // Daemon mode: stdout is redirected to daemon.log by spawnDaemon, so we
    // emit NDJSON instead of formatted text. Log readers tail this same file
    // and parse each line; mixed formats would break that parser. We also drop
    // the stdout/stderr split — warn/error stay on stdout so they land in one
    // file readers can observe (the err.log is post-mortem only).
    const event = { type: 'log', at: Date.now(), level, message: msg, extra }
    process.stdout.write(JSON.stringify(event) + '\n')
    return
  }

  const tail = extra === undefined ? '' : ' ' + JSON.stringify(extra)
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
}
