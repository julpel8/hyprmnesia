import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HailoOcr, defaultDetModel, defaultRecModel } from './hailo'
import { makeOcr } from './index'

// A stand-in for the real python worker. It speaks the same NDJSON protocol so
// the spawn/stdin/stdout plumbing in HailoOcr is exercised without a NPU.
const FAKE_WORKER = `#!/usr/bin/env python3
import sys, json, base64

if "--version" in sys.argv:
    print("Python 3.13 (fake)")
    sys.exit(0)

print(json.dumps({"type": "ready", "engine": "hailo"}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("type") == "quit":
        break
    if msg.get("type") == "ocr":
        mid = msg.get("id")
        raw = base64.b64decode(msg.get("image", "") or "")
        text = raw.decode("utf-8", "replace")[:8]
        print(json.dumps({"type": "result", "id": mid, "ok": True,
                          "engine": "hailo", "text": "hi " + text}), flush=True)
`

// Same protocol, but the worker announces a startup failure and dies: ready()
// must surface the fatal record instead of hanging until the timeout.
const FATAL_WORKER = `#!/usr/bin/env python3
import json, sys

if "--version" in sys.argv:
    print("Python 3.13 (fatal)")
    sys.exit(0)

print(json.dumps({"type": "fatal", "engine": "hailo", "error": "no /dev/hailo"}), flush=True)
sys.exit(1)
`

const dirs: string[] = []
const cleanup: Array<() => void> = []
let baseDir: string
let fakePython: string
let det: string
let rec: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'hpm-ocrhailo-'))
  dirs.push(baseDir)
  fakePython = join(baseDir, 'fake-python')
  writeFileSync(fakePython, FAKE_WORKER)
  chmodSync(fakePython, 0o755)
  det = join(baseDir, 'ocr_det.hef')
  rec = join(baseDir, 'ocr.hef')
  writeFileSync(det, 'det')
  writeFileSync(rec, 'rec')
})

afterEach(async () => {
  for (const fn of cleanup.splice(0)) fn()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeEngine(python: string = fakePython): HailoOcr {
  const engine = new HailoOcr({
    python,
    helper: fakePython,
    det_model: det,
    rec_model: rec,
  })
  cleanup.push(() => engine.close())
  return engine
}

test('hailo engine is selected by the makeOcr switch', () => {
  expect(makeOcr({ engine: 'hailo', options: {} }).name).toBe('hailo')
  expect(makeOcr({ engine: 'noop', options: {} }).name).toBe('noop')
  expect(makeOcr({ engine: 'auto', options: {} }).name).toBe('tesseract')
})

test('default model paths resolve under ~/.hyprmnesia', () => {
  expect(defaultDetModel()).toContain('ocr-models')
  expect(defaultRecModel()).toContain('ocr-models')
  expect(defaultRecModel()).not.toBe(defaultDetModel())
})

test('ready() is false when a model file is missing', async () => {
  const missing = new HailoOcr({
    python: fakePython,
    helper: fakePython,
    det_model: join(baseDir, 'nope.hef'),
    rec_model: rec,
  })
  cleanup.push(() => missing.close())
  expect(await missing.ready()).toBe(false)
  expect(await makeEngine().ready()).toBe(true)
})

test('process() sends the image and resolves with the worker text', async () => {
  const engine = makeEngine()
  await engine.ready()
  const text = await engine.process(Buffer.from('abcdefghij'))
  expect(text).toBe('hi abcdefgh')
})

test('concurrent process() calls keep their own responses', async () => {
  const engine = makeEngine()
  await engine.ready()
  const [a, b] = await Promise.all([
    engine.process(Buffer.from('11111111')),
    engine.process(Buffer.from('22222222')),
  ])
  expect(a).toBe('hi 11111111')
  expect(b).toBe('hi 22222222')
})

test('a fatal message from the worker makes ready() fail', async () => {
  const fatalDir = mkdtempSync(join(tmpdir(), 'hpm-ocrhailo-fatal-'))
  dirs.push(fatalDir)
  const fatalPython = join(fatalDir, 'fatal-python')
  writeFileSync(fatalPython, FATAL_WORKER)
  chmodSync(fatalPython, 0o755)
  expect(await makeEngine(fatalPython).ready()).toBe(false)
})
