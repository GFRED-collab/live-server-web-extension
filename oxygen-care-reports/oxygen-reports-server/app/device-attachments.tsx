'use client';
import { useEffect, useRef, useState } from 'react';
type Attachment = { id: string; filename: string; size: number };
export default function DeviceAttachments({
  visitId,
  deviceId,
  readOnly = false,
  history = false
}: {
  visitId: string;
  deviceId: string;
  readOnly?: boolean;
  history?: boolean;
}) {
  const [expanded, setExpanded] = useState(!history),
    [files, setFiles] = useState<Attachment[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null),
    locked = useRef(false);
  const endpoint = '/api/service-visits/' + encodeURIComponent(visitId) + '/attachments',
    url = endpoint + '?deviceId=' + encodeURIComponent(deviceId);
  async function load(signal?: AbortSignal) {
    const response = await fetch(url, { signal, cache: 'no-store' }),
      body = await response.json();
    if (!response.ok) throw Error(body.error || 'Could not load attachments.');
    setFiles(body.attachments);
  }
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    void load(controller.signal).catch(e => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [expanded, url]);
  async function mutate(file?: File, fileId?: string) {
    if (readOnly || locked.current) return;
    if (
      fileId &&
      !window.confirm(
        'Remove this attachment from the visit? The original remains retained for audit purposes.'
      )
    )
      return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let content: string | undefined;
      if (file) {
        if (!file.size || file.size > 5 * 1024 * 1024)
          throw Error('Choose a non-empty photo or PDF up to 5 MB.');
        content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(Error('Could not read the file.'));
          reader.readAsDataURL(file);
        });
      }
      const response = await fetch(endpoint, {
          method: fileId ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, fileId, filename: file?.name, content })
        }),
        body = await response.json();
      if (!response.ok) throw Error(body.error || 'Could not save attachment.');
      await load();
      setNotice(fileId ? 'Attachment removed.' : 'Attachment uploaded.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save attachment.');
    } finally {
      locked.current = false;
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <section
      className="device-attachments no-print"
      aria-label="Device photos and documents"
      style={{ marginTop: 8 }}
    >
      {history && (
        <button type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Hide attachments' : 'Show attachments'}
        </button>
      )}
      {expanded && (
        <>
          {!readOnly && (
            <>
              <button type="button" disabled={busy} onClick={() => input.current?.click()}>
                Upload file/photo
              </button>
              <input
                ref={input}
                type="file"
                hidden
                aria-label="Upload file/photo"
                accept=".jpg,.jpeg,.png,.webp,.pdf"
                disabled={busy}
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) void mutate(file);
                }}
              />
            </>
          )}
          {error && <p role="alert">{error}</p>}
          {(busy || notice) && <p role="status">{busy ? 'Saving attachment…' : notice}</p>}
          {!!files.length && (
            <ul>
              {files.map(file => (
                <li key={file.id}>
                  <a
                    href={url + '&file=' + encodeURIComponent(file.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {file.filename}
                  </a>{' '}
                  {!readOnly && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void mutate(undefined, file.id)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
