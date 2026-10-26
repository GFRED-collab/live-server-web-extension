'use client';
import { isoDateTime } from '../lib/dates';
import { useEffect, useState } from 'react';
import { EntryList } from './entry-list';

type CalloutRequest = {
  id: string;
  reference: string;
  status: 'new' | 'accepted' | 'declined';
  priority: string;
  description: string;
  location: string;
  contactName: string;
  contactPhone: string;
  declineReason: string;
  createdAt: string;
  decidedAt: string | null;
  clientName: string;
  contractName: string | null;
  contractNumber: string | null;
  deviceName: string | null;
  serialNumber: string | null;
  requestedByName: string | null;
  requestedByEmail: string | null;
  decidedByName: string | null;
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Request failed.');
  return data;
}

/** Super User review of callout requests customers sent from the portal. */
export function CalloutRequests({
  engineers,
  onAccepted
}: {
  engineers: Array<{ id: string; name: string }>;
  onAccepted: () => void;
}) {
  const [requests, setRequests] = useState<CalloutRequest[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [engineerFor, setEngineerFor] = useState<Record<string, string>>({});
  async function load() {
    setRequests((await api<{ requests: CalloutRequest[] }>('/api/callout-requests')).requests);
  }
  useEffect(() => {
    void load().catch(e => setError(e.message));
  }, []);
  async function decide(request: CalloutRequest, action: 'accept' | 'decline') {
    let reason = '';
    if (action === 'decline') {
      reason =
        window.prompt(`Reason for declining ${request.reference} (shown to the customer):`) || '';
      if (!reason.trim()) return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/api/callout-requests/${request.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, assignedUserId: engineerFor[request.id] || '', reason })
      });
      setNotice(
        action === 'accept'
          ? `${request.reference} accepted and added to the call-out register.`
          : `${request.reference} declined.`
      );
      await load();
      if (action === 'accept') onAccepted();
      window.dispatchEvent(new Event('fieldwork-updated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the request.');
    } finally {
      setBusy(false);
    }
  }
  const waiting = requests.filter(r => r.status === 'new'),
    decided = requests.filter(r => r.status !== 'new');
  return (
    <section className="fieldwork-list" aria-labelledby="customer-requests-heading">
      <h2 id="customer-requests-heading">Customer call-out requests</h2>
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
      <EntryList
        label="Customer call-out requests waiting for review"
        items={waiting}
        getKey={r => r.id}
        title={r => `${r.reference} · ${r.clientName}`}
        details={r => [
          ['Sent', isoDateTime(r.createdAt)],
          ['Client', r.clientName],
          ['Contract', [r.contractName, r.contractNumber].filter(Boolean).join(' · ')],
          ['Device', r.deviceName],
          ['Serial number', r.serialNumber],
          ['Problem', r.description],
          ['Priority', r.priority === 'urgent' ? 'Urgent' : 'Normal'],
          ['Location', r.location],
          ['Contact', [r.contactName, r.contactPhone].filter(Boolean).join(' · ')],
          ['Sent by', r.requestedByName || r.requestedByEmail]
        ]}
        disabled={busy}
        empty="No customer requests are waiting for review."
        badge={r => (
          <span className="callout-bubble">{r.priority === 'urgent' ? 'Urgent' : 'New'}</span>
        )}
        line={r => [
          r.reference,
          isoDateTime(r.createdAt),
          r.clientName,
          [r.deviceName, r.serialNumber].filter(Boolean).join(' '),
          r.description,
          r.location,
          [r.contactName, r.contactPhone].filter(Boolean).join(' '),
          [r.contractName, r.contractNumber].filter(Boolean).join(' '),
          `Sent by ${r.requestedByName || r.requestedByEmail || 'a customer'}`
        ]}
        actions={r => (
          <>
            <select
              aria-label={`Engineer for ${r.reference}`}
              value={engineerFor[r.id] || ''}
              onChange={e => setEngineerFor({ ...engineerFor, [r.id]: e.target.value })}
            >
              <option value="">Choose engineer</option>
              {engineers.map(engineer => (
                <option key={engineer.id} value={engineer.id}>
                  {engineer.name}
                </option>
              ))}
            </select>
            <button disabled={busy || !engineerFor[r.id]} onClick={() => void decide(r, 'accept')}>
              Accept
            </button>
            <button disabled={busy} onClick={() => void decide(r, 'decline')}>
              Decline
            </button>
          </>
        )}
      />
      {decided.length > 0 && (
        <details>
          <summary>Handled in the last 30 days ({decided.length})</summary>
          <EntryList
            label="Customer call-out requests handled in the last 30 days"
            items={decided}
            getKey={r => r.id}
            title={r => `${r.reference} · ${r.clientName}`}
            details={r => [
              ['Decision', r.status === 'accepted' ? 'Accepted' : 'Declined'],
              ['Reason', r.status === 'declined' ? r.declineReason : ''],
              ['Decided by', r.decidedByName],
              ['Decided', r.decidedAt ? isoDateTime(r.decidedAt) : ''],
              ['Sent', isoDateTime(r.createdAt)],
              ['Client', r.clientName],
              ['Device', [r.deviceName, r.serialNumber].filter(Boolean).join(' · ')],
              ['Problem', r.description],
              ['Contact', [r.contactName, r.contactPhone].filter(Boolean).join(' · ')]
            ]}
            badge={r => <span className="entry-badge">{r.status}</span>}
            line={r => [
              r.reference,
              r.decidedAt && isoDateTime(r.decidedAt),
              r.clientName,
              r.description,
              r.status === 'declined' && `Reason: ${r.declineReason}`,
              `By ${r.decidedByName || 'staff'}`
            ]}
          />
        </details>
      )}
    </section>
  );
}
