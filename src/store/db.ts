// SQLite + FTS5 index for every captured chunk (screenshots, mic audio,
// system audio). One row per chunk, with an external-content FTS5 mirror over
// `text` + the window context columns. Triggers keep the two in sync.
//
// The DB lives at ~/.hyprmnesia/index.db. Blobs continue to live under
// storage.path; this index just holds metadata + searchable text.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WindowContext } from '../core/events'
import { type IndexDb, openIndexDb } from './index_db'
import { loadVecExtension, serializeVector } from './vec'

type ChunkKind = 'screenshot' | 'audio_mic' | 'audio_system'

export const CURRENT_INDEX_SCHEMA_VERSION = 3

// 'HPM2' — stamped on every database created since chunks.blob switched from an
// absolute path to one relative to the owning machine's host directory. The
// change is invisible to the schema version, so older databases are refused by
// this marker instead. There is no migration: the layout starts fresh.
const INDEX_APPLICATION_ID = 0x48504d32

export type EmbeddingKind = 'segment' | 'chunk'

interface EmbeddingRow {
  kind: EmbeddingKind
  id: string
  vector: Float32Array
  model: string
  dim: number
}

export interface PendingEmbedding {
  id: string
  text: string
}

interface ChunkRow {
  id: string
  kind: ChunkKind
  at: number
  start_at?: number
  end_at?: number
  blob: string
  bytes: number
  text: string
  capture_ms: number
  window?: WindowContext
  ocr?: { engine: string }
  audio?: {
    engine: string
    device: string
    sample_rate: number
    chunk_ms: number
    rms_db?: number
    peak_db?: number
  }
}

interface TranscriptSegmentRow {
  id: string
  chunk_id: string
  source: 'mic' | 'system'
  start_at: number
  end_at: number
  text: string
  engine: string
  transcribe_ms: number
  // 'compare' rows come from the optional second ASR engine. They are stored so
  // Live and Replay can show both transcripts, but they stay out of the chunk
  // text, the FTS index and the embedding queue: only the primary engine's
  // words are what the recording says. Omitted means primary, matching the
  // column default.
  role?: 'primary' | 'compare'
}

export interface ChunkStore {
  insert(row: ChunkRow): void
  finalizeAudioChunk(
    id: string,
    fields: {
      blob?: string
      bytes: number
      capture_ms: number
      end_at: number
      rms_db?: number
      peak_db?: number
    },
  ): void
  insertTranscriptSegment(row: TranscriptSegmentRow): void
  // Updates text and (optionally) audio_engine in a single UPDATE so the FTS
  // trigger only re-indexes once. Called once per audio chunk today; designed
  // to also tolerate repeated calls per id for future live transcription.
  updateText(id: string, text: string, audioEngine?: string): void
  // Screenshots stored before their text was read, oldest first. Capture writes
  // the blob and returns; OCR happens later, off the capture path, so a slow
  // engine cannot stall the frame source. Survives a restart: the rows are the
  // queue.
  pendingOcr(limit: number): PendingOcr[]
  // Text plus the engine that produced it, in one UPDATE so the FTS trigger
  // re-indexes once. Setting the engine is what takes the row out of
  // `pendingOcr`, so it is written even when the text came back empty.
  finalizeOcr(id: string, text: string, engine: string): void
  // True when the sqlite-vec extension loaded and the vector tables exist.
  readonly vecEnabled: boolean
  insertEmbedding(row: EmbeddingRow): void
  pendingEmbeddings(kind: EmbeddingKind, model: string, limit: number): PendingEmbedding[]
  close(): void
}

export interface PendingOcr {
  id: string
  blob: string
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS chunks (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  at                INTEGER NOT NULL,
  blob              TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  text              TEXT NOT NULL DEFAULT '',
  capture_ms        INTEGER NOT NULL,
  window_app        TEXT,
  window_title      TEXT,
  window_url        TEXT,
  window_pid        INTEGER,
  ocr_engine        TEXT,
  audio_engine      TEXT,
  audio_device      TEXT,
  audio_sample_rate INTEGER,
  audio_chunk_ms    INTEGER,
  audio_rms_db      REAL,
  audio_peak_db     REAL
);

CREATE INDEX IF NOT EXISTS chunks_at_idx      ON chunks(at);
CREATE INDEX IF NOT EXISTS chunks_kind_at_idx ON chunks(kind, at);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, window_app, window_title, window_url,
  content='chunks', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, window_app, window_title, window_url)
  VALUES (new.rowid, new.text, new.window_app, new.window_title, new.window_url);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, window_app, window_title, window_url)
  VALUES('delete', old.rowid, old.text, old.window_app, old.window_title, old.window_url);
