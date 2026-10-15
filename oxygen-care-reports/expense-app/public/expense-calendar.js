(() => {
  'use strict';

  const keys = ['year', 'month', 'day'];
  const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };

  function change(values, redraw) {
    const url = new URL(location.href);
    for (const key of keys) {
      if (!Object.hasOwn(values, key)) continue;
      if (values[key]) url.searchParams.set(key, values[key]);
      else url.searchParams.delete(key);
    }
    history.pushState({ calendar: true }, '', `${url.pathname}${url.search}`);
    redraw();
  }

  function parentLevel(redraw) {
    const url = new URL(location.href);
    if (url.searchParams.has('day')) url.searchParams.delete('day');
    else if (url.searchParams.has('month')) {
      url.searchParams.delete('month');
      url.searchParams.delete('day');
    } else {
      url.searchParams.delete('year');
      url.searchParams.delete('month');
      url.searchParams.delete('day');
    }
    history.replaceState({ calendar: true }, '', `${url.pathname}${url.search}`);
    redraw();
  }

  function heading(root, title, subtitle, showBack, redraw) {
    const bar = node('div', 'stack-heading');
    if (showBack) {
      const back = node('button', 'stack-back', '‹ Back');
      back.type = 'button';
      back.onclick = () => parentLevel(redraw);
      bar.append(back);
    }
    const copy = node('div', 'grow');
    copy.append(node('div', 'label', title));
    if (subtitle) copy.append(node('div', 'meta', subtitle));
    bar.append(copy);
    root.append(bar);
  }

  function render({
    root,
    records,
    summary,
    redraw,
    emptyText = 'No expenses match this filter.'
  }) {
    root.className = 'expense-stack';
    root.replaceChildren();
    if (!records.length) {
      root.append(node('p', 'meta', emptyText));
      return { level: 'empty', records: [] };
    }
    const query = new URLSearchParams(location.search);
    const year = query.get('year'),
      month = query.get('month'),
      day = query.get('day');
    const tile = (title, entries, values) => {
      const button = node('button', 'calendar-cell');
      button.type = 'button';
      button.append(node('span', '', title), node('span', 'calendar-cell-total', summary(entries)));
      button.onclick = () => change(values, redraw);
      return button;
    };
    if (!year) {
      heading(root, 'CHOOSE A YEAR', '', false, redraw);
      const groups = records.reduce((all, expense) => {
        const key = /^\d{4}/.exec(expense.date || '')?.[0] || 'Undated';
        (all[key] ||= []).push(expense);
        return all;
      }, {});
      const grid = node('div', 'calendar-grid year-grid');
      for (const [value, entries] of Object.entries(groups).sort(([a], [b]) => b.localeCompare(a)))
        grid.append(tile(value, entries, { year: value, month: '', day: '' }));
      root.append(grid);
      return { level: 'year', records };
    }
    const yearRecords = records.filter(expense =>
      year === 'Undated'
        ? !/^\d{4}/.test(expense.date || '')
        : String(expense.date || '').startsWith(year)
    );
    if (!month) {
      heading(root, year, '', true, redraw);
      const groups = yearRecords.reduce((all, expense) => {
        const key = /^\d{4}-(\d{2})/.exec(expense.date || '')?.[1] || '00';
        (all[key] ||= []).push(expense);
        return all;
      }, {});
      const grid = node('div', 'calendar-grid month-grid');
      for (const [value, entries] of Object.entries(groups).sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        const label =
          value === '00'
            ? 'Undated'
            : new Date(`2000-${value}-01T12:00:00`).toLocaleDateString(undefined, {
                month: 'long'
              });
        grid.append(tile(label, entries, { month: value, day: '' }));
      }
      root.append(grid);
      return { level: 'month', records: yearRecords };
    }
    const monthRecords = yearRecords.filter(
      expense => String(expense.date || '').slice(5, 7) === month
    );
    const monthName =
      month === '00'
        ? 'Undated'
        : new Date(`${year}-${month}-01T12:00:00`).toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric'
          });
    if (!day) {
      heading(root, monthName, '', true, redraw);
      const groups = monthRecords.reduce((all, expense) => {
        const key = /^\d{4}-\d{2}-(\d{2})/.exec(expense.date || '')?.[1] || '00';
        (all[key] ||= []).push(expense);
        return all;
      }, {});
      const grid = node('div', 'calendar-grid day-grid');
      for (const [value, entries] of Object.entries(groups).sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        const label =
          value === '00'
            ? 'Undated'
            : new Date(`${year}-${month}-${value}T12:00:00`).toLocaleDateString(undefined, {
                weekday: 'short',
                day: 'numeric'
              });
        grid.append(tile(label, entries, { day: value }));
      }
      root.append(grid);
      return { level: 'day-picker', records: monthRecords };
    }
    const dayRecords = monthRecords
      .filter(expense => String(expense.date || '').slice(8, 10) === day)
      .sort((a, b) =>
        String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || ''))
      );
    const dayName =
      day === '00'
        ? monthName
        : new Date(`${year}-${month}-${day}T12:00:00`).toLocaleDateString(undefined, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
          });
    heading(root, dayName, summary(dayRecords), true, redraw);
    return { level: 'expenses', records: dayRecords };
  }

  function reset(redraw, filters = {}) {
    const url = new URL(location.href);
    keys.forEach(key => url.searchParams.delete(key));
    for (const [key, value] of Object.entries(filters))
      value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    history.replaceState(history.state, '', `${url.pathname}${url.search}`);
    redraw();
  }

  window.OxygenExpenseCalendar = { render, reset };
})();
