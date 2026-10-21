'use client';
import { FormEvent, useEffect, useState } from 'react';

type Contract = { id: string; name: string; contractNumber: string };
type Device = {
  id: string;
  contractId: string;
  deviceName: string;
  serialNumber: string;
  assetNumber: string;
  removedOn: string | null;
};
type CalloutRequest = {
  id: string;
  reference: string;
  contractId: string | null;
  deviceId: string | null;
  description: string;
  priority: string;
  status: 'new' | 'accepted' | 'declined';
  declineReason: string;
  createdAt: string;
  calloutStatus: string | null;
};

function statusText(request: CalloutRequest) {
  if (request.status === 'new') return 'Waiting for review';
  if (request.status === 'declined')
    return 'Declined' + (request.declineReason ? `: ${request.declineReason}` : '');
  if (request.calloutStatus === 'closed') return 'Completed';
  if (request.calloutStatus === 'acknowledged') return 'Engineer on the way';
  return 'Accepted · engineer assigned';
}

/** Lets a customer ask Irish Hospital Supplies for a callout and follow what happened to it. */
export function CustomerCalloutRequests({
  contracts,
  devices
}: {
  contracts: Contract[];
  devices: Device[];
}) {
  const [requests, setRequests] = useState<CalloutRequest[]>([]),
    [contractId, setContractId] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch('/api/customer-portal/callout-requests', { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.error || 'Could not load your requests.');
    setRequests(body.requests);
  }
  useEffect(() => {
    void load().catch(e => setError(e.message));
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = Object.fromEntries(new FormData(form).entries());
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/customer-portal/callout-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(body.error || 'Could not send your request.');
      form.reset();
      setContractId('');
      setNotice(
        `Request ${body.reference} sent. Irish Hospital Supplies will review it and assign an engineer.`
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your request.');
    } finally {
      setBusy(false);
    }
  }
  const deviceLabel = (id: string | null) => {
    const device = devices.find(d => d.id === id);
    return device ? `${device.deviceName} · ${device.serialNumber || device.assetNumber}` : '';
  };
  return (
    <section className="customer-requests">
      <form onSubmit={submit}>
        <h2>Request a callout</h2>
        <p>
          Tell us what is wrong and we will assign an engineer. For an emergency, also phone Oxygen
          Care.
        </p>
        <label>
          Contract
          <select
            name="contractId"
            value={contractId}
            onChange={e => setContractId(e.target.value)}
          >
            <option value="">Not sure / not listed</option>
            {contracts.map(c => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.contractNumber}
              </option>
            ))}
          </select>
        </label>
        <label>
          Device
          <select name="deviceId" disabled={!contractId} defaultValue="">
            <option value="">
              {contractId ? 'Not sure / not listed' : 'Choose a contract first'}
            </option>
            {devices
              .filter(d => d.contractId === contractId && !d.removedOn)
              .map(d => (
                <option key={d.id} value={d.id}>
                  {d.deviceName} · {d.serialNumber || d.assetNumber}
                </option>
              ))}
          </select>
        </label>
        <label>
          What is the problem?
          <textarea name="description" required maxLength={2000} rows={5} />
        </label>
        <label>
          How urgent is it?
          <select name="priority" defaultValue="normal">
            <option value="normal">Normal</option>
            <option value="urgent">Urgent: the device cannot be used</option>
          </select>
        </label>
        <label>
          Where is the device?
          <input name="location" maxLength={300} placeholder="Ward, room or address" />
        </label>
        <label>
          Contact name
          <input name="contactName" maxLength={200} autoComplete="name" />
        </label>
        <label>
          Contact phone
          <input name="contactPhone" maxLength={50} type="tel" autoComplete="tel" />
        </label>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <button disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
      </form>
      <div className="customer-table">
        <h2>My requests</h2>
        <table>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Status</th>
              <th>Problem</th>
              <th>Device</th>
              <th>Priority</th>
              <th>Sent</th>
            </tr>
          </thead>
          <tbody>
            {requests.map(r => (
              <tr key={r.id}>
                <td>{r.reference}</td>
                <td>{statusText(r)}</td>
                <td>{r.description}</td>
                <td>{deviceLabel(r.deviceId) || '—'}</td>
                <td>{r.priority === 'urgent' ? 'Urgent' : 'Normal'}</td>
                <td>{new Date(r.createdAt).toLocaleString('en-IE')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!requests.length && <p>You have not sent any requests yet.</p>}
      </div>
    </section>
  );
}
