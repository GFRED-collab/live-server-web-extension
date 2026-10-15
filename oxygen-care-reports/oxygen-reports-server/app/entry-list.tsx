'use client';
import { ReactNode, useEffect, useRef, useState } from 'react';
import './entry-list.css';

export const entryPageSize = 20;

type ServerPaging = { page: number; hasMore: boolean; onPage: (page: number) => void };
export type EntryDetail = [label: string, value: ReactNode];

/**
 * Saved entries as single compact lines, 20 to a page. Clicking a line (or pressing Enter on
 * it) opens a window with the entry's full details and actions, unless `onOpen` handles it.
 * Pass `paging` when the server pages the data; otherwise the list pages the items it is given.
 */
export function EntryList<T>({
  items,
  getKey,
  line,
  title,
  details,
  badge,
  actions,
  onOpen,
  empty = 'No entries yet.',
  label,
  paging,
  disabled
}: {
  items: T[];
  getKey: (item: T) => string;
  line: (item: T) => Array<string | null | undefined | false>;
  title?: (item: T) => string;
  details?: (item: T) => EntryDetail[];
  badge?: (item: T) => ReactNode;
  actions?: (item: T) => ReactNode;
  onOpen?: (item: T) => void;
  empty?: string;
  label: string;
  paging?: ServerPaging;
  disabled?: boolean;
}) {
  const [page, setPage] = useState(0),
    [openKey, setOpenKey] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const pageCount = Math.max(1, Math.ceil(items.length / entryPageSize));
  // Keep the page in range when filters or new data shrink the list.
  useEffect(() => {
    if (!paging && page > pageCount - 1) setPage(pageCount - 1);
  }, [paging, page, pageCount]);
  // The entry is looked up by key so the window shows fresh data after a refresh, and closes
  // itself if the entry disappears (for example once it has been accepted or deleted).
  const opened = openKey ? items.find(item => getKey(item) === openKey) : undefined;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (opened && !element.open) element.showModal();
    if (!opened && element.open) element.close();
  }, [opened]);
  const current = paging ? paging.page : Math.min(page, pageCount - 1),
    shown = paging ? items : items.slice(current * entryPageSize, (current + 1) * entryPageSize),
    first = current * entryPageSize + 1,
    last = current * entryPageSize + shown.length;
  const go = (next: number) => {
    setOpenKey('');
    if (paging) paging.onPage(next);
    else setPage(next);
  };
  const open = (item: T) => (onOpen ? onOpen(item) : setOpenKey(getKey(item)));
  const text = (item: T) => line(item).filter(Boolean).join(' · ');
  const pager = (
    <nav className="entry-pages" aria-label={`${label} pages`}>
      <button type="button" disabled={disabled || current === 0} onClick={() => go(current - 1)}>
        Previous
      </button>
      {shown.length > 0 && (
        <span>
          {first}–{last}
          {paging ? '' : ` of ${items.length}`}
        </span>
      )}
      {shown.length > 0 && (
        <button
          type="button"
          disabled={disabled || (paging ? !paging.hasMore : current >= pageCount - 1)}
          onClick={() => go(current + 1)}
        >
          Next
        </button>
      )}
    </nav>
  );
  // A server page can come back empty (e.g. after deleting its last entry); keep a way back.
  if (!items.length)
    return paging && paging.page > 0 ? (
      <div className="entry-list">
        <p className="entry-empty">{empty}</p>
        {pager}
      </div>
    ) : (
      <p className="entry-empty">{empty}</p>
    );
  return (
    <div className="entry-list">
      <ol aria-label={label}>
        {shown.map(item => (
          <li key={getKey(item)}>
            <span
              className="entry-text"
              role="button"
              tabIndex={0}
              aria-haspopup={onOpen ? undefined : 'dialog'}
              title={text(item)}
              onClick={() => open(item)}
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                open(item);
              }}
            >
              {badge?.(item)}
              {text(item)}
            </span>
            {actions && <span className="entry-actions">{actions(item)}</span>}
          </li>
        ))}
      </ol>
      {(paging ? paging.page > 0 || paging.hasMore : pageCount > 1) && pager}
      {!onOpen && (
        <dialog
          ref={dialog}
          className="entry-dialog"
          aria-labelledby={`${label}-entry-title`}
          onClose={() => setOpenKey('')}
          onClick={event => {
            // A click on the dimmed backdrop (outside the window's box) closes it.
            const box = event.currentTarget.getBoundingClientRect();
            if (
              event.target === event.currentTarget &&
              (event.clientX < box.left ||
                event.clientX > box.right ||
                event.clientY < box.top ||
                event.clientY > box.bottom)
            )
              event.currentTarget.close();
          }}
        >
          {opened && (
            <>
              <header>
                <h2 id={`${label}-entry-title`}>
                  {badge?.(opened)}
                  {title ? title(opened) : line(opened).filter(Boolean)[0]}
                </h2>
                <button type="button" onClick={() => setOpenKey('')} autoFocus>
                  Close
                </button>
              </header>
              <dl>
                {(details
                  ? details(opened)
                  : line(opened)
                      .filter(Boolean)
                      .map((value, index): EntryDetail => [`Detail ${index + 1}`, value])
                )
                  .filter(([, value]) => value !== '' && value !== null && value !== undefined)
                  .map(([name, value]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
              </dl>
              {actions && (
                <div
                  className="entry-dialog-actions"
                  // Buttons may open their own screen (e.g. an editor); close this window after.
                  onClick={event => {
                    if ((event.target as HTMLElement).closest('button')) setOpenKey('');
                  }}
                >
                  {actions(opened)}
                </div>
              )}
            </>
          )}
        </dialog>
      )}
    </div>
  );
}
