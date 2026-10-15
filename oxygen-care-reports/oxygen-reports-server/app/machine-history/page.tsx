'use client';
import { useEffect, useState } from 'react';
import DeviceAttachments from '../device-attachments';
import { brandPrintWindow } from '../print-layout';
import { standardProperties } from '../../lib/report-fields';
import { printHistory } from '../admin-entries';
import { historyChange } from '../../lib/history-change';
import './history.css';
type Item = Record<string, unknown>;
type Data = {
  machine: Item;
  fields: Array<{ name: string; sourceKey: string; kind: string }>;
  reports: Item[];
  services: Item[];
  repairs: Item[];
  dockets: Item[];
  changes: Item[];
  originals: Item[];
  canPrint: boolean;
  identifierLimited: boolean;
};
const shown = (value: unknown) =>
  value === null || value === undefined || value === ''
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
const when = (value: unknown) => {
  const date = new Date(String(value || ''));
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-IE') : shown(value);
};
function Details({ item, fields }: { item: Item; fields: Array<[string, string]> }) {
  return (
    <dl>
      {fields
        .filter(([key]) => item[key] !== undefined && item[key] !== null && item[key] !== '')
        .map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{shown(item[key])}</dd>
          </div>
        ))}
    </dl>
  );
}
export default function MachineHistory() {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [kind, setKind] = useState('all');
  async function load() {
    setBusy(true);
    setError('');
    try {
      const row = new URLSearchParams(window.location.search).get('row') || '',
        response = await fetch('/api/machine-history?row=' + encodeURIComponent(row)),
        body = await response.json();
      if (!response.ok) throw Error(body.error || 'Could not load history.');
      setData(body);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Could not load history.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    window.opener = null;
    void load();
  }, []);
  async function original(item: Item) {
    try {
      const response = await fetch(
          '/api/admin/entries?' +
            new URLSearchParams({
              kind: String(item.entityType),
              id: String(item.entityId),
              history: '1'
            })
        ),
        body = await response.json();
      if (!response.ok) throw Error(body.error || 'Could not load original.');
      const saved = body.history.find((h: { id: string }) => h.id === item.id);
      if (!saved) throw Error('Preserved original not found.');
      if (!printHistory(saved, String(item.entityType).replace(/_/g, ' ')))
        throw Error('Please allow the preserved-original window.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load original.');
    }
  }
  function print() {
    const popup = window.open('', '_blank', 'width=1100,height=850');
    if (!popup) {
      setError('Please allow the print window.');
      return;
    }
    const doc = popup.document;
    doc.open();
    doc.write(
      '<!doctype html><html><head><title>Machine history</title></head><body></body></html>'
    );
    doc.close();
    const content = document.querySelector('.history-content')?.cloneNode(true) as
      | HTMLElement
      | undefined;
    if (content) {
      content
        .querySelectorAll('dl>div')
        .forEach(wrapper => wrapper.replaceWith(...Array.from(wrapper.childNodes)));
      content.querySelectorAll('button').forEach(button => button.remove());
      doc.body.append(content);
    }
    brandPrintWindow(popup);
  }
  const events = data
    ? [
        ...data.reports.map(item => ({
          type: 'report',
          item,
          date: item.date,
          title: 'Uploaded activity — ' + shown(item.fileName)
        })),
        ...data.services.map(item => ({
          type: 'service',
          item,
          date: item.date,
          title: 'Service — ' + shown(item.title)
        })),
        ...data.repairs.map(item => ({
          type: 'repair',
          item,
          date: item.date,
          title: 'Repair — ' + shown(item.entryNumber)
        })),
        ...data.dockets.map(item => ({
          type: 'docket',
          item,
          date: item.date,
          title: 'Docket — ' + shown(item.entryNumber)
        })),
        ...data.changes.map(item => ({
          type: 'change',
          item,
          date: item.date,
          title: historyChange(item).title
        })),
        ...data.originals.map(item => ({
          type: 'original',
          item,
          date: item.date,
          title: 'Preserved original — ' + shown(item.operation)
        }))
      ]
        .filter(event => kind === 'all' || event.type === kind)
        .sort((a, b) => (Date.parse(String(b.date)) || 0) - (Date.parse(String(a.date)) || 0))
    : [];
  return (
    <main className="machine-history">
      <header>
        <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care" />
        <div>
          <h1>Machine history</h1>
          <p>History available to your account</p>
        </div>
        <nav>
          <button disabled={busy} onClick={() => void load()}>
            Refresh
          </button>
          {data?.canPrint && (
            <button disabled={busy} onClick={print}>
              Print / Save PDF
            </button>
          )}
          <button onClick={() => window.close()}>Close</button>
        </nav>
      </header>
      {error && (
        <p className="history-error" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">Loading machine history…</p>}
      {data && (
        <>
          <label className="history-filter">
            Show
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="all">Complete history</option>
              <option value="report">Uploaded activity</option>
              <option value="service">Servicing and parts</option>
              <option value="repair">Repairs</option>
              <option value="docket">Dockets</option>
              <option value="change">Recorded changes</option>
              <option value="original">Preserved originals</option>
            </select>
          </label>
          <section className="history-content">
            <h2>
              {shown(data.machine.deviceName)} · {shown(data.machine.clientName)}
            </h2>
            <Details
              item={data.machine}
              fields={[
                ['serialNumber', 'Serial number'],
                ['assetNumber', 'Asset number'],
                ['lotNumber', 'Lot number'],
                ['status', 'Device status'],
                ['purchasedOn', 'Purchase date'],
                ['decommissionedOn', 'Decommissioned date'],
                ['decommissionReason', 'Decommission reason'],
                ['notes', 'Device notes']
              ]}
            />
            {data.identifierLimited && (
              <p>
                No serial/asset identifier or registered device link is available. Only the selected
                activity record can be shown safely.
              </p>
            )}
            <p>
              {events.length} entries · {kind === 'all' ? 'Complete history' : kind}
            </p>
            {events.map((event, index) => (
              <article key={event.type + '-' + shown(event.item.id) + '-' + index}>
                <time>{when(event.date)}</time>
                <h3>{event.title}</h3>
                {event.type === 'report' && (
                  <dl>
                    {data.fields.map(field => {
                      const key = standardProperties[field.sourceKey],
                        values = (event.item.values || {}) as Item,
                        raw = key ? event.item[key] : values[field.sourceKey],
                        value =
                          field.kind === 'checkbox'
                            ? ['true', 'yes', '1', 'checked'].includes(
                                String(raw || '').toLowerCase()
                              )
                              ? 'Yes'
                              : 'No'
                            : shown(raw);
                      return (
                        <div key={field.sourceKey}>
                          <dt>{field.name}</dt>
                          <dd>{value}</dd>
                        </div>
                      );
                    })}
                  </dl>
                )}
                {event.type === 'service' && (
                  <>
                    <Details
                      item={event.item}
                      fields={[
                        ['contractName', 'Contract'],
                        ['contractNumber', 'Contract number'],
                        ['status', 'Status'],
                        ['location', 'Location'],
                        ['serviceStatus', 'Service status'],
                        ['comments', 'Device service notes'],
                        ['summary', 'Visit summary'],
                        ['recommendations', 'Recommendations']
                      ]}
                    />
                    {typeof event.item.visitId === 'string' &&
                      typeof event.item.deviceId === 'string' && (
                        <DeviceAttachments
                          visitId={event.item.visitId}
                          deviceId={event.item.deviceId}
                          readOnly
                          history
                        />
                      )}
                    <h4>Parts fitted</h4>
                    {(event.item.parts as Item[]).length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Part</th>
                            <th>Quantity</th>
                            <th>Date fitted</th>
                            <th>Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(event.item.parts as Item[]).map((part, i) => (
                            <tr key={i}>
                              <td>
                                {shown(part.partNumber)} · {shown(part.partName)}
                              </td>
                              <td>{shown(part.quantity)}</td>
                              <td>{when(part.fittedAt)}</td>
                              <td>{shown(part.notes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p>No parts recorded for this visit.</p>
                    )}
                    <h4>Sign-off</h4>
                    {(event.item.signatures as Item[]).map((sig, i) => (
                      <p key={i}>
                        {shown(sig.signerRole)}: {shown(sig.signerName)} · {when(sig.signedAt)}
                      </p>
                    ))}
                  </>
                )}
                {event.type === 'repair' && (
                  <Details
                    item={event.item}
                    fields={[
                      ['deviceName', 'Device'],
                      ['status', 'Status'],
                      ['priority', 'Priority'],
                      ['engineerName', 'Engineer'],
                      ['reportedFault', 'Reported fault'],
                      ['conditionReceived', 'Condition on receipt'],
                      ['workCarriedOut', 'Work carried out'],
                      ['partsUsed', 'Parts used'],
                      ['followUpWork', 'Follow-up work'],
                      ['completedDate', 'Completed date']
                    ]}
                  />
                )}
                {event.type === 'docket' && (
                  <>
                    <p>
                      {event.item.correctionPending
                        ? 'Awaiting fresh customer sign-off'
                        : 'Customer-signed completion'}
                    </p>
                    <Details
                      item={event.item}
                      fields={[
                        ['startedAt', 'Time started'],
                        ['endedAt', 'Time ended'],
                        ['workDescription', 'Work completed'],
                        ['engineerName', 'Engineer'],
                        ['signerName', 'Customer']
                      ]}
                    />
                  </>
                )}
                {event.type === 'change' && (
                  <>
                    <p>Changed by {historyChange(event.item).actor}</p>
                    {historyChange(event.item).lines.map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                    <details className="history-technical no-print">
                      <summary>Technical audit details</summary>
                      <Details
                        item={event.item}
                        fields={[
                          ['entityType', 'Entry type'],
                          ['detail', 'Recorded details']
                        ]}
                      />
                    </details>
                  </>
                )}
                {event.type === 'original' && (
                  <>
                    <Details
                      item={event.item}
                      fields={[
                        ['entityType', 'Entry type'],
                        ['operation', 'Change'],
                        ['reason', 'Reason']
                      ]}
                    />
                    <button onClick={() => void original(event.item)}>
                      View / Print preserved original
                    </button>
                  </>
                )}
              </article>
            ))}
            {!events.length && <p>No matching history entries.</p>}
          </section>
        </>
      )}
    </main>
  );
}
