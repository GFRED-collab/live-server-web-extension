'use client';
import { FormEvent, PointerEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { brandPrintWindow } from './print-layout';
import { CalloutRequests } from './callout-requests';
import { EntryList } from './entry-list';
import './fieldwork.css';

type Callout = {
  id: string;
  clientName: string;
  location: string;
  deviceName?: string;
  serialNumber?: string;
  description: string;
  priority: string;
  status: string;
  assignedUserId: string;
  assignedUserName: string;
  createdAt: string;
};
type LookupItem = {
  id: string;
  clientId?: string;
  clientName: string;
  address: string;
  contactName: string;
  deviceName?: string;
  serialNumber?: string;
  assetNumber?: string;
};
type Docket = {
  startedAt?: string | null;
  endedAt?: string | null;
  correctionPending?: boolean;
  version?: string;
  id: string;
  entryNumber: string;
  clientName: string;
  location: string;
  deviceName: string;
  serialNumber: string;
  workDescription: string;
  engineerName: string;
  signerName: string;
  signerRole: string;
  signedAt: string;
};
type Data = {
  callouts: Callout[];
  dockets: Docket[];
  engineers: Array<{ id: string; name: string }>;
};
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Request failed.');
  return data;
}

export function CalloutNav({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [count, setCount] = useState(0),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void api<{ count: number }>('/api/fieldwork?notifications=1')
        .then(data => {
          if (alive) {
            setCount(data.count);
            setFailed(false);
          }
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    window.addEventListener('fieldwork-updated', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('fieldwork-updated', refresh);
    };
  }, []);
  return (
    <button className={active ? 'active' : ''} onClick={onClick}>
      <b aria-hidden="true">☎</b>Call-outs
      {count > 0 && (
        <span className="callout-bubble" aria-label={`${count} new call-outs`}>
          {count}
        </span>
      )}
      {failed && (
        <span title="Could not refresh notifications" aria-label="Notifications unavailable">
          !
        </span>
      )}
    </button>
  );
}

function RecordLookup({
  kind,
  clientId,
  onSelect
}: {
  kind: 'clients' | 'devices';
  clientId: string;
  onSelect: (item: LookupItem) => void;
}) {
  const [search, setSearch] = useState(''),
    [items, setItems] = useState<LookupItem[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [more, setMore] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setItems([]);
    setError('');
    const timer = setTimeout(() => {
      void api<{ items: LookupItem[]; hasMore: boolean }>(
        '/api/fieldwork/lookup?' +
          new URLSearchParams({ kind, q: search, client: kind === 'devices' ? clientId : '' }),
        { signal: controller.signal }
      )
        .then(data => {
          if (!controller.signal.aborted) {
            setItems(data.items);
            setMore(data.hasMore);
            setLoading(false);
          }
        })
        .catch(e => {
          if (!controller.signal.aborted) {
            setError(e.message);
            setLoading(false);
          }
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [kind, clientId, search]);
  return (
    <div className="record-lookup">
      <label>
        {kind === 'clients' ? 'Find client' : 'Find device'}
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={
            kind === 'clients'
              ? 'Client name, address or contact'
              : 'Device, serial or asset number'
          }
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <label>
        {kind === 'clients' ? 'Client results' : 'Device results'}
        <select
          value=""
          disabled={loading}
          onChange={e => {
            const item = items.find(item => item.id === e.target.value);
            if (item) onSelect(item);
          }}
        >
          <option value="">
            {loading
              ? 'Searching…'
              : items.length
                ? 'Select to fill details'
                : 'No matching records'}
          </option>
          {items.map(item => (
            <option key={item.id} value={item.id}>
              {kind === 'clients'
                ? item.clientName + ' — ' + (item.address || item.contactName || 'No address')
                : item.deviceName +
                  ' · Serial: ' +
                  (item.serialNumber || '—') +
                  ' · Asset: ' +
                  (item.assetNumber || '—') +
                  ' · ' +
                  item.clientName}
            </option>
          ))}
        </select>
      </label>
      {more && <small>First 50 results. Refine your search.</small>}
    </div>
  );
}

function DocketSignOff({
  docket,
  close,
  saved
}: {
  docket: Docket;
  close: () => void;
  saved: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    drawing = useRef(false),
    lock = useRef(false);
  const [name, setName] = useState(docket.signerName),
    [ink, setInk] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  function draw(e: PointerEvent<HTMLCanvasElement>, start = false) {
    if (busy || (!start && !drawing.current)) return;
    const c = e.currentTarget,
      r = c.getBoundingClientRect(),
      ctx = c.getContext('2d')!,
      x = ((e.clientX - r.left) * c.width) / r.width,
      y = ((e.clientY - r.top) * c.height) / r.height;
    if (start) {
      drawing.current = true;
      c.setPointerCapture(e.pointerId);
      ctx.beginPath();
      ctx.moveTo(x, y);
    } else {
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#111';
      ctx.lineTo(x, y);
      ctx.stroke();
      setInk(true);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ink || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await api('/api/fieldwork/dockets/' + docket.id, {
        method: 'POST',
        body: JSON.stringify({
          signerName: name,
          signatureData: ref.current?.toDataURL('image/png'),
          version: docket.version
        })
      });
      saved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="docket-signoff"
      onCancel={e => {
        if (busy) e.preventDefault();
        else close();
      }}
    >
      <h2>Customer sign-off — {docket.entryNumber}</h2>
      <p>
        {docket.clientName} · {docket.location} · {docket.deviceName} · {docket.serialNumber} ·{' '}
        {docket.engineerName}
      </p>
      <p>
        {docket.startedAt ? new Date(docket.startedAt).toLocaleString('en-IE') : 'Not recorded'} –{' '}
        {docket.endedAt ? new Date(docket.endedAt).toLocaleString('en-IE') : 'Not recorded'}
      </p>
      <p>{docket.workDescription}</p>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      <form onSubmit={submit}>
        <label>
          Customer name
          <input
            required
            maxLength={160}
            disabled={busy}
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </label>
        <p>Customer signature confirming the corrected work details</p>
        <canvas
          ref={ref}
          width={700}
          height={180}
          aria-label="Corrected docket customer signature"
          onPointerDown={e => draw(e, true)}
          onPointerMove={e => draw(e)}
          onPointerUp={() => {
            drawing.current = false;
          }}
          onPointerCancel={() => {
            drawing.current = false;
          }}
        />
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const c = ref.current!;
              c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
              setInk(false);
            }}
          >
            Clear signature
          </button>
          <button disabled={!ink || busy} type="submit">
            {busy ? 'Saving…' : 'Save customer sign-off'}
          </button>
          <button disabled={busy} type="button" onClick={close}>
            Close
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function Fieldwork({
  mode,
  sidebar,
  user,
  initialCalloutId = '',
  onInitialCalloutUsed,
  openDocket
}: {
  mode: 'callouts' | 'dockets';
  sidebar: ReactNode;
  user: { id: string; displayName: string; role: string };
  initialCalloutId?: string;
  onInitialCalloutUsed?: () => void;
  openDocket?: (calloutId: string) => void;
}) {
  const [data, setData] = useState<Data>({ callouts: [], dockets: [], engineers: [] }),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [signed, setSigned] = useState(false);
  const [signingDocket, setSigningDocket] = useState<Docket | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [clientId, setClientId] = useState(''),
    [calloutSearch, setCalloutSearch] = useState(''),
    [relatedCallout, setRelatedCallout] = useState('');
  const [tab, setTab] = useState<'entry' | 'lookup'>('entry');
  function fill(values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) {
      const input = formRef.current?.elements.namedItem(key);
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)
        input.value = value;
    }
    clear();
  }
  function selectClient(item: LookupItem) {
    setClientId(item.id);
    setRelatedCallout('');
    fill({
      clientName: item.clientName,
      location: item.address || '',
      deviceName: '',
      serialNumber: '',
      signerName: item.contactName || ''
    });
  }
  function selectDevice(item: LookupItem) {
    setClientId(item.clientId || '');
    setRelatedCallout('');
    fill({
      clientName: item.clientName,
      location: item.address || '',
      deviceName: item.deviceName || '',
      serialNumber: item.serialNumber || '',
      signerName: item.contactName || ''
    });
  }
  function selectCallout(id: string) {
    setRelatedCallout(id);
    const item = data.callouts.find(item => item.id === id);
    if (item) {
      setClientId('');
      fill({
        clientName: item.clientName,
        location: item.location,
        deviceName: item.deviceName || '',
        serialNumber: item.serialNumber || '',
        signerName: ''
      });
    } else clear();
  }
  const canvas = useRef<HTMLCanvasElement>(null),
    drawing = useRef(false),
    ink = useRef(false),
    lock = useRef(false);
  async function load() {
    const result = await api<Data>('/api/fieldwork');
    setData(result);
  }
  useEffect(() => {
    void load().catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    if (mode !== 'dockets' || !initialCalloutId) return;
    if (!data.callouts.some(c => c.id === initialCalloutId)) return;
    selectCallout(initialCalloutId);
    setTab('entry');
    onInitialCalloutUsed?.();
    // selectCallout and onInitialCalloutUsed change every render; run once the data arrives.
  }, [data, initialCalloutId, mode]);
  useEffect(() => {
    setClientId('');
    setRelatedCallout('');
    setCalloutSearch('');
    setError('');
    setNotice('');
    clear();
  }, [mode]);
  function clear() {
    const c = canvas.current;
    if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    ink.current = false;
    setSigned(false);
  }
  function point(event: PointerEvent<HTMLCanvasElement>) {
    const c = event.currentTarget,
      r = c.getBoundingClientRect();
    return {
      x: ((event.clientX - r.left) * c.width) / r.width,
      y: ((event.clientY - r.top) * c.height) / r.height
    };
  }
  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (busy) return;
    drawing.current = true;
    const ctx = event.currentTarget.getContext('2d')!,
      p = point(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || busy) return;
    const ctx = event.currentTarget.getContext('2d')!,
      p = point(event);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ink.current = true;
    setSigned(true);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    const form = event.currentTarget,
      values = Object.fromEntries(new FormData(form));
    if (mode === 'dockets' && !ink.current) {
      setError('Ask the customer to draw their completion signature.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/fieldwork', {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          startedAt:
            mode === 'dockets' && values.startedAt
              ? new Date(String(values.startedAt)).toISOString()
              : undefined,
          endedAt:
            mode === 'dockets' && values.endedAt
              ? new Date(String(values.endedAt)).toISOString()
              : undefined,
          kind: mode === 'callouts' ? 'callout' : 'docket',
          signerRole: 'client',
          signatureData: mode === 'dockets' ? canvas.current?.toDataURL('image/png') : undefined
        })
      });
      form.reset();
      setClientId('');
      setRelatedCallout('');
      setCalloutSearch('');
      clear();
      setNotice(
        mode === 'callouts'
          ? 'Call-out created. The assigned engineer has an in-app notification.'
          : 'Customer-signed completion docket saved.'
      );
      window.dispatchEvent(new Event('fieldwork-updated'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function update(id: string, status: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api('/api/fieldwork', { method: 'PATCH', body: JSON.stringify({ id, status }) });
      window.dispatchEvent(new Event('fieldwork-updated'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update call-out.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function printDocket(docket: Docket) {
    const popup = window.open('', '_blank', 'width=1000,height=850');
    if (!popup) {
      setError('Please allow the print window.');
      return;
    }
    popup.opener = null;
    const doc = popup.document;
    doc.open();
    doc.write(
      '<!doctype html><html><head><title>Completion docket</title></head><body></body></html>'
    );
    doc.close();
    doc.body.textContent = 'Loading signed docket…';
    try {
      const {
        signatureData,
        correctionPending,
        docket: current
      } = await api<{ signatureData: string; correctionPending: boolean; docket?: Docket }>(
        `/api/fieldwork/dockets/${docket.id}`
      );
      if (popup.closed) return;
      if (current) docket = { ...docket, ...current };
      doc.body.textContent = '';
      doc.title = docket.entryNumber;
      const h = doc.createElement('h1');
      h.textContent =
        (correctionPending ? 'UNSIGNED CORRECTION — ' : 'Customer completion docket — ') +
        docket.entryNumber;
      doc.body.append(h);
      const dl = doc.createElement('dl');
      for (const [label, value] of [
        ['Client', docket.clientName],
        ['Location', docket.location],
        ['Device', docket.deviceName],
        ['Serial number', docket.serialNumber],
        ['Engineer', docket.engineerName],
        [
          'Time started',
          docket.startedAt ? new Date(docket.startedAt).toLocaleString('en-IE') : 'Not recorded'
        ],
        [
          'Time ended',
          docket.endedAt ? new Date(docket.endedAt).toLocaleString('en-IE') : 'Not recorded'
        ],
        ['Work completed', docket.workDescription],
        ['Customer name', docket.signerName],
        [
          'Signed',
          correctionPending
            ? 'Awaiting fresh customer sign-off'
            : new Date(docket.signedAt).toLocaleString('en-IE')
        ]
      ]) {
        const dt = doc.createElement('dt'),
          dd = doc.createElement('dd');
        dt.textContent = label;
        dd.textContent = value || '—';
        dl.append(dt, dd);
      }
      doc.body.append(dl);
      const caption = doc.createElement('p');
      caption.textContent = 'Customer confirmation of completed work';
      const img = doc.createElement('img');
      img.src = signatureData;
      img.alt = 'Customer completion signature';
      img.style.cssText = 'width:320px;max-width:100%;height:auto';
      if (!correctionPending) {
        doc.body.append(caption, img);
      } else {
        caption.textContent =
          'Corrected docket awaiting customer sign-off. The original signed version is preserved in Manage entries.';
        doc.body.append(caption);
      }
      brandPrintWindow(popup);
    } catch (e) {
      popup.close();
      setError(e instanceof Error ? e.message : 'Could not print docket.');
    }
  }
  return (
    <main className="workspace-shell subpage-shell">
      {sidebar}
      <header className="workspace-header">
        <h1>{mode === 'callouts' ? 'Call-outs' : 'Completion dockets'}</h1>
        <button
          className="access-button"
          onClick={() => void load().catch(e => setError(e.message))}
        >
          Refresh
        </button>
      </header>
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
      <nav className="fieldwork-tabs" aria-label="Fieldwork sections">
        <button
          type="button"
          disabled={busy}
          aria-current={tab === 'entry' ? 'page' : undefined}
          onClick={() => setTab('entry')}
        >
          {mode === 'callouts' ? 'Call-out entry' : 'Docket entry'}
        </button>
        <button
          type="button"
          disabled={busy}
          aria-current={tab === 'lookup' ? 'page' : undefined}
          onClick={() => setTab('lookup')}
        >
          Lookup
        </button>
      </nav>
      <section
        className="fieldwork-form fieldwork-lookup"
        hidden={tab !== 'lookup'}
        aria-label="Lookup"
      >
        <h2>Lookup</h2>
        <fieldset disabled={busy}>
          <div className="fieldwork-grid">
            <RecordLookup kind="clients" clientId="" onSelect={selectClient} />
            <RecordLookup kind="devices" clientId={clientId} onSelect={selectDevice} />
            {mode === 'dockets' && (
              <>
                <label>
                  Find call-out
                  <input
                    type="search"
                    value={calloutSearch}
                    onChange={e => setCalloutSearch(e.target.value)}
                    placeholder="Client, device, serial or details"
                  />
                </label>
                <label>
                  Related call-out
                  <select value={relatedCallout} onChange={e => selectCallout(e.target.value)}>
                    <option value="">None</option>
                    {data.callouts
                      .filter(
                        c =>
                          c.id === relatedCallout ||
                          [c.clientName, c.deviceName, c.serialNumber, c.description, c.status]
                            .join(' ')
                            .toLowerCase()
                            .includes(calloutSearch.toLowerCase())
                      )
                      .map(c => (
                        <option key={c.id} value={c.id}>
                          {c.clientName} — {c.deviceName} {c.serialNumber} — {c.status} —{' '}
                          {c.description.replace(/\s+/g, ' ').slice(0, 65)}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
          </div>
          <button type="button" onClick={() => setTab('entry')}>
            Return to entry
          </button>
        </fieldset>
      </section>
      <form
        ref={formRef}
        key={mode}
        hidden={tab !== 'entry'}
        className="fieldwork-form"
        onSubmit={save}
      >
        <h2>{mode === 'callouts' ? 'New call-out' : 'Customer sign-off'}</h2>
        <fieldset disabled={busy}>
          {mode === 'dockets' && <input type="hidden" name="calloutId" value={relatedCallout} />}
          <div className="fieldwork-grid">
            {mode === 'dockets' && (
              <label className="wide">
                Related call-out
                <select
                  aria-label="Related call-out"
                  value={relatedCallout}
                  onChange={e => selectCallout(e.target.value)}
                >
                  <option value="">None: enter the details below</option>
                  {data.callouts
                    .filter(c => c.status !== 'closed' || c.id === relatedCallout)
                    .map(c => (
                      <option key={c.id} value={c.id}>
                        {[c.clientName, c.deviceName, c.serialNumber].filter(Boolean).join(' · ')} —{' '}
                        {c.description.replace(/\s+/g, ' ').slice(0, 65)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label>
              Client
              <input
                name="clientName"
                required
                maxLength={160}
                onChange={() => {
                  setClientId('');
                  setRelatedCallout('');
                  clear();
                }}
              />
            </label>
            <label>
              Location
              <input name="location" maxLength={300} />
            </label>
            {mode === 'callouts' ? (
              <>
                <label>
                  Device / machine
                  <input name="deviceName" maxLength={160} />
                </label>
                <label>
                  Serial number
                  <input name="serialNumber" maxLength={160} />
                </label>
                <label>
                  Assign to
                  <select name="assignedUserId" defaultValue={user.id} required>
                    {data.engineers.map(e => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Priority
                  <select name="priority">
                    <option value="normal">Normal</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </label>
                <label className="wide">
                  Call-out details
                  <textarea name="description" rows={4} required maxLength={10000} />
                </label>
              </>
            ) : (
              <>
                {relatedCallout && (
                  <div className="wide reported-issue">
                    <strong>Reported issue</strong>
                    <p>{data.callouts.find(c => c.id === relatedCallout)?.description}</p>
                  </div>
                )}
                <label>
                  Device / machine
                  <input name="deviceName" maxLength={160} />
                </label>
                <label>
                  Serial number
                  <input name="serialNumber" maxLength={160} />
                </label>
                <label>
                  Engineer
                  <input readOnly value={user.displayName} />
                </label>
                <label>
                  Time started
                  <input
                    aria-label="Time started"
                    name="startedAt"
                    type="datetime-local"
                    required
                  />
                </label>
                <label>
                  Time ended
                  <input aria-label="Time ended" name="endedAt" type="datetime-local" required />
                </label>
                <label className="wide">
                  Work completed
                  <textarea name="workDescription" rows={4} required maxLength={10000} />
                </label>
                <label>
                  Customer name
                  <input name="signerName" required maxLength={160} />
                </label>
                <div className="wide">
                  <p>Customer signature confirming completion</p>
                  <canvas
                    ref={canvas}
                    width={700}
                    height={180}
                    aria-label="Customer completion signature"
                    onPointerDown={start}
                    onPointerMove={move}
                    onPointerUp={() => {
                      drawing.current = false;
                    }}
                    onPointerCancel={() => {
                      drawing.current = false;
                    }}
                  />
                  <button type="button" onClick={clear}>
                    Clear signature
                  </button>
                  <p className="muted">
                    Super User corrections preserve the original and require fresh customer
                    sign-off.
                  </p>
                </div>
              </>
            )}
          </div>
          <button
            type="submit"
            className="primary"
            disabled={busy || (mode === 'dockets' && !signed)}
          >
            {busy
              ? 'Saving…'
              : mode === 'callouts'
                ? 'Create call-out'
                : 'Save signed completion docket'}
          </button>
        </fieldset>
      </form>
      {mode === 'callouts' && user.role === 'super_user' && tab === 'entry' && (
        <CalloutRequests
          engineers={data.engineers.filter(engineer => engineer.id !== user.id)}
          onAccepted={() => void load().catch(e => setError(e.message))}
        />
      )}
      <section hidden={tab !== 'entry'} className="fieldwork-list">
        <h2>{mode === 'callouts' ? 'Call-out register' : 'Docket register'}</h2>
        {mode === 'callouts' ? (
          <EntryList
            label="Call-out register"
            items={data.callouts}
            getKey={c => c.id}
            title={c => `Call-out · ${c.clientName}`}
            details={c => [
              ['Logged', new Date(c.createdAt).toLocaleString('en-IE')],
              ['Client', c.clientName],
              ['Location', c.location],
              ['Device', c.deviceName],
              ['Serial number', c.serialNumber],
              ['Details', c.description],
              ['Assigned to', c.assignedUserName],
              ['Priority', c.priority === 'urgent' ? 'Urgent' : 'Normal'],
              ['Status', c.status]
            ]}
            disabled={busy}
            badge={c => (c.status === 'open' ? <span className="callout-bubble">New</span> : null)}
            line={c => [
              new Date(c.createdAt).toLocaleDateString('en-IE'),
              c.clientName,
              c.deviceName && `${c.deviceName} ${c.serialNumber || ''}`.trim(),
              c.description,
              c.location,
              c.assignedUserName,
              c.priority === 'urgent' ? 'Urgent' : '',
              c.status
            ]}
            actions={c => (
              <>
                {c.status === 'open' && (
                  <button disabled={busy} onClick={() => void update(c.id, 'acknowledged')}>
                    Acknowledge
                  </button>
                )}
                {c.status !== 'closed' && openDocket && (
                  <button disabled={busy} onClick={() => openDocket(c.id)}>
                    Create docket
                  </button>
                )}
                {c.status !== 'closed' && (
                  <button disabled={busy} onClick={() => void update(c.id, 'closed')}>
                    Close call-out
                  </button>
                )}
              </>
            )}
          />
        ) : (
          <EntryList
            label="Docket register"
            items={data.dockets}
            getKey={d => d.id}
            title={d => `Docket ${d.entryNumber} · ${d.clientName}`}
            details={d => [
              ['Docket', d.entryNumber],
              ['Client', d.clientName],
              ['Location', d.location],
              ['Device', d.deviceName],
              ['Serial number', d.serialNumber],
              ['Engineer', d.engineerName],
              ['Time started', d.startedAt ? new Date(d.startedAt).toLocaleString('en-IE') : ''],
              ['Time ended', d.endedAt ? new Date(d.endedAt).toLocaleString('en-IE') : ''],
              ['Work completed', d.workDescription],
              ['Customer', d.signerName],
              [
                'Signed',
                d.correctionPending
                  ? 'Awaiting fresh customer sign-off'
                  : new Date(d.signedAt).toLocaleString('en-IE')
              ]
            ]}
            line={d => [
              d.entryNumber,
              d.correctionPending
                ? 'Awaiting fresh customer sign-off'
                : new Date(d.signedAt).toLocaleString('en-IE'),
              d.clientName,
              d.deviceName && `${d.deviceName} ${d.serialNumber || ''}`.trim(),
              `Customer: ${d.signerName}`,
              d.workDescription
            ]}
            actions={d => (
              <>
                <button onClick={() => void printDocket(d)}>Print / PDF</button>
                {d.correctionPending && (
                  <button onClick={() => setSigningDocket(d)}>Customer sign-off</button>
                )}
              </>
            )}
          />
        )}
      </section>
      {signingDocket && (
        <DocketSignOff
          docket={signingDocket}
          close={() => setSigningDocket(null)}
          saved={() => {
            setSigningDocket(null);
            void load().catch(e => setError(e.message));
            setNotice('Corrected docket signed by the customer.');
          }}
        />
      )}
    </main>
  );
}
