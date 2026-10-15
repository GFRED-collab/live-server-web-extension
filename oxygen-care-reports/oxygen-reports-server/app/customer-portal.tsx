'use client';
import { useEffect, useMemo, useState } from 'react';
import { CsvPreview } from './report-tools';
import { brandPrintWindow } from './print-layout';
import { ServiceReport, writeServiceReport } from './service-report';
import { CustomerCalloutRequests } from './customer-callout-requests';
import './customer-portal.css';
type Contract = {
  id: string;
  name: string;
  contractNumber: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
};
type Device = {
  id: string;
  contractId: string;
  deviceName: string;
  serialNumber: string;
  assetNumber: string;
  lotNumber: string;
  status: string;
  removedOn: string | null;
};
type Service = {
  id: string;
  deviceId: string;
  contractId: string;
  visitId: string;
  date: string;
  title: string;
  location: string;
  serviceStatus: string;
  parts: Array<{ partNumber: string; partName: string; quantity: number }>;
  signatures: Array<{ role: string; name: string; signedAt: string }>;
};
type Data = {
  client: { name: string; contactName: string; email: string; phone: string; address: string };
  contracts: Contract[];
  devices: Device[];
  services: Service[];
  canExport: boolean;
};
type Tab = 'contracts' | 'devices' | 'history' | 'requests';
export default function CustomerPortal({ logout }: { logout: () => void }) {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [tab, setTab] = useState<Tab>('contracts'),
    [contract, setContract] = useState(''),
    [device, setDevice] = useState(''),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [csv, setCsv] = useState<{ columns: string[]; rows: string[][] } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/customer-portal', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw Error(body.error || 'Could not load your portal.');
        setData(body);
      })
      .catch(e => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  const view = useMemo(() => {
    const contracts = data?.contracts || [],
      devices = data?.devices || [],
      services = data?.services || [],
      needle = query.trim().toLowerCase();
    const contractName = (id: string) => {
      const c = contracts.find(c => c.id === id);
      return c ? [c.name, c.contractNumber].filter(Boolean).join(' · ') : '';
    };
    const findDevice = (id: string, cid: string) =>
      devices.find(d => d.id === id && d.contractId === cid);
    const match = (values: unknown[]) => values.join(' ').toLowerCase().includes(needle);
    if (tab === 'contracts')
      return {
        columns: ['Contract', 'Number', 'Status', 'Start', 'End'],
        rows: contracts
          .filter(
            c =>
              (!contract || c.id === contract) &&
              (!status || c.status === status) &&
              match([c.name, c.contractNumber])
          )
          .map(c => [c.name, c.contractNumber, c.status, c.startDate || '', c.endDate || '']),
        ids: [] as string[]
      };
    if (tab === 'devices') {
      const filtered = devices.filter(
        d =>
          (!contract || d.contractId === contract) &&
          (!device || d.id === device) &&
          (!status || d.status === status) &&
          match([
            d.deviceName,
            d.serialNumber,
            d.assetNumber,
            d.lotNumber,
            contractName(d.contractId)
          ])
      );
      return {
        columns: ['Contract', 'Device', 'Serial', 'Asset', 'Lot', 'Status'],
        rows: filtered.map(d => [
          contractName(d.contractId),
          d.deviceName,
          d.serialNumber,
          d.assetNumber,
          d.lotNumber,
          d.removedOn ? 'Removed from contract' : d.status
        ]),
        ids: filtered.map(d => d.id)
      };
    }
    const filtered = services.filter(s => {
      const d = findDevice(s.deviceId, s.contractId);
      return (
        (!contract || s.contractId === contract) &&
        (!device || s.deviceId === device) &&
        (!status || s.serviceStatus === status) &&
        (!from || s.date >= from) &&
        (!to || s.date <= to) &&
        match([d?.deviceName, d?.serialNumber, d?.assetNumber, s.title, contractName(s.contractId)])
      );
    });
    return {
      columns: [
        'Date',
        'Contract',
        'Device',
        'Serial',
        'Service status',
        'Parts fitted',
        'Sign-off'
      ],
      rows: filtered.map(s => {
        const d = findDevice(s.deviceId, s.contractId);
        return [
          s.date,
          contractName(s.contractId),
          d?.deviceName || '',
          d?.serialNumber || '',
          s.serviceStatus || '',
          s.parts.map(p => p.partNumber + ' · ' + p.partName + ' × ' + p.quantity).join('\n'),
          s.signatures
            .map(
              sig =>
                (sig.role === 'client' ? 'Customer' : 'Engineer') +
                ': ' +
                sig.name +
                ' · ' +
                new Date(sig.signedAt).toLocaleString('en-IE')
            )
            .join('\n')
        ];
      }),
      ids: filtered.map(s => s.visitId)
    };
  }, [data, tab, contract, device, query, status, from, to]);
  function print() {
    const popup = window.open('', '_blank');
    if (!popup) {
      setError('Allow pop-ups to open the print preview.');
      return;
    }
    popup.opener = null;
    const doc = popup.document;
    doc.title = 'Customer ' + tab;
    const add = (tag: string, text: string, parent: HTMLElement = doc.body) => {
      const el = doc.createElement(tag);
      el.textContent = text;
      parent.append(el);
      return el;
    };
    add('h1', data!.client.name + ' — ' + (tab === 'history' ? 'Device service history' : tab));
    add(
      'p',
      [data!.client.contactName, data!.client.address, data!.client.email, data!.client.phone]
        .filter(Boolean)
        .join('\n')
    );
    add(
      'p',
      [
        query && 'Search: ' + query,
        from && 'From: ' + from,
        to && 'To: ' + to,
        status && 'Status: ' + status,
        view.rows.length + ' results'
      ]
        .filter(Boolean)
        .join(' · ')
    );
    const table = add('table', ''),
      head = add('thead', '', table),
      row = add('tr', '', head);
    view.columns.forEach(c => add('th', c, row));
    const body = add('tbody', '', table);
    view.rows.forEach(values => {
      const tr = add('tr', '', body);
      values.forEach(v => add('td', v, tr));
    });
    brandPrintWindow(popup);
  }
  async function openReport(visitId: string) {
    // Open the window before the download so the browser does not block it as a pop-up.
    const popup = window.open('', '_blank');
    if (!popup) {
      setError('Allow pop-ups to open the service report.');
      return;
    }
    popup.opener = null;
    popup.document.title = 'Loading service report…';
    popup.document.body.textContent = 'Loading service report…';
    try {
      const response = await fetch(`/api/customer-portal/service-visits/${visitId}`, {
        cache: 'no-store'
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(body.error || 'Could not open the service report.');
      writeServiceReport(popup, body as ServiceReport);
    } catch (e) {
      popup.close();
      setError(e instanceof Error ? e.message : 'Could not open the service report.');
    }
  }
  function switchTab(next: Tab) {
    setTab(next);
    setStatus('');
    setQuery('');
    setFrom('');
    setTo('');
    setDevice('');
  }
  const statuses =
    tab === 'contracts'
      ? ['active', 'paused', 'closed']
      : tab === 'devices'
        ? ['active', 'decommissioned']
        : Array.from(new Set(data?.services.map(s => s.serviceStatus).filter(Boolean) || []));
  return (
    <main className="customer-portal">
      <header>
        <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care" />
        <div>
          <h1>{data?.client.name || 'Customer portal'}</h1>
          <span>My contracts</span>
        </div>
        <button onClick={logout}>Log out</button>
      </header>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading your contracts…</p>}
      {data && (
        <>
          <nav aria-label="Customer sections">
            {(['contracts', 'devices', 'history', 'requests'] as Tab[]).map(name => (
              <button key={name} aria-pressed={tab === name} onClick={() => switchTab(name)}>
                {name === 'history'
                  ? 'Service history'
                  : name === 'devices'
                    ? 'Devices'
                    : name === 'requests'
                      ? 'Request a callout'
                      : 'Contracts'}
              </button>
            ))}
          </nav>
          {tab === 'requests' ? (
            <CustomerCalloutRequests contracts={data.contracts} devices={data.devices} />
          ) : (
            <>
              <section className="customer-filters" aria-label="Portal filters">
                <label>
                  Contract
                  <select
                    aria-label="Contract"
                    value={contract}
                    onChange={e => {
                      setContract(e.target.value);
                      setDevice('');
                    }}
                  >
                    <option value="">All contracts</option>
                    {data.contracts.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.contractNumber}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Search
                  <input
                    type="search"
                    placeholder="Device, serial, asset or contract"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                  />
                </label>
                <label>
                  Status
                  <select
                    aria-label="Status"
                    value={status}
                    onChange={e => setStatus(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {statuses.map(s => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                {tab === 'history' && (
                  <>
                    <label>
                      Device
                      <select
                        aria-label="Device"
                        value={device}
                        onChange={e => setDevice(e.target.value)}
                      >
                        <option value="">All devices</option>
                        {data.devices
                          .filter(d => !contract || d.contractId === contract)
                          .map(d => (
                            <option key={d.contractId + d.id} value={d.id}>
                              {d.deviceName} · {d.serialNumber || d.assetNumber}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      From
                      <input
                        type="date"
                        value={from}
                        max={to || undefined}
                        onChange={e => setFrom(e.target.value)}
                      />
                    </label>
                    <label>
                      To
                      <input
                        type="date"
                        value={to}
                        min={from || undefined}
                        onChange={e => setTo(e.target.value)}
                      />
                    </label>
                  </>
                )}
                <button
                  onClick={() => {
                    setContract('');
                    setDevice('');
                    setQuery('');
                    setStatus('');
                    setFrom('');
                    setTo('');
                  }}
                >
                  Clear filters
                </button>
              </section>
              <div className="customer-actions">
                <span>{view.rows.length} results</span>
                {data.canExport && (
                  <>
                    <button onClick={print}>Print / Save PDF</button>
                    <button onClick={() => setCsv({ columns: view.columns, rows: view.rows })}>
                      Export CSV
                    </button>
                  </>
                )}
              </div>
              <div className="customer-table">
                <table>
                  <thead>
                    <tr>
                      {view.columns.map(c => (
                        <th key={c}>{c}</th>
                      ))}
                      {tab === 'devices' && <th>History</th>}
                      {tab === 'history' && data.canExport && <th>Report</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((row, i) => (
                      <tr key={i}>
                        {row.map((v, j) => (
                          <td key={j}>{v || '—'}</td>
                        ))}
                        {tab === 'history' && data.canExport && (
                          <td>
                            <button onClick={() => void openReport(view.ids[i])}>
                              Signed report
                            </button>
                          </td>
                        )}
                        {tab === 'devices' && (
                          <td>
                            <button
                              onClick={() => {
                                setTab('history');
                                setDevice(view.ids[i]);
                                setQuery('');
                                setStatus('');
                                setFrom('');
                                setTo('');
                              }}
                            >
                              Open history
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!view.rows.length && (
                <p>
                  No matching records
                  {tab === 'history'
                    ? ' — only finalized, signed service visits are available'
                    : ''}
                  .
                </p>
              )}
            </>
          )}
        </>
      )}
      {csv && <CsvPreview {...csv} close={() => setCsv(null)} />}
    </main>
  );
}
