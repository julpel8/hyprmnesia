import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IndexDb } from './index_db'
import { loadVecExtension, serializeVector } from './vec'

const dirs: string[] = []

function closeDb(db: Database): void {
  db.close()
}

function asIndexDb(db: Database): IndexDb {
  return db as unknown as IndexDb
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-vec-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('serializeVector writes little-endian float32 values byte-for-byte', () => {
  const values = [
    0,
    -0,
    1.25,
    -2.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.401298464324817e-45,
  ]
  const vector = new Float32Array(values)
  const encoded = serializeVector(vector)

  expect(encoded.length).toBe(vector.length * 4)
  for (let i = 0; i < vector.length; i++) {
    const actual = encoded.readFloatLE(i * 4)
    const expected = vector[i]!
    if (Number.isNaN(expected)) expect(Number.isNaN(actual)).toBe(true)
    else expect(Object.is(actual, expected) || actual === expected).toBe(true)
  }
})

test('serializeVector returns a non-aliased copy', () => {
  const vector = new Float32Array([1, 2])
  const encoded = serializeVector(vector)

  vector[0] = 9
  encoded.writeFloatLE(7, 4)

  expect(encoded.readFloatLE(0)).toBe(1)
  expect(vector[1]).toBe(2)
})

test('loadVecExtension returns a boolean for a fresh in-memory database', () => {
  const db = new Database(':memory:')
  try {
    expect(typeof loadVecExtension(asIndexDb(db))).toBe('boolean')
  } finally {
    closeDb(db)
  }
})

test('loadVecExtension returns false when no candidate library exists and leaves DB usable', () => {
  const db = new Database(':memory:')
  try {
    expect(loadVecExtension(asIndexDb(db), { candidates: [] })).toBe(false)
    expect(db.query<{ value: number }, []>('SELECT 42 AS value').get()?.value).toBe(42)
  } finally {
    closeDb(db)
  }
})

test('loadVecExtension catches load errors and leaves DB usable', () => {
  const dir = freshDir()
  const fakeExtension = join(dir, process.platform === 'win32' ? 'vec0.dll' : 'vec0.so')
  writeFileSync(fakeExtension, 'not a sqlite extension')
  const db = new Database(':memory:')
  try {
    expect(loadVecExtension(asIndexDb(db), { candidates: [fakeExtension] })).toBe(false)
    expect(db.query<{ value: number }, []>('SELECT 7 AS value').get()?.value).toBe(7)
  } finally {
    closeDb(db)
  }
})
