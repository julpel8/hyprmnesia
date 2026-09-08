import { expect, test } from 'bun:test'
import { LineBuffer, NativeWorker } from './native_worker'

test('LineBuffer: emits complete lines and retains the trailing partial', () => {
  const buf = new LineBuffer()
  expect(buf.push('hello')).toEqual([])
  expect(buf.push(' world\nsecond')).toEqual(['hello world'])
  expect(buf.push('\nthird\n')).toEqual(['second', 'third'])
  expect(buf.push('')).toEqual([])
})

test('LineBuffer: preserves blank lines for caller-side filtering', () => {
  const buf = new LineBuffer()
  expect(buf.push('a\n\nb\n')).toEqual(['a', '', 'b'])
})

test('NativeWorker: line-buffers stdout and reports exit code', async () => {
  const lines: string[] = []
  let closeCode: number | null = -1
  await new Promise<void>((resolve) => {
    const worker = new NativeWorker('sh', {
      onLine: (line) => {
        if (line.trim()) lines.push(line)
      },
      onError: () => resolve(),
      onClose: (code) => {
        closeCode = code
        resolve()
      },
    })
    worker.spawn(['-c', 'printf \'{"n":1}\\n{"n":2}\\n\''])
  })
  expect(lines).toEqual(['{"n":1}', '{"n":2}'])
  expect(closeCode).toBe(0)
})

test('NativeWorker: send writes NDJSON and stop shuts down gracefully', async () => {
  const echoed: string[] = []
  const worker = new NativeWorker('sh', {
    onLine: (line) => {
      if (line.trim()) echoed.push(line)
    },
    onError: () => {},
    onClose: () => {},
  })
  // Echo each line back; exit cleanly when a shutdown request arrives.
  worker.spawn([
    '-c',
    'while IFS= read -r line; do case "$line" in *shutdown*) exit 0;; *) printf "%s\\n" "$line";; esac; done',
  ])
  worker.send({ ping: 1 })
  // Give the echo a moment to round-trip before requesting shutdown.
  await Bun.sleep(50)
  expect(echoed).toEqual(['{"ping":1}'])
  expect(worker.running).toBe(true)
  await worker.stop({ type: 'shutdown' }, 1_000)
  expect(worker.running).toBe(false)
})