END;

-- WHEN clause skips re-indexing when only non-FTS columns change (e.g.
-- audio_engine via appendChunkTextStmt setting it on each transcript flush).
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks
WHEN old.text IS NOT new.text
  OR old.window_app IS NOT new.window_app
  OR old.window_title IS NOT new.window_title
  OR old.window_url IS NOT new.window_url
BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, window_app, window_title, window_url)
  VALUES('delete', old.rowid, old.text, old.window_app, old.window_title, old.window_url);
  INSERT INTO chunks_fts(rowid, text, window_app, window_title, window_url)
  VALUES (new.rowid, new.text, new.window_app, new.window_title, new.window_url);
END;
`

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS transcript_segments (
  id            TEXT PRIMARY KEY,
  chunk_id      TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  text          TEXT NOT NULL,
  engine        TEXT NOT NULL,
  transcribe_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS transcript_segments_chunk_idx ON transcript_segments(chunk_id);
CREATE INDEX IF NOT EXISTS transcript_segments_time_idx  ON transcript_segments(start_at, end_at);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segments_fts USING fts5(
  text,
  content='transcript_segments', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS transcript_segments_ai AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS transcript_segments_ad AFTER DELETE ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(transcript_segments_fts, rowid, text)
  VALUES('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS transcript_segments_au AFTER UPDATE ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(transcript_segments_fts, rowid, text)
  VALUES('delete', old.rowid, old.text);
  INSERT INTO transcript_segments_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;
`

// Vector tables live behind sqlite-vec. The 384-dim layout matches the v1
// embedding model (multilingual-e5-small). embedding_meta records which rows are
// already embedded with which model so backfill can skip them.
const SCHEMA_V3 = `
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segment_vec USING vec0(
  segment_id TEXT PRIMARY KEY,
  embedding  float[384]
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding float[384]
);

CREATE TABLE IF NOT EXISTS embedding_meta (
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  embedded_at INTEGER NOT NULL,
  PRIMARY KEY (id, kind)
);
`

function columnExists(db: IndexDb, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
  return rows.some((row) => row.name === column)
}

interface IndexMigration {
  version: number
  requiresVec?: boolean
  run(db: IndexDb): void
}

const INDEX_MIGRATIONS: IndexMigration[] = [
  {
    version: 1,
    run(db) {
      db.run(SCHEMA_V1)
    },
  },
  {
    version: 2,
    run(db) {
      if (!columnExists(db, 'chunks', 'start_at'))
        db.run('ALTER TABLE chunks ADD COLUMN start_at INTEGER')
      if (!columnExists(db, 'chunks', 'end_at'))
        db.run('ALTER TABLE chunks ADD COLUMN end_at INTEGER')
      db.run(SCHEMA_V2)
    },
  },
  {
    version: 3,
    requiresVec: true,
    run(db) {
      db.run(SCHEMA_V3)
    },
  },
]

// Returns true once the schema is at v3 and the sqlite-vec extension is loaded.
// The v3 step is gated on sqlite-vec: without it we stay at v2 and embeddings
// are disabled, but capture/FTS5 keep working. A later run with the extension
// available upgrades in place.
function migrate(db: IndexDb, vecLoaded: boolean): boolean {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  let version = row?.user_version ?? 0
  if (version > CURRENT_INDEX_SCHEMA_VERSION) {
    throw new Error(
      `index database schema v${version} is newer than supported schema v${CURRENT_INDEX_SCHEMA_VERSION}`,
    )
  }
  if (version === 0) db.run(`PRAGMA application_id = ${INDEX_APPLICATION_ID}`)
  else assertRelativeBlobs(db)

  for (const migration of INDEX_MIGRATIONS) {
    if (version >= migration.version) continue
    if (migration.requiresVec && !vecLoaded) continue
    db.transaction(() => {
      migration.run(db)
      db.run(`PRAGMA user_version = ${migration.version}`)
    })()
    version = migration.version
  }

  ensureChunksAuTrigger(db)
  ensureSegmentRole(db)
  return vecLoaded && version >= CURRENT_INDEX_SCHEMA_VERSION
}

