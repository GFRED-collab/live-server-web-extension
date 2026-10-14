(() => {
  'use strict';
  // Export user-entered formula-like values as text, not spreadsheet formulas.
  window.oxygenCsvCell = value => {
    let text = String(value ?? '');
    if (typeof value === 'string' && (/^[\s\uFEFF]*[=+\-@＝＋－＠]/u.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
})();
