'use client';
import { FormEvent, useEffect, useState } from 'react';
import './appointment-responses.css';

export type AppointmentResponse = 'none' | 'pending' | 'accepted' | 'rejected';
type PendingAppointment = {
  id: string;
  appointmentDate: string;
  endDate?: string;
  startTime: string | null;
  title: string;
  clientName: string;
  location: string;
  notes: string;
  createdByName: string | null;
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

/** Tells the calendar badge and panels that appointment answers changed. */
export const appointmentsUpdated = () => window.dispatchEvent(new Event('appointments-updated'));

const labels: Record<AppointmentResponse, string> = {
  none: '',
  pending: 'Awaiting reply',
  accepted: 'Accepted',
  rejected: 'Rejected'
};
export const responseLabel = (status?: AppointmentResponse) => labels[status || 'none'];

/** A small coloured label for an appointment's accept/reject state (nothing when not asked). */
export function ResponseBadge({ status }: { status?: AppointmentResponse }) {
  if (!status || status === 'none') return null;
  return <span className={`appointment-response ${status}`}>{labels[status]}</span>;
}

/**
 * Calendar menu entry. Engineers see how many appointments wait for their answer; Super Users
 * see how many upcoming appointments an engineer rejected.
 */
export function CalendarNav({
  active,
  onClick,
  superUser
}: {
  active: boolean;
  onClick: () => void;
  superUser: boolean;
}) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void api<{ count: number }>('/api/appointments?notifications=1')
        .then(data => alive && setCount(data.count))
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    window.addEventListener('appointments-updated', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('appointments-updated', refresh);
    };
  }, []);
  const what = superUser ? 'rejected appointments' : 'appointments waiting for your reply';
  return (
    <button className={active ? 'active' : ''} onClick={onClick}>
      <b>▣</b>Calendar
      {count > 0 && (
        <span className="callout-bubble" aria-label={`${count} ${what}`} title={`${count} ${what}`}>
          {count}
        </span>
      )}
    </button>
  );
}

const when = (item: PendingAppointment) =>
  item.appointmentDate +
  (item.endDate && item.endDate !== item.appointmentDate ? ' – ' + item.endDate : '') +
  ' · ' +
  (item.startTime || 'Any time');

/**
 * Appointments a Super User assigned to the signed-in engineer that still need an answer.
 * Rejecting needs a reason, which the Super User sees on the appointment.
 */
export function AppointmentInvitations({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<PendingAppointment[]>([]),
    [rejecting, setRejecting] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function load() {
    try {
      setItems(
        (await api<{ appointments: PendingAppointment[] }>('/api/appointments?pending=1'))
          .appointments
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load your appointments.');
    }
  }
  useEffect(() => {
    void load();
    window.addEventListener('appointments-updated', load);
    return () => window.removeEventListener('appointments-updated', load);
  }, []);
  async function answer(item: PendingAppointment, decision: 'accepted' | 'rejected', note = '') {
    setBusy(item.id);
    setError('');
    setNotice('');
    try {
      await api('/api/appointments/respond', {
        method: 'POST',
        body: JSON.stringify({ id: item.id, decision, note })
      });
      setRejecting('');
      setNotice(`“${item.title}” ${decision === 'accepted' ? 'accepted' : 'rejected'}.`);
      appointmentsUpdated();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send your answer.');
      void load();
    } finally {
      setBusy('');
    }
  }
  function reject(event: FormEvent<HTMLFormElement>, item: PendingAppointment) {
    event.preventDefault();
    const note = String(new FormData(event.currentTarget).get('note') || '').trim();
    if (!note) return setError('Enter the reason for rejecting it.');
    void answer(item, 'rejected', note);
  }
  if (!items.length && !error && !notice) return null;
  return (
    <section className="directory standalone-card appointment-invitations" aria-live="polite">
      <div className="directory-heading">
        <div>
          <p className="eyebrow">NEEDS YOUR REPLY</p>
          <h2>Appointments assigned to you</h2>
        </div>
        {items.length > 0 && <span className="callout-bubble">{items.length}</span>}
      </div>
      {(error || notice) && (
        <p className={error ? 'message error' : 'message success'} role="status">
          {error || notice}
        </p>
      )}
      {items.length === 0 && <p className="muted">No appointments are waiting for your reply.</p>}
      <ul>
        {items.map(item => (
          <li key={item.id}>
            <div className="invitation-summary">
              <strong>{item.title}</strong>
              <span>{when(item)}</span>
              {[item.clientName, item.location].filter(Boolean).length > 0 && (
                <span>{[item.clientName, item.location].filter(Boolean).join(' · ')}</span>
              )}
              {item.notes && <span className="invitation-notes">{item.notes}</span>}
              {item.createdByName && <small>Assigned by {item.createdByName}</small>}
            </div>
            {rejecting === item.id ? (
              <form className="invitation-reject" onSubmit={event => reject(event, item)}>
                <label>
                  REASON FOR REJECTING
                  <textarea name="note" rows={3} maxLength={1000} required autoFocus />
                </label>
                <div className="invitation-actions">
                  <button type="submit" className="danger" disabled={busy === item.id}>
                    Send rejection
                  </button>
                  <button type="button" onClick={() => setRejecting('')}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="invitation-actions">
                <button
                  type="button"
                  disabled={busy === item.id}
                  onClick={() => void answer(item, 'accepted')}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy === item.id}
                  onClick={() => {
                    setRejecting(item.id);
                    setError('');
                    setNotice('');
                  }}
                >
                  Reject
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
