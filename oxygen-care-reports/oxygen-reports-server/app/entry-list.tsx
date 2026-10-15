'use client';
import { ReactNode, useEffect, useState } from 'react';
import './entry-list.css';

export const entryPageSize = 20;

type ServerPaging = { page: number; hasMore: boolean; onPage: (page: number) => void };

/**
 * Saved entries as single compact lines, 20 to a page. Long lines are cut short; clicking a
 * line (or pressing Enter on it) shows it in full. Pass `paging` when the server pages the
 * data; otherwise the list pages the items it is given.
 */
export function EntryList<T>({
  items,
  getKey,
  line,
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
  badge?: (item: T) => ReactNode;
  actions?: (item: T) => ReactNode;
  onOpen?: (item: T) => void;
  empty?: string;
  label: string;
  paging?: ServerPaging;
  disabled?: boolean;
}) {
  const [page, setPage] = useState(0),
    [expanded, setExpanded] = useState('');
  const pageCount = Math.max(1, Math.ceil(items.length / entryPageSize));
  // Keep the page in range when filters or new data shrink the list.
  useEffect(() => {
    if (!paging && page > pageCount - 1) setPage(pageCount - 1);
  }, [paging, page, pageCount]);
  const current = paging ? paging.page : Math.min(page, pageCount - 1),
    shown = paging ? items : items.slice(current * entryPageSize, (current + 1) * entryPageSize),
    first = current * entryPageSize + 1,
    last = current * entryPageSize + shown.length;
  const go = (next: number) => {
    setExpanded('');
    if (paging) paging.onPage(next);
    else setPage(next);
  };
  // A server page can come back empty (e.g. after deleting its last entry); keep a way back.
  if (!items.length)
    return paging && paging.page > 0 ? (
      <div className="entry-list">
        <p className="entry-empty">{empty}</p>
        <nav className="entry-pages" aria-label={`${label} pages`}>
          <button type="button" disabled={disabled} onClick={() => go(paging.page - 1)}>
            Previous
          </button>
        </nav>
      </div>
    ) : (
      <p className="entry-empty">{empty}</p>
    );
  return (
    <div className="entry-list">
      <ol aria-label={label}>
        {shown.map(item => {
          const key = getKey(item),
            text = line(item).filter(Boolean).join(' · '),
            open = expanded === key;
          return (
            <li key={key} className={open ? 'expanded' : undefined}>
              <span
                className="entry-text"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                title={open ? undefined : text}
                onClick={() => (onOpen ? onOpen(item) : setExpanded(open ? '' : key))}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  if (onOpen) onOpen(item);
                  else setExpanded(open ? '' : key);
                }}
              >
                {badge?.(item)}
                {text}
              </span>
              {actions && <span className="entry-actions">{actions(item)}</span>}
            </li>
          );
        })}
      </ol>
      {(paging ? paging.page > 0 || paging.hasMore : pageCount > 1) && (
        <nav className="entry-pages" aria-label={`${label} pages`}>
          <button
            type="button"
            disabled={disabled || current === 0}
            onClick={() => go(current - 1)}
          >
            Previous
          </button>
          <span>
            {first}–{last}
            {paging ? '' : ` of ${items.length}`}
          </span>
          <button
            type="button"
            disabled={disabled || (paging ? !paging.hasMore : current >= pageCount - 1)}
            onClick={() => go(current + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
