// Dates are shown as YYYY-MM-DD (ISO 8601) everywhere; date-times add HH:MM in Irish time.
function irishParts(value: Date) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Dublin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(value)
      .map(part => [part.type, part.value])
  );
}

function toDate(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** YYYY-MM-DD; a plain date string is returned as it is. */
export function isoDate(value: unknown) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = toDate(value);
  if (!date) return value ? String(value) : '';
  const part = irishParts(date);
  return `${part.year}-${part.month}-${part.day}`;
}

/** YYYY-MM-DD HH:MM in Irish time. */
export function isoDateTime(value: unknown) {
  const date = toDate(value);
  if (!date) return value ? String(value) : '';
  const part = irishParts(date);
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
}
