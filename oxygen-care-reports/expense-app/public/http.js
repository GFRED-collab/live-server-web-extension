(() => {
  'use strict';

  const csrfToken = () =>
    document.cookie
      .split(';')
      .map(value => value.trim())
      .find(value => value.startsWith('oc_csrf='))
      ?.slice(8) || '';

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
      throw error;
    }
    return data;
  };
})();
