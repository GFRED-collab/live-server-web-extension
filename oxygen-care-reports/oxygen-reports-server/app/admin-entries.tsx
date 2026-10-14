'use client';
import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { entryDefinitions } from '../lib/entry-definitions';
import { brandPrintWindow } from './print-layout';
import { localDateTime } from '../lib/work-times';
import './entry-layout.css';
type Entry = { id: string; version: string; [key: string]: unknown };
type History = {
  id: string;
  entityId: string;
  operation: string;
  reason: string;
  recordedAt: string;
  snapshot: Record<string, unknown>;
};
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Request failed.');
  return data;
}
export function printHistory(item: History, label: string) {
  const popup = window.open('', '_blank', 'width=1000,height=850');
  if (!popup) return false;
  const doc = popup.document;
  doc.open();
  doc.write(
    '<!doctype html><html><head><title>Preserved original</title></head><body></body></html>'
  );
  doc.close();
  const heading = doc.createElement('h1');
  heading.textContent = label + ' — preserved original';
  doc.body.append(heading);
  const note = doc.createElement('p');
  note.textContent =
    item.operation +
    ' on ' +
    new Date(item.recordedAt).toLocaleString('en-IE') +
    ' · Reason: ' +
    item.reason;
  doc.body.append(note);
  const walk = (value: unknown, name: string) => {
    if (Array.isArray(value)) {
      value.forEach((child, i) => walk(child, name + ' ' + (i + 1)));
      return;
    }
    if (value && typeof value === 'object') {
      const h = doc.createElement('h2');
      h.textContent = name;
      doc.body.append(h);
      for (const [key, child] of Object.entries(value)) walk(child, key.replace(/_/g, ' '));
      return;
    }
    if (typeof value === 'string' && value.startsWith('data:image/png;base64,')) {
      const p = doc.createElement('p');
      p.textContent = name;
      const img = doc.createElement('img');
      img.src = value;
      img.alt = 'Preserved signature';
      img.style.width = '280px';
      doc.body.append(p, img);
      return;
    }
    if (['signature data', 'identity key', 'created by', 'actor id', 'storage key'].includes(name))
      return;
    const p = doc.createElement('p');
    p.textContent = name + ': ' + String(value ?? '—');
    doc.body.append(p);
  };
  walk(item.snapshot, 'Original entry');
  brandPrintWindow(popup);
  return true;
}
export default function AdminEntries({ sidebar }: { sidebar: ReactNode }) {
  const [kind, setKind] = useState('callouts'),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [historyMode, setHistoryMode] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]),
    [history, setHistory] = useState<History[]>([]),
    [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Entry | null>(null),
    [removing, setRemoving] = useState(false),
    [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [statusOptions, setStatusOptions] = useState<string[]>([
    'Not serviced',
    'Serviced',
    'Follow-up required'
  ]);
  useEffect(() => {
    void api<{ options: string[] }>('/api/service-status-options')
      .then(data => {
        if (Array.isArray(data.options)) setStatusOptions(data.options);
      })
      .catch(e => setError(e.message));
  }, []);
  const lock = useRef(false),
    generation = useRef(0),
    def = {
      ...entryDefinitions[kind],
      fields: entryDefinitions[kind].fields.map(field =>
        field.name === 'service_status' ? { ...field, options: statusOptions } : field
      )
    };
  async function load() {
    const seq = ++generation.current;
    setLoading(true);
    try {
      const data = await api<{ entries?: Entry[]; history?: History[]; hasMore: boolean }>(
        '/api/admin/entries?' +
          new URLSearchParams({
            kind,
            search,
            page: String(page),
            history: historyMode ? '1' : '0'
          })
      );
      if (seq === generation.current) {
        setEntries(data.entries || []);
        setHistory(data.history || []);
        setHasMore(data.hasMore);
        setError('');
      }
    } catch (e) {
      if (seq === generation.current) {
        setEntries([]);
        setHistory([]);
        setError(e instanceof Error ? e.message : 'Could not load entries.');
      }
    } finally {
      if (seq === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [kind, search, page, historyMode]); // eslint-disable-line react-hooks/exhaustive-deps
  function open(entry: Entry, remove = false) {
    setSelected(entry);
    setRemoving(remove);
    setReason('');
    setError('');
    setNotice('');
    setValues(
      Object.fromEntries(
        def.fields.map(f => [
          f.name,
          f.type === 'datetime-local'
            ? localDateTime(String(entry[f.name] || ''))
            : f.type === 'date'
              ? String(entry[f.name] || '').slice(0, 10)
              : String(entry[f.name] ?? '')
        ])
      )
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/entries', {
        method: removing ? 'DELETE' : 'PATCH',
        body: JSON.stringify({
          kind,
          id: selected.id,
          version: selected.version,
          reason,
          fields: removing
            ? undefined
            : Object.fromEntries(
                def.fields.map(f => [
                  f.name,
                  f.type === 'datetime-local' && values[f.name]
                    ? new Date(values[f.name]).toISOString()
                    : values[f.name]
                ])
              )
        })
      });
      setSelected(null);
      setNotice(
        removing
          ? 'Entry deleted. Its original is available in Preserved originals.'
          : kind === 'dockets'
            ? 'Correction saved. Open Dockets for fresh customer sign-off.'
            : kind === 'service_visits'
              ? 'Correction saved. The service visit is now a draft and needs fresh signatures.'
              : 'Correction saved. The original is preserved.'
      );
      window.dispatchEvent(new Event('fieldwork-updated'));
      window.dispatchEvent(new Event('admin-entries-updated'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="workspace-shell subpage-shell">
      {sidebar}
      <header className="workspace-header">
        <h1>Manage entries</h1>
        <button onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </header>
      <p className="muted">
        Super User corrections and deletions. Every change requires a reason and preserves the
        original. Linked records must be removed or reassigned before their parent can be deleted.
      </p>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="message success" role="status">
          {notice}
        </p>
      )}
      <section className="filter-card">
        <label>
          Entry type
          <select
            aria-label="Entry type"
            disabled={busy}
            value={kind}
            onChange={e => {
              setKind(e.target.value);
              setPage(0);
              setSelected(null);
              setNotice('');
            }}
          >
            {Object.entries(entryDefinitions).map(([key, d]) => (
              <option key={key} value={key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search entries
          <input
            value={search}
            onChange={e => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Client, device, details…"
          />
        </label>
        <label>
          View
          <select
            aria-label="View"
            value={historyMode ? 'history' : 'current'}
            onChange={e => {
              setHistoryMode(e.target.value === 'history');
              setPage(0);
              setSelected(null);
            }}
          >
            <option value="current">Current entries</option>
            <option value="history">Preserved originals (including deleted)</option>
          </select>
        </label>
      </section>
      {selected && (
        <section className="access-card">
          <h2>
            {removing ? 'Delete entry' : 'Edit entry'} — {def.label}
          </h2>
          <form className="admin-entry-form" onSubmit={save}>
            <fieldset disabled={busy} className="wide">
              {!removing &&
                def.fields.map(f => (
                  <label key={f.name}>
                    {f.label}
                    {f.options ? (
                      <select
                        aria-label={f.label}
                        value={values[f.name]}
                        onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))}
                      >
                        {f.options.map(o => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    ) : f.type === 'textarea' ? (
                      <textarea
                        aria-label={f.label}
                        required={f.required}
                        maxLength={f.max}
                        value={values[f.name]}
                        onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))}
                      />
                    ) : (
                      <input
                        aria-label={f.label}
                        type={f.type || 'text'}
                        min={f.min}
                        step={f.type === 'number' ? 1 : undefined}
                        required={f.required}
                        maxLength={f.max}
                        value={values[f.name]}
                        onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))}
                      />
                    )}
                  </label>
                ))}
              {removing && (
                <p>
                  This deletes the selected entry. A copy remains in Preserved originals. Deleting a
                  stock movement also reverses its stock balance effect.
                </p>
              )}
              {!removing && ['dockets', 'service_visits'].includes(kind) && (
                <p>
                  This correction invalidates existing signatures. The original signed version is
                  preserved, and fresh sign-off is required.
                </p>
              )}
              <label>
                Reason for {removing ? 'deletion' : 'correction'}
                <textarea
                  required
                  maxLength={1000}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                />
              </label>
              <button type="submit">
                {busy ? 'Saving…' : removing ? 'Confirm deletion' : 'Save correction'}
              </button>
              <button type="button" onClick={() => setSelected(null)}>
                Cancel
              </button>
            </fieldset>
          </form>
        </section>
      )}
      <section className="directory admin-entry-list" aria-busy={loading}>
        <h2>
          {def.label} — {historyMode ? 'preserved originals' : 'current entries'}
        </h2>
        {loading ? (
          <p>Loading…</p>
        ) : historyMode ? (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Action</th>
                <th>Reason</th>
                <th>Original</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id}>
                  <td>{new Date(h.recordedAt).toLocaleString('en-IE')}</td>
                  <td>{h.operation}</td>
                  <td>{h.reason}</td>
                  <td>
                    <button
                      onClick={() => {
                        if (!printHistory(h, def.label)) setError('Please allow the print window.');
                      }}
                    >
                      View / Print original
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                {def.fields.slice(0, 4).map(f => (
                  <th key={f.name}>{f.label}</th>
                ))}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id}>
                  {def.fields.slice(0, 4).map(f => (
                    <td key={f.name}>{String(entry[f.name] ?? '—').slice(0, 160)}</td>
                  ))}
                  <td>
                    <button onClick={() => open(entry)} disabled={busy}>
                      Edit
                    </button>
                    <button onClick={() => open(entry, true)} disabled={busy}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && !(historyMode ? history : entries).length && <p>No matching entries.</p>}
        <div className="export-actions">
          <button disabled={page === 0 || loading || busy} onClick={() => setPage(p => p - 1)}>
            Previous
          </button>
          <span>Page {page + 1} · up to 50 entries per page</span>
          <button disabled={!hasMore || loading || busy} onClick={() => setPage(p => p + 1)}>
            Next
          </button>
        </div>
      </section>
    </main>
  );
}
