// Thin wrapper over bun:sqlite for the index DB. The IndexDb interface is the
// slice of the bun:sqlite Database API the store modules (db.ts, read_store,
// replay/store) rely on.

import { Database as BunDatabase } from 'bun:sqlite'

export interface IndexStatement<Row> {
  get(...params: unknown[]): Row | undefined
  all(...params: unknown[]): Row[]
  run(...params: unknown[]): void
  finalize(): void
}

export interface IndexDb {
  run(sql: string): void
  query<Row = Record<string, unknown>, _Params = unknown>(sql: string): IndexStatement<Row>
  prepare<Row = Record<string, unknown>, _Params = unknown>(sql: string): IndexStatement<Row>
  transaction<F extends (...args: never[]) => unknown>(fn: F): F
  loadExtension(path: string): void
  close(): void
}

export interface OpenIndexDbOptions {
  readonly?: boolean
  create?: boolean
}

export function openIndexDb(path: string, opts: OpenIndexDbOptions = {}): IndexDb {
  return new BunDatabase(path, {
    readonly: opts.readonly,
    create: opts.create ?? !opts.readonly,
  }) as unknown as IndexDb
}

// Opens the index DB read-only. The caller still validates the schema version
// afterwards.
export function openReadIndexDb(path: string): IndexDb {
  return openIndexDb(path, { readonly: true })
}
