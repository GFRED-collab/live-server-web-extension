(() => {
  'use strict';
  const config = window.reviewConfig;
  if (!config) throw new Error('Expense review configuration is missing.');

  const query = new URLSearchParams(location.search);
  const userId = query.get('userId');
  const $ = selector => document.querySelector(selector);
  const money = (value, currency = 'EUR') =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(
      Number(value) || 0
    );
  const statusText = status =>
    ({ approved: 'Approved', declined: 'Declined', question: 'Questioned', pending: 'Pending' })[
      status
    ] || status;
  const opensOn = expense =>
    new Date(`${expense.approvalOpensOn}T12:00:00`).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  let records = [];
  const api = window.oxygenApi;

  function messageFor(status) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      const box = document.createElement('section');
      const heading = document.createElement('h2');
      const help = document.createElement('p');
      const input = document.createElement('textarea');
      const actions = document.createElement('div');
      const cancel = document.createElement('button');
      const send = document.createElement('button');
      overlay.className = 'modal';
      box.className = 'modal-box';
      heading.textContent =
        status === 'declined' ? 'Decline expense' : `Question for ${config.subjectLabel}`;
      help.className = 'meta';
      help.textContent = `Add a clear message. It will be visible to the ${config.subjectLabel}.`;
      input.maxLength = 300;
      actions.className = config.actionsClass || 'actions';
      cancel.textContent = 'Cancel';
      send.textContent = 'Send';
      cancel.onclick = () => {
        overlay.remove();
        resolve(null);
      };
      send.onclick = () => {
        const note = input.value.trim();
        if (!note) return input.focus();
        overlay.remove();
        resolve(note);
      };
      actions.append(cancel, send);
      box.append(heading, help, input, actions);
      overlay.append(box);
      document.body.append(overlay);
      input.focus();
    });
  }

  async function review(expense, status) {
    const note = status === 'approved' ? '' : await messageFor(status);
    if (note === null) return;
    try {
      await api(`/api/expenses/${expense.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note })
      });
      await load();
    } catch (error) {
      alert(error.message);
    }
  }

  function expenseRow(expense) {
    const row = document.createElement('div');
    const title = document.createElement(config.titleTag || 'div');
    const meta = document.createElement('div');
    const note = document.createElement('div');
    const actions = document.createElement('div');
    row.className = 'expense';
    row.tabIndex = 0;
    row.dataset.expenseId = expense.id;
    if (config.titleClass) title.className = config.titleClass;
    title.textContent = `${expense.date} · ${expense.merchant} · ${money(expense.amount, expense.currency)}`;
    meta.className = 'meta';
    meta.textContent = [
      `Category: ${expense.category}`,
      expense.kilometres
        ? `Mileage: ${expense.kilometres} KM × ${money(expense.mileageRate || 0, expense.currency)} per KM`
        : null,
      `Status: ${statusText(expense.reviewStatus || 'pending')}`
    ]
      .filter(Boolean)
      .join(' · ');
    note.className = 'meta';
    note.textContent = `Note: ${expense.note || 'None'}`;
    actions.className = 'actions';
    // Approved expenses are locked: no further review.
    const reviewable = (expense.reviewStatus || 'pending') !== 'approved';
    // Department Heads can approve once the expense's month has ended.
    const approvalWaits = config.role === 'department_head' && expense.approvalOpen === false;
    for (const [label, next] of reviewable
      ? [
          ['Approve', 'approved'],
          ['Decline', 'declined'],
          ['Question', 'question']
        ]
      : []) {
      const button = document.createElement('button');
      button.textContent = label;
      if (next === 'declined') button.className = 'decline';
      if (next === 'approved' && approvalWaits) {
        button.disabled = true;
        button.textContent = `Approve from ${opensOn(expense)}`;
        button.title = 'Expenses can be approved once their month has ended.';
      } else button.onclick = () => review(expense, next);
      actions.append(button);
    }
    if (!reviewable) {
      const locked = document.createElement('span');
      locked.className = 'meta';
      locked.textContent = 'Approved · locked';
      actions.append(locked);
    }
    if (config.allowDelete) {
      const remove = document.createElement('button');
      remove.textContent = 'Delete expense';
      remove.className = 'delete';
      remove.onclick = async () => {
        if (!confirm(`Delete ${expense.merchant}? This cannot be undone.`)) return;
        try {
          await api(`/api/expenses/${expense.id}`, { method: 'DELETE' });
          await load();
        } catch (error) {
          alert(error.message);
        }
      };
      actions.append(remove);
    }
    row.append(title, meta, note, actions);
    if (expense.hasReceipt) {
      const receipt = document.createElement('a'),
        returnTo = `${location.pathname}${location.search}`;
      receipt.className = 'receipt';
      receipt.href = `/api/expenses/${expense.id}/receipt/view?returnTo=${encodeURIComponent(returnTo)}`;
      receipt.textContent = 'View receipt';
      row.append(receipt);
    }
    if (expense.reviewNote) {
      const flag = document.createElement('div');
      flag.className = config.flagClass || 'meta';
      flag.textContent = `Message to ${config.subjectLabel}: ${expense.reviewNote}`;
      row.append(flag);
    }
    return row;
  }

  function calendarSummary(expenses) {
    return `${expenses.length} expense${expenses.length === 1 ? '' : 's'} · Expenses: ${money(expenses.filter(expense => !expense.companyPaid).reduce((sum, expense) => sum + Number(expense.amount || 0), 0))} · Company paid: ${money(expenses.filter(expense => expense.companyPaid).reduce((sum, expense) => sum + Number(expense.amount || 0), 0))}`;
  }

  function draw() {
    const from = $('#from').value,
      to = $('#to').value,
      status = $('#status').value;
    const visible = records.filter(
      expense =>
        (!from || expense.date >= from) &&
        (!to || expense.date <= to) &&
        (status === 'all' || (expense.reviewStatus || 'pending') === status)
    );
    $('#count').textContent = `${visible.length} expense${visible.length === 1 ? '' : 's'} shown`;
    const root = $('#content');
    const result = window.OxygenExpenseCalendar.render({
      root,
      records: visible,
      summary: calendarSummary,
      redraw: draw
    });
    if (result.level === 'expenses') root.append(...result.records.map(expenseRow));
  }

  async function load() {
    try {
      const me = await api('/api/auth/me');
      if (me.user.role !== config.role) throw Error(config.accessError);
      if (!userId) throw Error('No user selected.');
      const people = await api('/api/users');
      const user = people.users.find(person => person.id === userId);
      if (!user) throw Error(config.userError);
      records = (await api(`/api/expenses?userId=${encodeURIComponent(userId)}`)).expenses;
      const title =
        config.titleElement === 'subtitle'
          ? `${user.fullName || user.email} · ${records.length} expense${records.length === 1 ? '' : 's'}`
          : `Review · ${user.fullName || user.email}`;
      $(`#${config.titleElement}`).textContent = title;
      draw();
    } catch (error) {
      const root = $('#content');
      root.classList.add('error');
      root.textContent = error.message;
    }
  }

  function back() {
    const requested = query.get('returnTo');
    const allowed = new Set(['home', 'users', 'profile']);
    const returnTo = allowed.has(requested) ? requested : 'home';
    const target = returnTo === 'home' ? '/' : `/?view=${encodeURIComponent(returnTo)}`;
    location.replace(target);
  }

  function openDetails(event) {
    const row = event.target.closest('[data-expense-id]');
    if (!row || event.target.closest('button,a')) return;
    const details = new URLSearchParams({
      userId,
      expenseId: row.dataset.expenseId,
      review: config.review,
      returnTo: query.get('returnTo') || 'home',
      reviewReturn: `${location.pathname}${location.search}`
    });
    location.href = `/expense-detail.html?${details}`;
  }

  const fromInput = $('#from'),
    toInput = $('#to'),
    statusInput = $('#status');
  fromInput.value = query.get('filterFrom') || '';
  toInput.value = query.get('filterTo') || '';
  if ([...statusInput.options].some(option => option.value === query.get('filterStatus')))
    statusInput.value = query.get('filterStatus');
  for (const input of [fromInput, toInput, statusInput])
    input.onchange = () =>
      window.OxygenExpenseCalendar.reset(draw, {
        filterFrom: fromInput.value,
        filterTo: toInput.value,
        filterStatus: statusInput.value
      });
  addEventListener('popstate', draw);
  $('#back').addEventListener('click', event => {
    event.preventDefault();
    back();
  });
  $('#content').addEventListener('click', openDetails);
  $('#content').addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button,a')) {
      event.preventDefault();
      openDetails(event);
    }
  });
  load();
})();
