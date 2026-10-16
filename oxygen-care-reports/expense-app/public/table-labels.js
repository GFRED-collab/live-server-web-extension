// On phones, mobile.css shows each report table row as a card. Each cell needs its column name
// to read well there, so copy the header text onto every cell as data-label, including cells
// drawn later when filters change.
(() => {
  'use strict';
  function label(table) {
    const names = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    for (const row of table.querySelectorAll('tbody tr'))
      [...row.cells].forEach((cell, index) => {
        if (!cell.hasAttribute('colspan') && names[index]) cell.dataset.label = names[index];
      });
  }
  for (const table of document.querySelectorAll('table.stack-table')) {
    label(table);
    const body = table.tBodies[0];
    if (body) new MutationObserver(() => label(table)).observe(body, { childList: true });
  }
})();
