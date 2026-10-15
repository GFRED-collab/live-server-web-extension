'use client';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { csvText } from '../lib/csv-export';
import './report-tools.css';

export function BookingDates({ start, end }: { start: string; end?: string }) {
  const [from, setFrom] = useState(start),
    [to, setTo] = useState(end || start);
  return (
    <>
      <label>
        START DATE
        <input
          aria-label="Start date"
          name="appointmentDate"
          type="date"
          required
          value={from}
          onChange={e => {
            setFrom(e.target.value);
            if (to < e.target.value) setTo(e.target.value);
          }}
        />
      </label>
      <label>
        END DATE
        <input
          aria-label="End date"
          name="endDate"
          type="date"
          required
          min={from}
          value={to}
          onChange={e => setTo(e.target.value)}
        />
      </label>
    </>
  );
}
export function FieldEditor({
  field,
  close,
  save
}: {
  field: { id: string; name: string; kind: string };
  close: () => void;
  save: (name: string, kind: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    lock = useRef(false),
    [name, setName] = useState(field.name),
    [kind, setKind] = useState(field.kind),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await save(name, kind);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update field.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      className="report-dialog"
      ref={ref}
      onCancel={e => {
        if (busy) e.preventDefault();
        else close();
      }}
    >
      <h2>Edit report field</h2>
      <p>Saved values and user permissions are retained.</p>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={submit}>
        <label>
          Field name
          <input
            aria-label="Edit field name"
            required
            maxLength={80}
            disabled={busy}
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </label>
        <label>
          Field type
          <select
            aria-label="Edit field type"
            disabled={busy}
            value={kind}
            onChange={e => setKind(e.target.value)}
          >
            <option value="text">Regular field</option>
            <option value="checkbox">Checkbox</option>
            <option value="comments">Comments</option>
          </select>
        </label>
        <div>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save field'}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
export function CsvPreview({
  columns,
  rows,
  close
}: {
  columns: string[];
  rows: string[][];
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [page, setPage] = useState(0);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  function download() {
    const url = URL.createObjectURL(
        new Blob([csvText(columns, rows)], { type: 'text/csv;charset=utf-8' })
      ),
      link = document.createElement('a');
    link.href = url;
    link.download = 'oxygen-care-filtered-report.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <dialog className="report-dialog csv-preview" ref={ref} onCancel={close}>
      <h2>CSV export preview</h2>
      <p>
        {rows.length} filtered records · {columns.length} columns. Download uses this preview and
        column order.
      </p>
      <div className="csv-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((name, i) => (
                <th key={i}>{name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(page * 50, (page + 1) * 50).map((row, i) => (
              <tr key={i}>
                {row.map((value, j) => (
                  <td key={j}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p>No matching records; the CSV will contain headers only.</p>}
      <div className="csv-actions">
        <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>
          Previous
        </button>
        <span>
          Page {page + 1} of {Math.max(1, Math.ceil(rows.length / 50))}
        </span>
        <button disabled={(page + 1) * 50 >= rows.length} onClick={() => setPage(p => p + 1)}>
          Next
        </button>
        <button onClick={download}>Download CSV</button>
        <button onClick={close}>Cancel</button>
      </div>
    </dialog>
  );
}