// transcript_segments.role tells the primary engine's words from the optional
// compare engine's. It is added outside the numbered migrations on purpose: the
// v3 step is gated on sqlite-vec, so a database on a build without the
// extension sits at v2 forever and would never reach a v4. Both the column and
// the FTS triggers that skip compare rows are cheap and idempotent to ensure on
// every open.
function ensureSegmentRole(db: IndexDb): void {
  if (!columnExists(db, 'transcript_segments', 'role')) {
    db.run("ALTER TABLE transcript_segments ADD COLUMN role TEXT NOT NULL DEFAULT 'primary'")
  }
  db.transaction(() => {
    db.run('DROP TRIGGER IF EXISTS transcript_segments_ai')
    db.run('DROP TRIGGER IF EXISTS transcript_segments_ad')
    db.run('DROP TRIGGER IF EXISTS transcript_segments_au')
    // Every guard reads the same immutable `role`, so a row is either indexed
    // and later deleted from the index, or never indexed at all. A compare row
    // that reached the FTS index without a matching delete would corrupt it.
    db.run(`CREATE TRIGGER transcript_segments_ai AFTER INSERT ON transcript_segments
      WHEN new.role = 'primary'
      BEGIN
        INSERT INTO transcript_segments_fts(rowid, text) VALUES (new.rowid, new.text);
      END`)
    db.run(`CREATE TRIGGER transcript_segments_ad AFTER DELETE ON transcript_segments
      WHEN old.role = 'primary'
      BEGIN
        INSERT INTO transcript_segments_fts(transcript_segments_fts, rowid, text)
        VALUES('delete', old.rowid, old.text);
      END`)
    db.run(`CREATE TRIGGER transcript_segments_au AFTER UPDATE ON transcript_segments
      WHEN old.role = 'primary' AND new.role = 'primary' AND old.text IS NOT new.text
      BEGIN
        INSERT INTO transcript_segments_fts(transcript_segments_fts, rowid, text)
        VALUES('delete', old.rowid, old.text);
        INSERT INTO transcript_segments_fts(rowid, text) VALUES (new.rowid, new.text);
      END`)
  })()
}

// Databases written before the multi-machine layout hold absolute blob paths
// that mean nothing on another machine, and nothing can recover them.
function assertRelativeBlobs(db: IndexDb): void {
  const appId =
    db.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id ?? 0
  if (appId === INDEX_APPLICATION_ID) return
  throw new Error(
    'index database predates the multi-machine storage layout and stores absolute blob paths. ' +
      'There is no migration: stop the daemon, delete ~/.hyprmnesia/index.db* and ~/.hyprmnesia/data, then start again.',
  )
}

// Pre-WHEN-clause DBs created chunks_au without a guard, so audio_engine-only
// UPDATEs forced a full FTS re-index. CREATE TRIGGER IF NOT EXISTS in SCHEMA_V1
// won't replace the existing trigger; DROP + CREATE on every open is cheap and
// idempotent.
function ensureChunksAuTrigger(db: IndexDb): void {
  db.transaction(() => {
    db.run('DROP TRIGGER IF EXISTS chunks_au')
    db.run(`CREATE TRIGGER chunks_au AFTER UPDATE ON chunks
      WHEN old.text IS NOT new.text
        OR old.window_app IS NOT new.window_app
        OR old.window_title IS NOT new.window_title
        OR old.window_url IS NOT new.window_url
      BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, window_app, window_title, window_url)
        VALUES('delete', old.rowid, old.text, old.window_app, old.window_title, old.window_url);
        INSERT INTO chunks_fts(rowid, text, window_app, window_title, window_url)
        VALUES (new.rowid, new.text, new.window_app, new.window_title, new.window_url);
      END`)
  })()
}

