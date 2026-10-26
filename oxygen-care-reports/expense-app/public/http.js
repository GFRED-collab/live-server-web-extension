(() => {
  'use strict';

  const csrfToken = () =>
    document.cookie
      .split(';')
      .map(value => value.trim())
      .find(value => value.startsWith('oc_csrf='))
      ?.slice(8) || '';

  // Dates are shown as YYYY-MM-DD (ISO 8601) everywhere; date-times add HH:MM in Irish time.
  const irishParts = value =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Dublin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      })
        .formatToParts(new Date(value))
        .map(part => [part.type, part.value])
    );
  window.isoDate = value => {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (Number.isNaN(new Date(value).getTime())) return String(value);
    const part = irishParts(value);
    return `${part.year}-${part.month}-${part.day}`;
  };
  window.isoDateTime = value => {
    if (!value || Number.isNaN(new Date(value).getTime())) return value ? String(value) : '';
    const part = irishParts(value);
    return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
  };

  window.oxygenApi = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    };
    const csrf = csrfToken();
    if (!['GET', 'HEAD'].includes(method) && csrf) headers['x-csrf-token'] = csrf;
    let response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch {
      throw Error('Cannot reach the app server. Check that the Oxygen Care service is running.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = Error(data.error || 'Request failed.');
      error.status = response.status;
      error.code = data.code || '';
      error.restart = data.restart === true;
      throw error;
    }
    return data;
  };
})();
