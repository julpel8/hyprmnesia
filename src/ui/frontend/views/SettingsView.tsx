import { useCallback, useEffect, useState } from 'react'
import { getJson, putJson } from '../api'
import type { SettingFieldDescriptor } from '../types'

type Config = Record<string, unknown>

function getByPath(obj: Config, path: string[]): unknown {
  let cur: unknown = obj
  for (const part of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function setByPath(obj: Config, path: string[], value: unknown): Config {
  const next = structuredClone(obj)
  let cur = next as Record<string, unknown>
  for (const part of path.slice(0, -1)) {
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {}
    cur = cur[part] as Record<string, unknown>
  }
  cur[path[path.length - 1] as string] = value
  return next
}

interface ConfigPayload {
  config: Config
  fields: SettingFieldDescriptor[]
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: SettingFieldDescriptor
  value: unknown
  onChange: (value: unknown) => void
}) {
  let input: React.ReactNode
  if (field.kind === 'bool') {
    input = (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  } else if (field.kind === 'enum') {
    input = (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {(field.choices ?? []).map((choice) => (
          <option key={String(choice)} value={String(choice)}>
            {String(choice)}
          </option>
        ))}
      </select>
    )
  } else if (field.kind === 'number') {
    input = (
      <input
        type="number"
        value={value === undefined || value === null ? '' : Number(value)}
        step={field.step}
        min={field.min}
        max={field.max}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    )
  } else {
    input = (
      <input
        type="text"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <div className="setting-row">
      <label className="setting-label">{field.label}</label>
      <div className="setting-input">{input}</div>
      <span className="setting-hint">{field.hint}</span>
    </div>
  )
}

export function SettingsView() {
  const [config, setConfig] = useState<Config | null>(null)
  const [fields, setFields] = useState<SettingFieldDescriptor[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const payload = await getJson<ConfigPayload>('/api/config')
      setConfig(payload.config)
      setFields(payload.fields)
      setStatus('')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(
    async (restart: boolean) => {
      if (!config) return
      setBusy(true)
      setStatus(restart ? 'Saving and restarting daemon…' : 'Saving…')
      try {
        const payload = await putJson<ConfigPayload>('/api/config', { config, restart })
        setConfig(payload.config)
        setFields(payload.fields)
        setStatus(restart ? 'Saved and restarted' : 'Saved')
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [config],
  )

  if (!config) {
    return <div className="settings">{status || 'Loading settings…'}</div>
  }

  return (
    <div className="settings">
      <div className="settings-list">
        {fields.map((field) => (
          <FieldRow
            key={field.path.join('.')}
            field={field}
            value={getByPath(config, field.path)}
            onChange={(value) =>
              setConfig((prev) => (prev ? setByPath(prev, field.path, value) : prev))
            }
          />
        ))}
      </div>
      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => save(false)}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={() => save(true)}>
          Apply & restart daemon
        </button>
        <span className="settings-status">{status}</span>
      </div>
    </div>
  )
}