export function openChunkStore(dbPath: string): ChunkStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = openIndexDb(dbPath, { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA foreign_keys = ON')
  let vecEnabled: boolean
  try {
    const vecLoaded = loadVecExtension(db)
    vecEnabled = migrate(db, vecLoaded)
  } catch (err) {
    db.close()
    throw err
  }

  const insertStmt = db.prepare(`
    INSERT INTO chunks (
      id, kind, at, blob, bytes, text, capture_ms,
      start_at, end_at,
      window_app, window_title, window_url, window_pid,
      ocr_engine,
      audio_engine, audio_device, audio_sample_rate, audio_chunk_ms,
      audio_rms_db, audio_peak_db
    ) VALUES (
      $id, $kind, $at, $blob, $bytes, $text, $capture_ms,
      $start_at, $end_at,
      $window_app, $window_title, $window_url, $window_pid,
      $ocr_engine,
      $audio_engine, $audio_device, $audio_sample_rate, $audio_chunk_ms,
      $audio_rms_db, $audio_peak_db
    )
  `)

  const updateTextStmt = db.prepare(`
    UPDATE chunks SET text = $text WHERE id = $id
  `)
  const pendingOcrStmt = db.prepare<PendingOcr, { $limit: number }>(`
    SELECT id, blob FROM chunks
    WHERE kind = 'screenshot' AND ocr_engine IS NULL
    ORDER BY at ASC
    LIMIT $limit
  `)
  const finalizeOcrStmt = db.prepare(`
    UPDATE chunks SET text = $text, ocr_engine = $engine WHERE id = $id
  `)
  const updateTextAndEngineStmt = db.prepare(`
    UPDATE chunks SET text = $text, audio_engine = $audio_engine WHERE id = $id
  `)
  const finalizeAudioChunkStmt = db.prepare(`
    UPDATE chunks
    SET blob = COALESCE($blob, blob),
        bytes = $bytes,
        capture_ms = $capture_ms,
        end_at = $end_at,
        audio_rms_db = $audio_rms_db,
        audio_peak_db = $audio_peak_db
    WHERE id = $id
  `)
  const insertSegmentStmt = db.prepare(`
    INSERT INTO transcript_segments (
      id, chunk_id, source, start_at, end_at, text, engine, transcribe_ms, role
    ) VALUES (
      $id, $chunk_id, $source, $start_at, $end_at, $text, $engine, $transcribe_ms, $role
    )
  `)
  const appendChunkTextStmt = db.prepare(`
    UPDATE chunks
    SET text = CASE
          WHEN text IS NULL OR text = '' THEN $text
          ELSE text || ' ' || $text
        END,
        audio_engine = $engine
    WHERE id = $chunk_id
  `)

  const vecStmts = vecEnabled
    ? {
        deleteSegmentVec: db.prepare('DELETE FROM transcript_segment_vec WHERE segment_id = $id'),
        insertSegmentVec: db.prepare(
          'INSERT INTO transcript_segment_vec (segment_id, embedding) VALUES ($id, $embedding)',
        ),
        deleteChunkVec: db.prepare('DELETE FROM chunk_vec WHERE chunk_id = $id'),
        insertChunkVec: db.prepare(
          'INSERT INTO chunk_vec (chunk_id, embedding) VALUES ($id, $embedding)',
        ),
        upsertMeta: db.prepare(`
          INSERT INTO embedding_meta (id, kind, model, dim, embedded_at)
          VALUES ($id, $kind, $model, $dim, $embedded_at)
          ON CONFLICT(id, kind) DO UPDATE SET
            model = excluded.model, dim = excluded.dim, embedded_at = excluded.embedded_at
        `),
        pendingSegments: db.prepare<PendingEmbedding, { $model: string; $limit: number }>(`
          SELECT s.id AS id, s.text AS text
          FROM transcript_segments s
          LEFT JOIN embedding_meta m ON m.id = s.id AND m.kind = 'segment' AND m.model = $model
          WHERE m.id IS NULL AND s.role = 'primary' AND COALESCE(s.text, '') <> ''
          LIMIT $limit
        `),
        pendingChunks: db.prepare<PendingEmbedding, { $model: string; $limit: number }>(`
          SELECT c.id AS id, c.text AS text
          FROM chunks c
          LEFT JOIN embedding_meta m ON m.id = c.id AND m.kind = 'chunk' AND m.model = $model
          WHERE m.id IS NULL AND c.kind = 'screenshot' AND COALESCE(c.text, '') <> ''
          LIMIT $limit
        `),
      }
    : undefined

  return {
    vecEnabled,
    insert(row) {
      insertStmt.run({
        $id: row.id,
        $kind: row.kind,
        $at: row.at,
        $blob: row.blob,
        $bytes: row.bytes,
        $text: row.text,
        $capture_ms: row.capture_ms,
        $start_at: row.start_at ?? null,
        $end_at: row.end_at ?? null,
        $window_app: row.window?.app ?? null,
        $window_title: row.window?.title ?? null,
        $window_url: row.window?.url ?? null,
        $window_pid: row.window?.pid ?? null,
        $ocr_engine: row.ocr?.engine ?? null,
        $audio_engine: row.audio?.engine ?? null,
        $audio_device: row.audio?.device ?? null,
        $audio_sample_rate: row.audio?.sample_rate ?? null,
        $audio_chunk_ms: row.audio?.chunk_ms ?? null,
        $audio_rms_db: row.audio?.rms_db ?? null,
        $audio_peak_db: row.audio?.peak_db ?? null,
      })
    },
    finalizeAudioChunk(id, fields) {
      finalizeAudioChunkStmt.run({
        $id: id,
        $blob: fields.blob ?? null,
        $bytes: fields.bytes,
        $capture_ms: fields.capture_ms,
        $end_at: fields.end_at,
        $audio_rms_db: fields.rms_db ?? null,
        $audio_peak_db: fields.peak_db ?? null,
      })
    },
    insertTranscriptSegment(row) {
      db.transaction(() => {
        insertSegmentStmt.run({
          $id: row.id,
          $chunk_id: row.chunk_id,
          $source: row.source,
          $start_at: row.start_at,
          $end_at: row.end_at,
          $text: row.text,
          $engine: row.engine,
          $transcribe_ms: row.transcribe_ms,
          $role: row.role ?? 'primary',
        })
        // Only the primary transcript becomes the chunk's text. Appending the
        // compare engine's take too would store every sentence twice and hand
        // search and embeddings a doubled transcript.
        if ((row.role ?? 'primary') === 'primary') {
          appendChunkTextStmt.run({
            $chunk_id: row.chunk_id,
            $text: row.text,
            $engine: row.engine,
          })
        }
      })()
    },
    updateText(id, text, audioEngine) {
      if (audioEngine !== undefined) {
        updateTextAndEngineStmt.run({ $id: id, $text: text, $audio_engine: audioEngine })
      } else {
        updateTextStmt.run({ $id: id, $text: text })
      }
    },
    insertEmbedding(row) {
      if (!vecStmts) return
      const embedding = serializeVector(row.vector)
      db.transaction(() => {
        if (row.kind === 'segment') {
          vecStmts.deleteSegmentVec.run({ $id: row.id })
          vecStmts.insertSegmentVec.run({ $id: row.id, $embedding: embedding })
        } else {
          vecStmts.deleteChunkVec.run({ $id: row.id })
          vecStmts.insertChunkVec.run({ $id: row.id, $embedding: embedding })
        }
        vecStmts.upsertMeta.run({
          $id: row.id,
          $kind: row.kind,
          $model: row.model,
          $dim: row.dim,
          $embedded_at: Date.now(),
        })
      })()
    },
    pendingOcr(limit) {
      return pendingOcrStmt.all({ $limit: limit })
    },
    finalizeOcr(id, text, engine) {
      finalizeOcrStmt.run({ $id: id, $text: text, $engine: engine })
    },
    pendingEmbeddings(kind, model, limit) {
      if (!vecStmts) return []
      const stmt = kind === 'segment' ? vecStmts.pendingSegments : vecStmts.pendingChunks
      return stmt.all({ $model: model, $limit: limit })
    },
    close() {
      insertStmt.finalize()
      updateTextStmt.finalize()
      updateTextAndEngineStmt.finalize()
      finalizeAudioChunkStmt.finalize()
      insertSegmentStmt.finalize()
      appendChunkTextStmt.finalize()
      if (vecStmts) for (const stmt of Object.values(vecStmts)) stmt.finalize()
      db.close()
    },
  }
}
