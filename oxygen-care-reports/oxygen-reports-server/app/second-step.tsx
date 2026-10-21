'use client';
import { FormEvent, useState } from 'react';
import './second-step.css';

export type SecondStepInfo =
  | { step: 'totp' }
  | { step: 'totp_setup'; key: string; otpauthUrl: string; qrSvg: string }
  | { step: 'email'; sentTo: string };

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(data.error || 'The request could not be completed.'), {
      restart: data.restart === true
    });
  return data as T;
}

/**
 * The step after the password: an authenticator code for staff (set up on first use, with
 * recovery codes), or an emailed code for customers.
 */
export function SecondStep({
  info,
  onDone,
  onRestart
}: {
  info: SecondStepInfo;
  onDone: () => void;
  onRestart: (message: string) => void;
}) {
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null),
    [saved, setSaved] = useState(false);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      code = String(new FormData(form).get('code') || '').replace(/\s/g, '');
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await post<{ recoveryCodes?: string[]; recoveryCodesLeft?: number }>(
        '/api/auth/verify',
        { code }
      );
      if (result.recoveryCodes) return setRecoveryCodes(result.recoveryCodes);
      if (result.recoveryCodesLeft !== undefined && result.recoveryCodesLeft <= 3)
        window.alert(
          `You have ${result.recoveryCodesLeft} recovery code${result.recoveryCodesLeft === 1 ? '' : 's'} left. Ask a Super User to reset your authenticator to get new ones.`
        );
      onDone();
    } catch (reason) {
      const failure = reason as Error & { restart?: boolean };
      if (failure.restart) return onRestart(failure.message);
      setError(failure.message);
      form.reset();
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await post<{ sentTo: string }>('/api/auth/resend');
      setNotice(`A new code is on its way to ${result.sentTo}.`);
    } catch (reason) {
      const failure = reason as Error & { restart?: boolean };
      if (failure.restart) return onRestart(failure.message);
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes)
    return (
      <div className="second-step" aria-label="Recovery codes">
        <h2>Save your recovery codes</h2>
        <p>
          If you lose your phone, each of these codes lets you sign in once instead of the
          authenticator code. Keep them somewhere safe, such as a password manager or a printed
          copy. They won&apos;t be shown again.
        </p>
        <ol className="recovery-codes">
          {recoveryCodes.map(code => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ol>
        <div className="second-step-actions">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(recoveryCodes.join('\n'))
                .then(() => setNotice('Copied.'));
            }}
          >
            Copy codes
          </button>
          <button
            type="button"
            onClick={() => {
              document.body.classList.add('printing-recovery');
              window.print();
              document.body.classList.remove('printing-recovery');
            }}
          >
            Print
          </button>
        </div>
        {notice && <p className="message success">{notice}</p>}
        <label className="saved-check">
          <input
            type="checkbox"
            checked={saved}
            onChange={event => setSaved(event.target.checked)}
          />
          I have saved these codes
        </label>
        <button className="primary" type="button" disabled={!saved} onClick={onDone}>
          Continue
        </button>
      </div>
    );

  return (
    <form className="second-step" onSubmit={verify} aria-label="Sign-in code">
      {info.step === 'totp_setup' && (
        <>
          <h2>Set up your authenticator</h2>
          <ol className="setup-steps">
            <li>
              Install an authenticator app on your phone if you don&apos;t have one (Google
              Authenticator, Microsoft Authenticator or 1Password).
            </li>
            <li>In the app, add an account and scan this code.</li>
          </ol>
          <img
            className="setup-qr"
            alt="QR code for your authenticator app"
            src={`data:image/svg+xml;utf8,${encodeURIComponent(info.qrSvg)}`}
          />
          <p className="setup-key">
            Can&apos;t scan? On this phone,{' '}
            <a href={info.otpauthUrl}>open it in your authenticator app</a>, or type this key:
            <code>{info.key}</code>
          </p>
          <p>Then enter the 6-digit code the app shows.</p>
        </>
      )}
      {info.step === 'totp' && (
        <>
          <h2>Enter your sign-in code</h2>
          <p>
            Open your authenticator app and enter the 6-digit code for Oxygen Care Reports. Lost
            your phone? Enter one of your recovery codes instead.
          </p>
        </>
      )}
      {info.step === 'email' && (
        <>
          <h2>Check your email</h2>
          <p>
            We sent a 6-digit code to <b>{info.sentTo}</b>. It expires in 10 minutes.
          </p>
        </>
      )}
      <label>
        {info.step === 'totp' ? 'CODE OR RECOVERY CODE' : 'CODE'}
        <input
          name="code"
          autoComplete="one-time-code"
          inputMode={info.step === 'totp' ? 'text' : 'numeric'}
          maxLength={info.step === 'totp' ? 12 : 6}
          pattern={info.step === 'totp' ? undefined : '[0-9]{6}'}
          autoFocus
          required
        />
      </label>
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
      <button className="primary" type="submit" disabled={busy}>
        {info.step === 'totp_setup' ? 'Turn on and sign in' : 'Verify and sign in'}
      </button>
      <div className="second-step-actions">
        {info.step === 'email' && (
          <button type="button" onClick={() => void resend()} disabled={busy}>
            Send a new code
          </button>
        )}
        <button type="button" onClick={() => onRestart('')}>
          Start again
        </button>
      </div>
    </form>
  );
}
