(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const viewFromLocation = () => {
    const query = new URLSearchParams(location.search);
    const requested = query.get('view');
    return requested === 'expense' && query.get('expenseId')
      ? 'expense'
      : ['users', 'history', 'reimbursements', 'odometer', 'profile'].includes(requested)
        ? requested
        : 'home';
  };
  const initialQuery = new URLSearchParams(location.search);
  const state = {
    user: null,
    expenses: [],
    settings: null,
    idleTimeoutMs: 20 * 60 * 1000,
    view: viewFromLocation(),
    expenseId: initialQuery.get('expenseId') || '',
    returnTo: initialQuery.get('returnTo') || 'home'
  };
  const euro = value =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(
      Number(value) || 0
    );
  const isCompanyPaid = expense => expense.companyPaid === true;
  const expenseAmount = records =>
    records.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const dateToday = () => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Dublin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const part = type => parts.find(item => item.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const personName = user => user.fullName || user.email;
  const api = window.oxygenApi;
  function element(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children.filter(Boolean));
    return node;
  }
  function button(text, action, className = 'secondary') {
    return element('button', { type: 'button', class: className, text, onclick: action });
  }
  function card(...children) {
    return element('section', { class: 'card' }, ...children);
  }
  function notice(message, ok = false) {
    return element('p', { class: `notice${ok ? ' success' : ''}`, text: message });
  }
  function setContent(...children) {
    $('#content').replaceChildren(...children.filter(Boolean));
  }
  function go(view, options = {}) {
    const query = new URLSearchParams();
    if (view !== 'home') query.set('view', view);
    if (options.expenseId) query.set('expenseId', options.expenseId);
    if (options.returnTo && options.returnTo !== 'home') query.set('returnTo', options.returnTo);
    const nextUrl = `/${query.size ? `?${query}` : ''}`;
    if (options.replace || (state.view === view && state.expenseId === (options.expenseId || '')))
      history.replaceState({ view }, '', nextUrl);
    else history.pushState({ view }, '', nextUrl);
    state.view = view;
    state.expenseId = options.expenseId || '';
    state.returnTo = options.returnTo || 'home';
    render();
  }
  function resetWorkspaceRoute() {
    history.replaceState({ view: 'home' }, '', '/');
    state.view = 'home';
    state.expenseId = '';
    state.returnTo = 'home';
  }
  function openReview(path) {
    location.assign(new URL(path, location.origin).href);
  }
  function receiptViewUrl(id) {
    const url = new URL(`/api/expenses/${id}/receipt/view`, location.origin);
    url.searchParams.set('returnTo', `${location.pathname}${location.search}`);
    return url.href;
  }
  async function loadExpenses() {
    state.expenses = (await api('/api/expenses')).expenses;
  }
  async function loadSettings() {
    state.settings = await api('/api/settings');
  }
  function nav() {
    const workspace = $('#workspace');
    workspace.hidden = false;
    workspace.replaceChildren();
    if (state.user.role === 'super') {
      workspace.append(
        button('Dashboard', () => go('home')),
        button('Users', () => go('users')),
        element('a', { class: 'link-button', href: '/batch-approve.html', text: 'Batch' }),
        button('My profile', () => go('profile')),
        element('a', {
          class: 'link-button',
          href: `/reports.html?returnTo=${encodeURIComponent(state.view)}`,
          text: 'Reports'
        }),
        element('a', {
          class: 'link-button',
          href: `/settings.html?returnTo=${encodeURIComponent(state.view)}`,
          text: 'Settings'
        })
      );
    } else {
      workspace.append(
        button('Home', () => go('home')),
        button('History', () => go('history')),
        button('Odometer', () => go('odometer'))
      );
      if (state.user.role === 'department_head')
        workspace.append(
          element('a', { class: 'link-button', href: '/batch-approve.html', text: 'Batch' })
        );
      workspace.append(button('My profile', () => go('profile')));
    }
  }
  function calendarSummary(records) {
    const userPaid = records.filter(expense => !isCompanyPaid(expense));
    const fuelCard = records.filter(isCompanyPaid);
    return `${records.length} · Expenses ${euro(expenseAmount(userPaid))}${fuelCard.length ? ` · Company paid ${euro(expenseAmount(fuelCard))}` : ''}`;
  }
  function resetExpenseCalendar(redraw, filters = {}) {
    const url = new URL(location.href);
    for (const key of ['year', 'month', 'day']) url.searchParams.delete(key);
    for (const [key, value] of Object.entries(filters))
      value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    history.replaceState(history.state, '', `${url.pathname}${url.search}`);
    redraw();
  }
  function restoreFilter(input, key, fallback = '') {
    const value = new URLSearchParams(location.search).get(key);
    if (input.type === 'date') input.value = value || fallback;
    else if (value !== null && [...input.options].some(option => option.value === value))
      input.value = value;
  }
  function expenseRow(expense) {
    const detail = element('div', {
      class: 'meta',
      text: `${expense.expenseType === 'mileage' ? 'MONTHLY MILEAGE CLAIM · ' : ''}${expense.category}${expense.note ? ` · ${expense.note}` : ''}`
    });
    const body = element(
      'div',
      { class: 'grow' },
      element('div', { class: 'merchant', text: expense.merchant }),
      detail
    );
    if (expense.hasReceipt)
      body.append(
        element('a', { class: 'meta', href: receiptViewUrl(expense.id), text: 'View receipt' })
      );
    if (expense.reviewStatus === 'approved')
      body.append(element('div', { class: 'meta', text: 'APPROVED' }));
    if (isCompanyPaid(expense))
      body.append(
        element('div', {
          class: 'meta fuel-card',
          text: 'COMPANY PAID · EXCLUDED FROM EXPENSE TOTAL'
        })
      );
    if (['declined', 'question'].includes(expense.reviewStatus))
      body.append(
        element('div', {
          class: 'notice',
          text: `${expense.reviewStatus === 'declined' ? 'DECLINED' : 'QUESTION'}${expense.reviewNote ? `: ${expense.reviewNote}` : ''}`
        })
      );
    const row = element(
      'div',
      {
        class: 'expense expense-link',
        role: 'button',
        tabindex: '0',
        'aria-label': `View ${expense.merchant} expense details`
      },
      element('i', { class: 'dot' }),
      body,
      element('div', { class: 'amount', text: euro(expense.amount) })
    );
    const open = event => {
      if (event?.target?.closest('a,button')) return;
      go('expense', {
        expenseId: expense.id,
        returnTo: state.view === 'history' ? 'history' : 'home'
      });
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open(event);
      }
    });
    if (state.user.role !== 'super' && expense.reviewStatus !== 'approved')
      row.append(
        button(
          '×',
          async () => {
            if (!confirm(`Delete ${expense.merchant}?`)) return;
            await api(`/api/expenses/${expense.id}`, { method: 'DELETE' });
            await refreshHome();
          },
          'secondary danger'
        )
      );
    return row;
  }
  function renderExpenseList(records) {
    const root = element('div', { class: 'expense-stack' });
    if (!records.length) {
      root.append(notice('No expenses yet.'));
      return root;
    }
    const query = new URLSearchParams(location.search),
      selectedYear = query.get('year'),
      selectedMonth = query.get('month'),
      selectedDay = query.get('day');
    const push = values => {
      const url = new URL(location.href);
      for (const key of ['year', 'month', 'day']) {
        if (Object.hasOwn(values, key))
          values[key] ? url.searchParams.set(key, values[key]) : url.searchParams.delete(key);
      }
      history.pushState({ calendar: true }, '', `${url.pathname}${url.search}`);
      render();
    };
    const parentLevel = () => {
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
      render();
    };
    const heading = (title, subtitle) =>
      element(
        'div',
        { class: 'stack-heading' },
        selectedYear ? button('‹ Back', parentLevel, 'secondary stack-back') : null,
        element(
          'div',
          { class: 'grow' },
          element('div', { class: 'label', text: title }),
          subtitle ? element('div', { class: 'meta', text: subtitle }) : null
        )
      );
    const tile = (title, entries, action) =>
      element(
        'button',
        { type: 'button', class: 'calendar-cell', onclick: action },
        element('span', { text: title }),
        element('span', { class: 'calendar-cell-total', text: calendarSummary(entries) })
      );
    if (!selectedYear) {
      root.append(heading('CHOOSE A YEAR'));
      const years = records.reduce((groups, expense) => {
        const year = /^\d{4}/.exec(expense.date || '')?.[0] || 'Undated';
        (groups[year] ||= []).push(expense);
        return groups;
      }, {});
      root.append(
        element(
          'div',
          { class: 'calendar-grid year-grid' },
          ...Object.entries(years)
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([year, entries]) => tile(year, entries, () => push({ year, month: '', day: '' })))
        )
      );
      return root;
    }
    const yearRecords = records.filter(expense =>
      String(expense.date || '').startsWith(selectedYear)
    );
    if (!selectedMonth) {
      root.append(heading(selectedYear));
      const months = yearRecords.reduce((groups, expense) => {
        const month = /^\d{4}-(\d{2})/.exec(expense.date || '')?.[1] || '00';
        (groups[month] ||= []).push(expense);
        return groups;
      }, {});
      root.append(
        element(
          'div',
          { class: 'calendar-grid month-grid' },
          ...Object.entries(months)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([month, entries]) =>
              tile(
                month === '00'
                  ? 'Undated'
                  : new Date(`2000-${month}-01T12:00:00`).toLocaleDateString(undefined, {
                      month: 'long'
                    }),
                entries,
                () => push({ month, day: '' })
              )
            )
        )
      );
      return root;
    }
    const monthRecords = yearRecords.filter(
        expense => String(expense.date || '').slice(5, 7) === selectedMonth
      ),
      monthName =
        selectedMonth === '00'
          ? 'Undated'
          : new Date(`${selectedYear}-${selectedMonth}-01T12:00:00`).toLocaleDateString(undefined, {
              month: 'long',
              year: 'numeric'
            });
    if (!selectedDay) {
      root.append(heading(monthName));
      const days = monthRecords.reduce((groups, expense) => {
        const day = /^\d{4}-\d{2}-(\d{2})/.exec(expense.date || '')?.[1] || '00';
        (groups[day] ||= []).push(expense);
        return groups;
      }, {});
      root.append(
        element(
          'div',
          { class: 'calendar-grid day-grid' },
          ...Object.entries(days)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, entries]) =>
              tile(
                day === '00'
                  ? 'Undated'
                  : new Date(`${selectedYear}-${selectedMonth}-${day}T12:00:00`).toLocaleDateString(
                      undefined,
                      { weekday: 'short', day: 'numeric' }
                    ),
                entries,
                () => push({ day })
              )
            )
        )
      );
      return root;
    }
    const dayRecords = monthRecords
        .filter(expense => String(expense.date || '').slice(8, 10) === selectedDay)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
      dayTitle =
        selectedDay === '00'
          ? monthName
          : new Date(`${selectedYear}-${selectedMonth}-${selectedDay}T12:00:00`).toLocaleDateString(
              undefined,
              { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
            );
    root.append(heading(dayTitle, calendarSummary(dayRecords)), ...dayRecords.map(expenseRow));
    return root;
  }
  function renderFlatExpenseList(records) {
    const root = element('div', { class: 'expense-stack' });
    if (!records.length) {
      root.append(notice('No expenses match these filters.'));
      return root;
    }
    root.append(
      ...records
        .slice()
        .sort(
          (left, right) =>
            String(right.date || '').localeCompare(String(left.date || '')) ||
            String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
        )
        .map(expenseRow)
    );
    return root;
  }
  function odometerLogCard() {
    const month = element('input', { type: 'month', value: dateToday().slice(0, 7) });
    const readingInput = placeholder =>
      element('input', {
        type: 'number',
        min: '0',
        max: '2000000',
        step: '0.1',
        inputmode: 'decimal',
        placeholder
      });
    const car1Opening = readingInput('Car 1 opening reading'),
      car1Closing = readingInput('Car 1 closing reading');
    const car2Opening = readingInput('Car 2 opening reading'),
      car2Closing = readingInput('Car 2 closing reading');
    const car1Distance = element('input', { readonly: '', value: '—' }),
      car2Distance = element('input', { readonly: '', value: '—' }),
      combinedDistance = element('input', { readonly: '', value: '—' });
    const status = element('div');
    const saveButton = button('Save odometer reading', () => save(), 'primary');
    const editButton = button('Edit odometer reading', () => setEditing(true));
    const cancelButton = button('Cancel', () => load());
    let loaded = null;
    const distanceFor = (opening, closing) => {
      const start = Number(opening.value),
        end = Number(closing.value);
      return opening.value !== '' &&
        closing.value !== '' &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end >= start
        ? Math.round((end - start) * 10) / 10
        : null;
    };
    const updatePreview = () => {
      const first = distanceFor(car1Opening, car1Closing),
        second = distanceFor(car2Opening, car2Closing);
      car1Distance.value = first == null ? '—' : `${first} KM`;
      car2Distance.value = second == null ? '—' : `${second} KM`;
      const car2Unused = car2Opening.value === '' && car2Closing.value === '';
      combinedDistance.value =
        first == null || (!car2Unused && second == null)
          ? '—'
          : `${Math.round((first + second) * 10) / 10} KM`;
    };
    const editableReadings = [car1Opening, car1Closing, car2Opening, car2Closing];
    const setEditing = editing => {
      const saved = loaded?.saved === true;
      month.disabled = editing;
      editableReadings.forEach(input => {
        input.readOnly = saved && !editing;
      });
      saveButton.hidden = saved && !editing;
      editButton.hidden = !saved || editing;
      cancelButton.hidden = !saved || !editing;
    };
    const load = async () => {
      try {
        loaded = await api(`/api/odometer/month?month=${encodeURIComponent(month.value)}`);
        car1Opening.value = loaded.car1OpeningReading ?? '';
        car1Closing.value = loaded.car1ClosingReading ?? '';
        car2Opening.value = loaded.car2OpeningReading ?? '';
        car2Closing.value = loaded.car2ClosingReading ?? '';
        car1Distance.value = loaded.car1Kilometres == null ? '—' : `${loaded.car1Kilometres} KM`;
        car2Distance.value = loaded.car2Kilometres == null ? '—' : `${loaded.car2Kilometres} KM`;
        combinedDistance.value = loaded.kilometres == null ? '—' : `${loaded.kilometres} KM`;
        setEditing(false);
        status.replaceChildren();
        const carried = [
          loaded.car1OpeningIsCarried && 'Car 1',
          loaded.car2OpeningIsCarried && 'Car 2'
        ].filter(Boolean);
        if (carried.length)
          status.append(
            notice(
              `${carried.join(' and ')} opening ${carried.length === 1 ? 'reading was' : 'readings were'} carried forward from the previous month.`,
              true
            )
          );
        else if (loaded.saved)
          status.append(notice('This month’s odometer reading has been saved.', true));
      } catch (error) {
        status.replaceChildren(notice(error.message));
      }
    };
    const save = async () => {
      const updating = loaded?.saved === true;
      try {
        await api('/api/odometer/month', {
          method: 'POST',
          body: JSON.stringify({
            month: month.value,
            car1OpeningReading: car1Opening.value,
            car1ClosingReading: car1Closing.value,
            car2OpeningReading: car2Opening.value,
            car2ClosingReading: car2Closing.value
          })
        });
        await load();
        status.replaceChildren(
          notice(
            updating ? 'Monthly odometer reading updated.' : 'Monthly odometer reading saved.',
            true
          )
        );
      } catch (error) {
        status.replaceChildren(notice(error.message));
      }
    };
    editableReadings.forEach(input => input.addEventListener('input', updatePreview));
    month.onchange = load;
    load();
    return card(
      element('div', { class: 'label', text: 'MONTHLY ODOMETER LOG' }),
      element('p', {
        class: 'meta',
        text: 'Record Car 1. Car 2 is optional—leave both readings blank if unused.'
      }),
      element('div', { class: 'grid' }, element('label', { class: 'field', text: 'MONTH' }, month)),
      element('div', { class: 'label', text: 'CAR 1' }),
      element(
        'div',
        { class: 'grid' },
        element('label', { class: 'field', text: 'OPENING ODOMETER (KM)' }, car1Opening),
        element('label', { class: 'field', text: 'CLOSING ODOMETER (KM)' }, car1Closing),
        element('label', { class: 'field', text: 'DISTANCE' }, car1Distance)
      ),
      element('div', { class: 'label', text: 'CAR 2 (OPTIONAL)' }),
      element(
        'div',
        { class: 'grid' },
        element('label', { class: 'field', text: 'OPENING ODOMETER (KM)' }, car2Opening),
        element('label', { class: 'field', text: 'CLOSING ODOMETER (KM)' }, car2Closing),
        element('label', { class: 'field', text: 'DISTANCE' }, car2Distance)
      ),
      element('label', { class: 'field', text: 'COMBINED DISTANCE' }, combinedDistance),
      element('div', { class: 'actions' }, saveButton, editButton, cancelButton),
      status
    );
  }
  function mileageExpenseCard(initialMonth = dateToday().slice(0, 7), backAction = null) {
    const month = element('input', { type: 'month', value: initialMonth });
    const kilometres = element('input', {
      type: 'number',
      min: '0.1',
      max: '10000',
      step: '0.1',
      inputmode: 'decimal',
      placeholder: 'Monthly business KM'
    });
    const reimbursement = element('input', { readonly: '', value: '—' });
    const status = element('div');
    const saveButton = button('Save mileage expense', () => save(), 'primary');
    const editButton = button('Edit mileage expense', () => setEditing(true));
    const cancelButton = button('Cancel', () => load());
    let loaded = null;
    const updatePreview = () => {
      const km = Number(kilometres.value);
      reimbursement.value =
        Number.isFinite(km) && km > 0 ? euro(km * Number(state.settings.mileageRate || 0)) : '—';
    };
    const setEditing = editing => {
      const saved = loaded?.submitted === true,
        locked = loaded?.reviewStatus === 'approved';
      month.disabled = editing;
      kilometres.readOnly = locked || (saved && !editing);
      saveButton.hidden = locked || (saved && !editing);
      editButton.hidden = !saved || editing || locked;
      cancelButton.hidden = !saved || !editing;
    };
    const load = async () => {
      try {
        loaded = await api(`/api/mileage/month?month=${encodeURIComponent(month.value)}`);
        kilometres.value = loaded.kilometres ?? '';
        reimbursement.value = loaded.amount == null ? '—' : euro(loaded.amount);
        setEditing(false);
        status.replaceChildren();
        if (loaded.submitted)
          status.append(
            notice(
              loaded.reviewStatus === 'approved'
                ? 'This mileage expense is approved and locked.'
                : `This mileage expense is ${loaded.reviewStatus}. Select Edit to change it.`,
              true
            )
          );
      } catch (error) {
        status.replaceChildren(notice(error.message));
      }
    };
    const save = async () => {
      const updating = loaded?.submitted === true;
      try {
        const result = await api('/api/mileage/month', {
          method: 'POST',
          body: JSON.stringify({ month: month.value, kilometres: kilometres.value })
        });
        reimbursement.value = euro(result.expense.amount);
        await load();
        status.replaceChildren(
          notice(
            updating
              ? 'Mileage expense updated and returned to Pending review.'
              : 'Mileage expense saved for review.',
            true
          )
        );
        await loadExpenses();
      } catch (error) {
        status.replaceChildren(notice(error.message));
      }
    };
    kilometres.oninput = updatePreview;
    month.onchange = load;
    load();
    return card(
      element('div', { class: 'label', text: 'MONTHLY MILEAGE EXPENSE' }),
      element('p', {
        class: 'meta',
        text: `Expense claim only. Enter business kilometres for the month; reimbursement is calculated at €${Number(state.settings.mileageRate || 0).toFixed(4)} per KM.`
      }),
      element(
        'div',
        { class: 'grid' },
        element('label', { class: 'field', text: 'MONTH' }, month),
        element('label', { class: 'field', text: 'BUSINESS KILOMETRES (KM)' }, kilometres),
        element('label', { class: 'field', text: 'CALCULATED REIMBURSEMENT' }, reimbursement)
      ),
      element(
        'div',
        { class: 'actions' },
        saveButton,
        editButton,
        cancelButton,
        backAction ? button('Back', backAction) : null
      ),
      status
    );
  }
  function expenseForm() {
    const editor = element('div', { class: 'hidden' }),
      status = element('div');
    const input = element('input', {
      type: 'file',
      accept: 'image/jpeg,image/png,image/webp,application/pdf'
    });
    const mode = { value: 'manual', receipt: null };
    const merchant = element('input', {
        required: '',
        maxlength: '120',
        placeholder: 'e.g. Shell'
      }),
      amount = element('input', {
        type: 'number',
        required: '',
        min: '0.01',
        step: '0.01',
        inputmode: 'decimal'
      });
    const category = element('select'),
      date = element('input', { type: 'date', value: dateToday(), required: '' }),
      note = element('input', { maxlength: '300', placeholder: 'Optional' });
    for (const item of state.settings.categories)
      category.append(element('option', { value: item, text: item }));
    const uploadHelp = element('small', {
      text: 'JPEG, PNG or WebP images up to 10 MB (compressed automatically); PDFs up to 4 MB.'
    });
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const isPdf = file.type === 'application/pdf',
        allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type),
        limit = isPdf ? 4 * 1024 * 1024 : 10 * 1024 * 1024;
      if (!allowed || file.size > limit) {
        status.replaceChildren(
          notice(
            isPdf
              ? 'Choose a PDF receipt up to 4 MB.'
              : 'Choose a JPEG, PNG or WebP receipt image up to 10 MB.'
          )
        );
        input.value = '';
        mode.receipt = null;
        return;
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      mode.receipt = { image: data, mediaType: file.type };
      uploadHelp.textContent = isPdf
        ? `PDF attached: ${file.name}`
        : `Image attached: ${file.name} · it will be compressed securely when saved.`;
      if (mode.value === 'scan' && !isPdf) {
        status.replaceChildren(notice('Compressing and reading receipt…', true));
        try {
          const result = await api('/api/ocr', {
            method: 'POST',
            body: JSON.stringify(mode.receipt)
          });
          merchant.value = result.merchant || merchant.value;
          amount.value = result.amount || amount.value;
          category.value = result.category || category.value;
          date.value = result.date || date.value;
          note.value = result.note || note.value;
          status.replaceChildren(
            notice('Receipt compressed and read. Please check the details.', true)
          );
        } catch (error) {
          status.replaceChildren(notice(error.message));
        }
      }
    };
    let saving = false,
      saved = false,
      submission = null;
    async function saveExpense() {
      if (saving || saved) return;
      if (!form.reportValidity()) return;
      saving = true;
      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
      // Keep the exact payload and identifier for retries after an uncertain response.
      submission ||= {
        merchant: merchant.value,
        amount: amount.value,
        currency: 'EUR',
        category: category.value,
        date: date.value,
        note: note.value,
        receipt: mode.receipt,
        submissionId: crypto.randomUUID(),
        confirmDuplicate: false
      };
      try {
        try {
          await api('/api/expenses', { method: 'POST', body: JSON.stringify(submission) });
        } catch (error) {
          if (error.code !== 'possible_duplicate' || submission.confirmDuplicate) throw error;
          if (!confirm(error.message)) {
            submission = null;
            status.replaceChildren();
            return;
          }
          submission.confirmDuplicate = true;
          await api('/api/expenses', { method: 'POST', body: JSON.stringify(submission) });
        }
        saved = true;
        editor.classList.add('hidden');
        status.replaceChildren(notice('Expense saved.', true));
        try {
          await refreshHome();
        } catch {
          editor.classList.remove('hidden');
          status.replaceChildren(
            notice(
              'Expense saved. The list could not refresh; reload the page. Do not submit it again.',
              true
            )
          );
        }
      } catch (error) {
        // A definitive validation rejection can be corrected; network/server failures retain the payload.
        if (error.status >= 400 && error.status < 500 && error.code !== 'submission_conflict')
          submission = null;
        status.replaceChildren(notice(error.message));
      } finally {
        saving = false;
        saveButton.disabled = saved;
        saveButton.textContent = saved ? 'Saved' : submission ? 'Retry save' : 'Save expense';
      }
    }
    const saveButton = button('Save expense', saveExpense, 'primary');
    const form = element(
      'form',
      {},
      element(
        'div',
        { class: 'scan' },
        element('strong', { text: 'Attach a receipt (optional)' }),
        element('br'),
        uploadHelp,
        element('br'),
        input
      ),
      status,
      element('label', { class: 'field', text: 'MERCHANT' }, merchant),
      element(
        'div',
        { class: 'grid' },
        element('label', { class: 'field', text: 'AMOUNT' }, amount),
        element('label', { class: 'field', text: 'CATEGORY' }, category),
        element('label', { class: 'field', text: 'DATE' }, date)
      ),
      element('label', { class: 'field', text: 'NOTE' }, note),
      saveButton,
      button(
        'Cancel',
        () => {
          if (saving || submission) {
            status.replaceChildren(
              notice('Please finish or retry the current save before starting another expense.')
            );
            return;
          }
          editor.classList.add('hidden');
          form.reset();
          mode.receipt = null;
          date.value = dateToday();
          status.replaceChildren();
        },
        'secondary'
      )
    );
    const open = nextMode => {
      mode.value = nextMode;
      editor.classList.remove('hidden');
      if (nextMode === 'scan') input.click();
    };
    editor.append(form);
    return card(
      element(
        'div',
        { class: 'actions' },
        button('Scan receipt', () => open('scan')),
        button('Add manually', () => open('manual'))
      ),
      editor
    );
  }
  async function refreshHome() {
    await loadExpenses();
    go('home');
  }
  function monthlyPieCard() {
    const month = dateToday().slice(0, 7),
      records = state.expenses.filter(expense => expense.date?.startsWith(month));
    const total = records.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
      totals = records.reduce((all, expense) => {
        all[expense.category] = (all[expense.category] || 0) + Number(expense.amount || 0);
        return all;
      }, {}),
      slices = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const title = new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric'
    });
    const panel = card(
      element('div', { class: 'label', text: 'MONTHLY SPEND BREAKDOWN' }),
      element('h2', { text: euro(total) }),
      element('p', {
        class: 'meta',
        text: `${title} · ${records.length} expense${records.length === 1 ? '' : 's'}`
      })
    );
    if (!slices.length) {
      panel.append(notice('No expenses have been recorded this month.'));
      return panel;
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('width', '210');
    svg.setAttribute('height', '210');
    const colors = [
      '#277b91',
      '#45a894',
      '#f4b844',
      '#ef7d48',
      '#7c8ed4',
      '#bd5b45',
      '#8bbdd0',
      '#789d72',
      '#a475b6'
    ];
    if (slices.length === 1) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '100');
      circle.setAttribute('cy', '100');
      circle.setAttribute('r', '88');
      circle.setAttribute('fill', colors[0]);
      svg.append(circle);
    } else {
      let angle = -Math.PI / 2;
      slices.forEach(([, value], index) => {
        const next = angle + (value / total) * Math.PI * 2,
          x1 = 100 + 88 * Math.cos(angle),
          y1 = 100 + 88 * Math.sin(angle),
          x2 = 100 + 88 * Math.cos(next),
          y2 = 100 + 88 * Math.sin(next),
          large = next - angle > Math.PI ? 1 : 0,
          path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M100 100 L${x1} ${y1} A88 88 0 ${large} 1 ${x2} ${y2} Z`);
        path.setAttribute('fill', colors[index % colors.length]);
        svg.append(path);
        angle = next;
      });
    }
    const legend = element('div', { class: 'meta' });
    slices.forEach(([name, value], index) =>
      legend.append(
        element('div', {
          text: `${name}: ${euro(value)} (${Math.round((value / total) * 100)}%)`,
          style: `border-left:10px solid ${colors[index % colors.length]};padding-left:7px;margin:5px 0`
        })
      )
    );
    panel.append(svg, legend);
    return panel;
  }
  function editExpenseCard(expense) {
    const status = element('div'),
      merchant = element('input', { required: '', maxlength: '120', value: expense.merchant }),
      amount = element('input', {
        type: 'number',
        min: '0.01',
        max: '1000000',
        step: '0.01',
        required: '',
        value: expense.amount
      }),
      category = element('select', { required: '' }),
      date = element('input', { type: 'date', required: '', value: expense.date }),
      note = element('input', { maxlength: '300', value: expense.note || '' });
    category.append(
      ...state.settings.categories.map(value => element('option', { value, text: value }))
    );
    category.value = expense.category;
    const save = async () => {
      try {
        await api(`/api/expenses/${expense.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            merchant: merchant.value,
            amount: amount.value,
            currency: 'EUR',
            category: category.value,
            date: date.value,
            note: note.value
          })
        });
        await expenseDetailPage();
      } catch (error) {
        status.replaceChildren(notice(error.message));
      }
    };
    return card(
      element('div', { class: 'label', text: 'EDIT EXPENSE' }),
      element('p', {
        class: 'meta',
        text: 'Changes return a questioned or declined expense to Pending review. The attached receipt is unchanged.'
      }),
      element('label', { class: 'field', text: 'MERCHANT' }, merchant),
      element(
        'div',
        { class: 'grid' },
        element('label', { class: 'field', text: 'AMOUNT' }, amount),
        element('label', { class: 'field', text: 'CATEGORY' }, category),
        element('label', { class: 'field', text: 'DATE' }, date)
      ),
      element('label', { class: 'field', text: 'NOTE' }, note),
      element(
        'div',
        { class: 'actions' },
        button('Save changes', save, 'primary'),
        button('Cancel', () => expenseDetailPage())
      ),
      status
    );
  }
  async function expenseDetailPage() {
    await Promise.all([loadExpenses(), loadSettings()]);
    const expense = state.expenses.find(item => item.id === state.expenseId);
    if (!expense)
      return setContent(notice('This expense is unavailable or you no longer have access to it.'));
    const field = (label, value) =>
      element(
        'label',
        { class: 'field', text: label },
        element('input', { value: value || '—', readonly: '' })
      );
    const status = expense.reviewStatus || 'pending';
    const statusLabel =
      {
        approved: 'Approved',
        declined: 'Declined',
        question: 'Questioned',
        pending: 'Pending review'
      }[status] || status;
    const fields = [
      field('MERCHANT', expense.merchant),
      field('DATE', expense.date),
      field('AMOUNT', euro(expense.amount)),
      field('CATEGORY', expense.category),
      field('NOTE', expense.note || 'None'),
      field('REVIEW STATUS', statusLabel)
    ];
    if (expense.kilometres) {
      fields.splice(
        4,
        0,
        field('KILOMETRES (KM)', String(expense.kilometres)),
        field('RATE PER KM', euro(expense.mileageRate || 0))
      );
      if (expense.expenseType === 'mileage' && expense.odometerOpening !== undefined)
        fields.splice(
          4,
          0,
          field('OPENING ODOMETER (KM)', String(expense.odometerOpening)),
          field('CLOSING ODOMETER (KM)', String(expense.odometerClosing))
        );
    }
    const exportExpense = () => {
      const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const row =
        [
          'Date',
          'Merchant',
          'Category',
          'Amount',
          'Currency',
          'Note',
          'Review status',
          'Review message',
          'Kilometres',
          'Rate per KM'
        ]
          .map(quote)
          .join(',') +
        '\r\n' +
        [
          expense.date,
          expense.merchant,
          expense.category,
          expense.amount,
          expense.currency || 'EUR',
          expense.note || '',
          statusLabel,
          expense.reviewNote || '',
          expense.kilometres || '',
          expense.mileageRate || ''
        ]
          .map(quote)
          .join(',');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([row], { type: 'text/csv;charset=utf-8' }));
      link.download = `oxygen-care-expense-${expense.date || 'record'}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };
    const details = card(
      element('div', { class: 'label', text: 'EXPENSE DETAILS' }),
      element('p', {
        class: 'meta',
        text:
          status === 'approved'
            ? 'Approved expenses are locked and cannot be edited.'
            : 'This expense can be edited until it is approved.'
      }),
      element('div', { class: 'grid' }, ...fields),
      expense.reviewNote ? notice(`Review message: ${expense.reviewNote}`) : null,
      element(
        'div',
        { class: 'actions' },
        state.user.role !== 'super' && status !== 'approved'
          ? button(
              status === 'question'
                ? 'Respond / Edit expense'
                : expense.expenseType === 'mileage'
                  ? 'Edit mileage expense'
                  : 'Edit expense',
              () =>
                setContent(
                  expense.expenseType === 'mileage'
                    ? mileageExpenseCard(expense.mileageMonth, () => expenseDetailPage())
                    : editExpenseCard(expense)
                ),
              'primary'
            )
          : null,
        expense.hasReceipt
          ? element('a', {
              class: 'link-button',
              href: receiptViewUrl(expense.id),
              text: 'View receipt'
            })
          : null,
        button('Download CSV', exportExpense),
        button('Print / Save PDF', () => {
          document.body.classList.add('print-expense');
          window.print();
          setTimeout(() => document.body.classList.remove('print-expense'), 1000);
        }),
        button('Back', () =>
          go(state.returnTo === 'history' ? 'history' : 'home', { replace: true })
        )
      )
    );
    setContent(details);
  }
  function yearToDateCards() {
    const year = dateToday().slice(0, 4),
      records = state.expenses.filter(expense => String(expense.date || '').startsWith(year)),
      userPaid = records.filter(expense => !isCompanyPaid(expense)),
      fuelCard = records.filter(isCompanyPaid);
    return [
      card(
        element(
          'div',
          { class: 'hero' },
          element('div', { class: 'label', text: 'YEAR-TO-DATE EXPENSES' }),
          element('h1', { text: euro(expenseAmount(userPaid)) }),
          element('div', { text: `${userPaid.length} expense${userPaid.length === 1 ? '' : 's'}` })
        )
      ),
      card(
        element('div', { class: 'label', text: 'YEAR-TO-DATE COMPANY PAID' }),
        element('h2', { text: euro(expenseAmount(fuelCard)) }),
        element('div', {
          class: 'meta',
          text: `${fuelCard.length} company-paid transaction${fuelCard.length === 1 ? '' : 's'} · excluded from expense total`
        })
      )
    ];
  }
  async function regularHome() {
    await Promise.all([loadExpenses(), loadSettings()]);
    const category = element('select');
    category.append(
      element('option', { value: 'All', text: 'All categories' }),
      ...state.settings.categories.map(value => element('option', { value, text: value }))
    );
    restoreFilter(category, 'category');
    const listCard = card(
      element('div', { class: 'label', text: 'EXPENSES' }),
      element('label', { class: 'field', text: 'CATEGORY FILTER' }, category)
    );
    const draw = () => {
      const visible =
        category.value === 'All'
          ? state.expenses
          : state.expenses.filter(expense => expense.category === category.value);
      listCard.replaceChildren(
        element('div', { class: 'label', text: 'EXPENSES' }),
        element('label', { class: 'field', text: 'CATEGORY FILTER' }, category),
        renderExpenseList(visible)
      );
    };
    category.onchange = () =>
      resetExpenseCalendar(draw, { category: category.value === 'All' ? '' : category.value });
    draw();
    const notifications = await notificationCard();
    setContent(
      ...(notifications ? [notifications] : []),
      monthlyPieCard(),
      expenseForm(),
      state.user.mileageEnabled ? mileageExpenseCard() : null,
      listCard
    );
    if (state.user.role === 'department_head') await addDepartmentReview();
  }
  function odometerPage() {
    setContent(odometerLogCard());
  }
  async function expenseHistory() {
    await Promise.all([loadExpenses(), loadSettings()]);
    const from = element('input', { type: 'date' }),
      to = element('input', { type: 'date' }),
      category = element('select');
    category.append(
      element('option', { value: 'All', text: 'All categories' }),
      ...state.settings.categories.map(value => element('option', { value, text: value }))
    );
    restoreFilter(from, 'from');
    restoreFilter(to, 'to');
    restoreFilter(category, 'category');
    const results = element('div');
    const draw = () => {
      const records = state.expenses.filter(
          expense =>
            (!from.value || expense.date >= from.value) &&
            (!to.value || expense.date <= to.value) &&
            (category.value === 'All' || expense.category === category.value)
        ),
        userPaid = records.filter(expense => !isCompanyPaid(expense)),
        fuelCard = records.filter(isCompanyPaid);
      results.replaceChildren(
        element('div', {
          class: 'meta',
          text: `${records.length} expense${records.length === 1 ? '' : 's'} found · Expenses: ${euro(expenseAmount(userPaid))} · Company paid: ${euro(expenseAmount(fuelCard))}`
        }),
        renderFlatExpenseList(records)
      );
    };
    [from, to, category].forEach(
      input =>
        (input.onchange = () =>
          resetExpenseCalendar(draw, {
            from: from.value,
            to: to.value,
            category: category.value === 'All' ? '' : category.value
          }))
    );
    draw();
    setContent(
      ...yearToDateCards(),
      card(
        element('div', { class: 'label', text: 'EXPENSE HISTORY' }),
        element(
          'div',
          { class: 'actions' },
          button('Reimbursement history', () => go('reimbursements'))
        ),
        element(
          'div',
          { class: 'grid' },
          element('label', { class: 'field', text: 'FROM' }, from),
          element('label', { class: 'field', text: 'TO' }, to),
          element('label', { class: 'field', text: 'CATEGORY' }, category)
        ),
        results
      )
    );
  }
  async function reimbursementHistory() {
    const { reimbursements } = await api('/api/reimbursements/mine');
    const from = element('input', { type: 'date' }),
      to = element('input', { type: 'date' }),
      status = element('select');
    status.append(
      element('option', { value: 'All', text: 'All statuses' }),
      element('option', { value: 'sent', text: 'New / unread' }),
      element('option', { value: 'dismissed', text: 'Viewed' })
    );
    const results = element('div');
    const draw = () => {
      const records = reimbursements.filter(
        item =>
          (!from.value || String(item.sentAt || '').slice(0, 10) >= from.value) &&
          (!to.value || String(item.sentAt || '').slice(0, 10) <= to.value) &&
          (status.value === 'All' || (status.value === 'dismissed') === Boolean(item.dismissedAt))
      );
      const total = records.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      results.replaceChildren(
        element('div', {
          class: 'meta',
          text: `${records.length} reimbursement notice${records.length === 1 ? '' : 's'}${records.some(item => item.amount != null) ? ` · ${euro(total)}` : ''}`
        }),
        ...records.map(item =>
          element(
            'div',
            { class: 'expense' },
            element(
              'div',
              { class: 'grow' },
              element('strong', {
                text: item.dismissedAt
                  ? 'Reimbursement update · viewed'
                  : 'Reimbursement update · new'
              }),
              element('div', { class: 'meta', text: item.message || 'No message supplied.' }),
              element('div', {
                class: 'meta',
                text: `${item.amount == null ? '' : `${euro(item.amount)} · `}${new Date(item.sentAt).toLocaleString()}${item.sentBy ? ` · Sent by ${item.sentBy}` : ''}`
              })
            )
          )
        )
      );
      if (!records.length) results.append(notice('No reimbursement notices match these filters.'));
    };
    [from, to, status].forEach(input => (input.onchange = draw));
    draw();
    setContent(
      card(
        element('div', { class: 'label', text: 'REIMBURSEMENT HISTORY' }),
        element(
          'div',
          { class: 'actions' },
          button('Back to expense history', () => go('history'))
        ),
        element(
          'div',
          { class: 'grid' },
          element('label', { class: 'field', text: 'FROM' }, from),
          element('label', { class: 'field', text: 'TO' }, to),
          element('label', { class: 'field', text: 'STATUS' }, status)
        ),
        results
      )
    );
  }
  async function notificationCard() {
    const { notifications } = await api('/api/notifications');
    if (!notifications.length) return null;
    const section = card(element('div', { class: 'label', text: 'REIMBURSEMENT NOTIFICATIONS' }));
    for (const item of notifications) {
      const row = element(
        'div',
        { class: 'expense' },
        element(
          'div',
          { class: 'grow' },
          element('strong', { text: 'Reimbursement update' }),
          element('div', { class: 'meta', text: item.message }),
          element('div', {
            class: 'meta',
            text: `${item.amount == null ? '' : `${euro(item.amount)} · `}${new Date(item.sentAt).toLocaleString()}`
          })
        ),
        button('Dismiss', async () => {
          await api(`/api/notifications/${item.id}`, { method: 'PATCH' });
          row.remove();
        })
      );
      section.append(row);
    }
    return section;
  }
  async function superDashboard() {
    const panel = card(
      element('div', { class: 'label', text: 'SUPER USER DASHBOARD · ALL USER EXPENSES' })
    );
    const year = element('select'),
      department = element('select'),
      total = element('h1'),
      chart = element('div', { class: 'chart' });
    panel.append(
      element(
        'div',
        { class: 'grid' },
        element('label', { class: 'field', text: 'YEAR' }, year),
        element('label', { class: 'field', text: 'DEPARTMENT' }, department)
      ),
      total,
      chart
    );
    const draw = async () => {
      const query = new URLSearchParams({
        year: year.value,
        department: department.value || 'All'
      });
      const data = await api(`/api/dashboard/expenses?${query}`);
      if (!year.options.length)
        data.years.forEach(value => year.append(element('option', { value, text: value })));
      if (!year.value) year.value = data.year;
      const selectedDepartment = department.value || 'All';
      department.replaceChildren(
        ...data.departments.map(value => element('option', { value, text: value }))
      );
      department.value = data.departments.includes(selectedDepartment) ? selectedDepartment : 'All';
      const values = data.months.map(month => Number(month.totalsByCurrency.EUR || 0)),
        maximum = Math.max(1, ...values);
      total.textContent = `Expenses: ${euro(values.reduce((sum, value) => sum + value, 0))} · Company paid: ${euro(data.months.reduce((sum, month) => sum + Number(month.companyPaidTotalsByCurrency?.EUR || 0), 0))}`;
      chart.replaceChildren();
      values.forEach((value, index) => {
        const bar = element('i', {
          title: `${index + 1}: ${euro(value)}`,
          style: `height:${(value / maximum) * 145}px`
        });
        chart.append(
          element(
            'div',
            {},
            bar,
            element('small', {
              text: [
                'Jan',
                'Feb',
                'Mar',
                'Apr',
                'May',
                'Jun',
                'Jul',
                'Aug',
                'Sep',
                'Oct',
                'Nov',
                'Dec'
              ][index]
            })
          )
        );
      });
    };
    year.onchange = draw;
    department.onchange = draw;
    setContent(panel);
    await draw();
  }
  function userForm(existing = null) {
    const status = element('div');
    const fullName = element('input', {
        required: '',
        maxlength: '100',
        value: existing?.fullName || ''
      }),
      email = element('input', {
        type: 'email',
        maxlength: '254',
        required: '',
        value: existing?.email || ''
      }),
      password = element('input', {
        type: 'password',
        minlength: '12',
        maxlength: '128',
        autocomplete: 'new-password'
      }),
      department = element('select', { required: '' }),
      role = element('select');
    if (!existing) password.required = true;
    for (const name of state.settings.departments)
      department.append(element('option', { value: name, text: name }));
    for (const [value, text] of [
      ['regular', 'Regular User'],
      ['department_head', 'Department Head'],
      ['super', 'Super User']
    ])
      role.append(element('option', { value, text }));
    const job = element('input', { maxlength: '120', value: existing?.jobDescription || '' }),
      car = element('input', { maxlength: '20', value: existing?.carRegistration || '' }),
      mileage = element('input', { type: 'checkbox' });
    if (existing) {
      email.disabled = true;
      department.value = existing.department;
      role.value = existing.role || 'regular';
      role.disabled = true;
      mileage.checked = existing.mileageEnabled === true;
    }
    const save = async () => {
      const payload = {
        fullName: fullName.value,
        department: department.value,
        jobDescription: job.value,
        carRegistration: car.value,
        mileageEnabled: mileage.checked
      };
      if (!existing)
        Object.assign(payload, { email: email.value, password: password.value, role: role.value });
      try {
        await api(existing ? `/api/users/${existing.id}` : '/api/users', {
          method: existing ? 'PATCH' : 'POST',
          body: JSON.stringify(payload)
        });
        status.replaceChildren(notice(existing ? 'Profile updated.' : 'User created.', true));
        setTimeout(() => go('users'), 350);
      } catch (error) {
        status.replaceChildren(notice(error.message));
      }
    };
    return card(
      element('div', { class: 'label', text: existing ? 'EDIT USER' : 'CREATE USER' }),
      element('label', { class: 'field', text: 'FULL NAME' }, fullName),
      element('label', { class: 'field', text: 'EMAIL' }, email),
      element(
        'label',
        { class: `field${existing ? ' hidden' : ''}`, text: 'TEMPORARY PASSWORD' },
        password
      ),
      element('label', { class: 'field', text: 'DEPARTMENT' }, department),
      element('label', { class: `field${existing ? ' hidden' : ''}`, text: 'ACCOUNT TYPE' }, role),
      element('label', { class: 'field', text: 'JOB DESCRIPTION' }, job),
      element('label', { class: 'field', text: 'CAR REGISTRATION' }, car),
      element('label', { class: 'field checkbox-field', text: 'ALLOW MILEAGE EXPENSES' }, mileage),
      element(
        'div',
        { class: 'actions' },
        button(existing ? 'Update profile' : 'Create user', save, 'primary'),
        button('Back', () => go('users'))
      ),
      status
    );
  }
  async function profilePage() {
    await loadSettings();
    if (state.user.role !== 'super') {
      const field = (label, value) =>
        element(
          'label',
          { class: 'field', text: label },
          element('input', { value: value || '—', readonly: '' })
        );
      return setContent(
        card(
          element('div', { class: 'label', text: 'MY PROFILE' }),
          element('p', {
            class: 'meta',
            text: 'Your profile is managed by a Super User and is read-only.'
          }),
          field('FULL NAME', state.user.fullName),
          field('EMAIL ADDRESS', state.user.email),
          field('DEPARTMENT', state.user.department),
          field('JOB DESCRIPTION', state.user.jobDescription),
          field('CAR REGISTRATION', state.user.carRegistration),
          element(
            'div',
            { class: 'actions' },
            button('Back', () => go('home'))
          )
        )
      );
    }
    const status = element('div');
    const fullName = element('input', {
      required: '',
      maxlength: '100',
      value: state.user.fullName || ''
    });
    const email = element('input', {
      type: 'email',
      maxlength: '254',
      required: '',
      value: state.user.email || '',
      autocomplete: 'email'
    });
    const job = element('input', { maxlength: '120', value: state.user.jobDescription || '' });
    const car = element('input', { maxlength: '20', value: state.user.carRegistration || '' });
    const currentPassword = element('input', {
      type: 'password',
      maxlength: '128',
      autocomplete: 'current-password'
    });
    const newPassword = element('input', {
      type: 'password',
      minlength: '12',
      maxlength: '128',
      autocomplete: 'new-password'
    });
    const department = element('select');
    state.settings.departments.forEach(name =>
      department.append(element('option', { value: name, text: name }))
    );
    department.value = state.user.department || '';
    const canEditDepartment = state.user.role === 'super';
    department.disabled = !canEditDepartment;
    const save = async () => {
      const payload = {
        fullName: fullName.value,
        email: email.value,
        jobDescription: job.value,
        carRegistration: car.value,
        currentPassword: currentPassword.value,
        newPassword: newPassword.value
      };
      if (canEditDepartment) payload.department = department.value;
      try {
        const result = await api(`/api/users/${state.user.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload)
        });
        if (result.reloginRequired) {
          status.replaceChildren(notice('Profile saved. Please sign in again.', true));
          setTimeout(async () => {
            try {
              await api('/api/auth/logout', { method: 'POST' });
            } finally {
              location.reload();
            }
          }, 800);
          return;
        }
        state.user = result.user;
        $('#identity').textContent = personName(result.user);
        currentPassword.value = '';
        newPassword.value = '';
        status.replaceChildren(notice('Profile updated.', true));
      } catch (error) {
        status.replaceChildren(notice(error.message));
      }
    };
    const departmentField = canEditDepartment
      ? element('label', { class: 'field', text: 'DEPARTMENT' }, department)
      : element(
          'label',
          { class: 'field', text: 'DEPARTMENT' },
          element('input', { value: state.user.department || 'Unassigned', readonly: '' })
        );
    setContent(
      card(
        element('div', { class: 'label', text: 'MY PROFILE' }),
        element('p', {
          class: 'meta',
          text: canEditDepartment
            ? 'As a Super User, you may edit your complete profile.'
            : 'You may update your contact and vehicle details. Department, role and mileage access are managed by a Super User.'
        }),
        element('label', { class: 'field', text: 'FULL NAME' }, fullName),
        element('label', { class: 'field', text: 'EMAIL ADDRESS' }, email),
        departmentField,
        element('label', { class: 'field', text: 'JOB DESCRIPTION' }, job),
        element('label', { class: 'field', text: 'CAR REGISTRATION' }, car),
        element('div', { class: 'label', text: 'SECURITY' }),
        element('p', {
          class: 'meta',
          text: 'Your current password is required only if you change your email address or password.'
        }),
        element('label', { class: 'field', text: 'CURRENT PASSWORD' }, currentPassword),
        element(
          'label',
          { class: 'field', text: 'NEW PASSWORD (OPTIONAL, 12+ CHARACTERS)' },
          newPassword
        ),
        element(
          'div',
          { class: 'actions' },
          button('Save profile', save, 'primary'),
          button('Back', () => go('home'))
        ),
        status
      )
    );
  }
  async function usersPage() {
    await loadSettings();
    const [regularResult, superResult, departmentHeadResult] = await Promise.all([
      api('/api/users'),
      api('/api/super-users'),
      api('/api/department-heads')
    ]);
    const people = regularResult.users,
      superUsers = superResult.users,
      departmentHeads = departmentHeadResult.users;
    const select = element('select');
    select.append(element('option', { value: '', text: 'Choose a regular user' }));
    people.forEach(person =>
      select.append(
        element('option', {
          value: person.id,
          text: `${personName(person)}${person.department ? ` · ${person.department}` : ''}`
        })
      )
    );
    const details = element('div', { class: 'meta' });
    select.onchange = () => {
      const person = people.find(user => user.id === select.value);
      details.replaceChildren();
      if (!person) return;
      details.append(
        element('strong', { text: personName(person) }),
        element('div', {
          class: 'meta',
          text: `${person.email} · ${[person.department, person.jobDescription, person.carRegistration].filter(Boolean).join(' · ')}`
        }),
        element(
          'div',
          { class: 'actions' },
          button('Review expenses', () =>
            openReview(`/review.html?userId=${encodeURIComponent(person.id)}&returnTo=users`)
          ),
          button('Edit profile', () => setContent(userForm(person))),
          button(
            'Delete user',
            async () => {
              if (!confirm(`Delete ${personName(person)} and all of their stored expenses?`))
                return;
              await api(`/api/users/${person.id}`, { method: 'DELETE' });
              go('users');
            },
            'secondary danger'
          )
        )
      );
    };
    const superSelect = element('select');
    superSelect.append(element('option', { value: '', text: 'Choose a Super User' }));
    superUsers.forEach(person =>
      superSelect.append(
        element('option', {
          value: person.id,
          text: `${personName(person)}${person.id === state.user.id ? ' · You' : ''}`
        })
      )
    );
    const superDetails = element('div', { class: 'meta' });
    superSelect.onchange = () => {
      const person = superUsers.find(user => user.id === superSelect.value);
      superDetails.replaceChildren();
      if (!person) return;
      superDetails.append(
        element('strong', { text: personName(person) }),
        element('div', {
          class: 'meta',
          text: `${person.email}${person.department ? ` · ${person.department}` : ''}`
        })
      );
      if (person.id === state.user.id)
        return superDetails.append(
          notice('This is your account. You cannot demote or delete your own Super User account.')
        );
      const act = async action => {
        const verb =
          action === 'demote'
            ? 'change this Super User into a regular user'
            : 'permanently delete this Super User and any linked expenses';
        if (!confirm(`Are you sure you want to ${verb}? This action is recorded in the audit log.`))
          return;
        try {
          await api(`/api/super-users/${person.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ action })
          });
          go('users');
        } catch (error) {
          superDetails.append(notice(error.message));
        }
      };
      superDetails.append(
        element(
          'div',
          { class: 'actions' },
          button('Make regular user', () => act('demote')),
          button('Delete Super User', () => act('delete'), 'secondary danger')
        )
      );
    };
    const headSelect = element('select');
    headSelect.append(element('option', { value: '', text: 'Choose a Department Head' }));
    departmentHeads.forEach(person =>
      headSelect.append(
        element('option', {
          value: person.id,
          text: `${personName(person)}${person.department ? ` · ${person.department}` : ''}`
        })
      )
    );
    const headDetails = element('div', { class: 'meta' });
    headSelect.onchange = () => {
      const person = departmentHeads.find(user => user.id === headSelect.value);
      headDetails.replaceChildren();
      if (!person) return;
      headDetails.append(
        element('strong', { text: personName(person) }),
        element('div', {
          class: 'meta',
          text: `${person.email}${person.department ? ` · ${person.department}` : ''}`
        })
      );
      const act = async action => {
        const verb =
          action === 'demote'
            ? 'change this Department Head into a regular user'
            : 'permanently delete this Department Head and any linked expenses';
        if (!confirm(`Are you sure you want to ${verb}? This action is recorded in the audit log.`))
          return;
        try {
          await api(`/api/department-heads/${person.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ action })
          });
          go('users');
        } catch (error) {
          headDetails.append(notice(error.message));
        }
      };
      headDetails.append(
        element(
          'div',
          { class: 'actions' },
          button('Make regular user', () => act('demote')),
          button('Delete Department Head', () => act('delete'), 'secondary danger')
        )
      );
    };
    setContent(
      userForm(),
      card(
        element('div', { class: 'label', text: 'REGULAR USERS' }),
        element('label', { class: 'field', text: 'SELECT REGULAR USER' }, select),
        details
      ),
      card(
        element('div', { class: 'label', text: 'DEPARTMENT HEAD ACCOUNTS' }),
        element('p', {
          class: 'meta',
          text: 'Changing a Department Head to a regular user removes their employee-review access.'
        }),
        element('label', { class: 'field', text: 'SELECT DEPARTMENT HEAD' }, headSelect),
        headDetails
      ),
      card(
        element('div', { class: 'label', text: 'SUPER USER ACCOUNTS' }),
        element('p', {
          class: 'meta',
          text: 'You cannot change or delete your own account. At least one Super User must always remain.'
        }),
        element('label', { class: 'field', text: 'SELECT SUPER USER' }, superSelect),
        superDetails
      )
    );
  }
  async function addDepartmentReview() {
    const panel = card(
      element('div', { class: 'label', text: 'DEPARTMENT HEAD · EMPLOYEE EXPENSE REVIEW' }),
      element('div', { class: 'meta', text: 'Loading employees…' })
    );
    $('#content').append(panel);
    try {
      const people = (await api('/api/users')).users;
      if (!people.length)
        return panel.replaceChildren(notice('No regular users are assigned to your department.'));
      const select = element('select');
      select.append(element('option', { value: '', text: 'Choose an employee' }));
      people.forEach(person =>
        select.append(element('option', { value: person.id, text: personName(person) }))
      );
      select.onchange = () => {
        if (select.value)
          openReview(`/review-head.html?userId=${encodeURIComponent(select.value)}&returnTo=home`);
      };
      panel.replaceChildren(
        element('div', { class: 'label', text: 'DEPARTMENT HEAD · EMPLOYEE EXPENSE REVIEW' }),
        element('label', { class: 'field', text: 'SELECT EMPLOYEE' }, select)
      );
    } catch (error) {
      panel.replaceChildren(notice(error.message));
    }
  }
  async function render() {
    nav();
    try {
      if (state.view === 'profile') return await profilePage();
      if (state.view === 'expense') return await expenseDetailPage();
      if (state.user.role === 'super') {
        if (state.view === 'users') return await usersPage();
        return await superDashboard();
      }
      if (state.view === 'history') return await expenseHistory();
      if (state.view === 'reimbursements') return await reimbursementHistory();
      if (state.view === 'odometer') return odometerPage();
      await regularHome();
    } catch (error) {
      setContent(notice(error.message));
    }
  }
  async function signIn(event) {
    event.preventDefault();
    $('#loginError').textContent = '';
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: $('#loginEmail').value, password: $('#loginPassword').value })
      });
      resetWorkspaceRoute();
      await start(result.user, result.idleTimeoutMinutes);
    } catch (error) {
      $('#loginError').textContent = error.message;
    }
  }
  async function start(user, idleTimeoutMinutes) {
    state.user = user;
    state.idleTimeoutMs = Math.max(5, Number(idleTimeoutMinutes) || 20) * 60 * 1000;
    $('#identity').textContent = personName(user);
    $('#loadingScreen').hidden = true;
    $('#loginScreen').hidden = true;
    $('#app').hidden = false;
    resetTimer();
    await render();
  }
  $('#loginForm').addEventListener('submit', signIn);
  $('#revealPassword').addEventListener('click', () => {
    const field = $('#loginPassword');
    field.type = field.type === 'password' ? 'text' : 'password';
    $('#revealPassword').textContent = field.type === 'password' ? 'Show' : 'Hide';
  });
  function endSession() {
    state.user = null;
    clearTimeout(idleTimer);
    location.assign('/logout');
  }
  $('#logout').addEventListener('click', endSession);
  window.addEventListener('popstate', () => {
    const query = new URLSearchParams(location.search);
    state.view = viewFromLocation();
    state.expenseId = query.get('expenseId') || '';
    state.returnTo = query.get('returnTo') || 'home';
    if (state.user) render();
  });
  api('/api/auth/me')
    .then(result => start(result.user, result.idleTimeoutMinutes))
    .catch(() => {
      $('#loadingScreen').hidden = true;
      $('#loginScreen').hidden = false;
    });
  let idleTimer;
  const resetTimer = () => {
    if (!state.user) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(endSession, state.idleTimeoutMs);
  };
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(event =>
    document.addEventListener(event, resetTimer, { passive: true })
  );
})();
