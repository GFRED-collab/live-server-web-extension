'use client';
import { FormEvent, useEffect, useState } from 'react';
import './customer-portal.css';
type Account = {
  id: string;
  name: string;
  email: string;
  clientId: string;
  clientName: string;
  active: boolean;
  canExport: boolean;
};
export default function CustomerAccounts({
  clients
}: {
  clients: Array<{ id: string; name: string }>;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]),
    [id, setId] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const selected = accounts.find(a => a.id === id);
  async function load() {
    const response = await fetch('/api/customer-accounts', { cache: 'no-store' }),
      body = await response.json();
    if (!response.ok) throw Error(body.error || 'Could not load customer accounts.');
    setAccounts(body.accounts);
  }
  useEffect(() => {
    void load().catch(e => setError(e.message));
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget,
      values = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/customer-accounts', {
          method: id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            name: values.get('name'),
            email: values.get('email'),
            clientId: values.get('clientId'),
            password: values.get('password'),
            active: values.has('active'),
            canExport: values.has('canExport')
          })
        }),
        body = await response.json();
      if (!response.ok) throw Error(body.error || 'Could not save customer account.');
      await load();
      setId('');
      form.reset();
      setNotice('Customer account saved. Existing sessions were revoked for edited accounts.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save customer account.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="customer-accounts">
      <h2>Customer logins</h2>
      <div className="customer-account-actions">
        <label>
          Customer account
          <select
            aria-label="Customer account"
            disabled={busy}
            value={id}
            onChange={e => {
              setId(e.target.value);
              setNotice('');
              setError('');
            }}
          >
            <option value="">Create customer login</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.clientName} · {a.name}
                {a.active ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <form key={id || 'new'} onSubmit={save}>
        <label>
          Name
          <input name="name" required maxLength={120} defaultValue={selected?.name} />
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            defaultValue={selected?.email}
          />
        </label>
        <label>
          Linked client
          <select
            aria-label="Linked client"
            name="clientId"
            required
            defaultValue={selected?.clientId || ''}
          >
            <option value="" disabled>
              Select client
            </option>
            {clients.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {id ? 'New password (leave blank to keep current)' : 'Password'}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required={!id}
          />
        </label>
        <label>
          <span>
            <input type="checkbox" name="active" defaultChecked={selected?.active ?? true} /> Active
          </span>
        </label>
        <label>
          <span>
            <input type="checkbox" name="canExport" defaultChecked={selected?.canExport ?? true} />{' '}
            Allow print/export
          </span>
        </label>
        <button disabled={busy} type="submit">
          {busy ? 'Saving…' : id ? 'Save customer login' : 'Create customer login'}
        </button>
      </form>
    </section>
  );
}
