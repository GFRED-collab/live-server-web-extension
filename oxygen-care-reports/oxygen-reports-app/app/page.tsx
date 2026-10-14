'use client';

import './filter.css';
import { ChangeEvent, FormEvent, useMemo, useState } from 'react';

type Role = 'Department Head' | 'Department User' | 'Engineer' | 'Warehouse User' | 'Super User';
type ColumnAccess = { read: boolean; write: boolean };
type Account = { id: number; name: string; email: string; department: string; role: Role; status: 'Active'; permissions: Record<string, ColumnAccess>; canExport: boolean };
type FieldType = 'text' | 'comments' | 'checkbox';
type DemoIdentity = { id: number | null; name: string; role: Role };
type UploadedReport = { id: number; clientName: string; fileName: string; userIds: number[]; rowIds: number[]; uploadedAt: string };
type ActivityEntry = { id: number; time: string; action: string; detail: string };
type SparePart = { id: number; partNumber: string; name: string; warehouseQty: number };
type StockMovement = { id: number; time: string; type: 'Assigned' | 'Fitted'; partId: number; engineerId: number; quantity: number; detail: string };
type ReportRow = {
  id: number;
  deviceName: string;
  serialNumber: string;
  lotNumber: string;
  assetNumber: string;
  hoursIn: string;
  hoursOut: string;
  comments: string;
  extra: Record<string, string>;
  ownerIds: number[];
  reportId: number;
};

const departments = ['Engineering', 'Sales', 'Warehouse', 'In-House', 'Marketing'];
const roles: Role[] = ['Department Head', 'Department User', 'Engineer', 'Warehouse User', 'Super User'];
const requiredColumns = ['Device/Machine Name', 'Serial Number', 'Lot Number', 'Asset Number', 'Amount in Hours', 'Amount out of Hours', 'Comments'];
const defaultPermissions = (): Record<string, ColumnAccess> => Object.fromEntries(requiredColumns.map((field) => [field, { read: true, write: false }]));
const starterRows: ReportRow[] = [
  { id: 1, deviceName: 'Oxygen Concentrator OC-5', serialNumber: 'OC5-IE-1048', lotNumber: 'LOT-24-091', assetNumber: 'AST-00471', hoursIn: '08:15', hoursOut: '16:30', comments: 'Routine service completed.', extra: {}, ownerIds: [1], reportId: 0 },
  { id: 2, deviceName: 'Portable Regulator PR-2', serialNumber: 'PR2-IE-0187', lotNumber: 'LOT-24-108', assetNumber: 'AST-00506', hoursIn: '09:00', hoursOut: '12:45', comments: 'Returned from field inspection.', extra: {}, ownerIds: [2], reportId: 0 },
];
const startingAccounts: Account[] = [
  { id: 1, name: 'Aoife Byrne', email: 'aoife.byrne@oxygencare.ie', department: 'Engineering', role: 'Engineer', status: 'Active', permissions: defaultPermissions(), canExport: true },
  { id: 2, name: 'James Kelly', email: 'james.kelly@oxygencare.ie', department: 'Sales', role: 'Department User', status: 'Active', permissions: defaultPermissions(), canExport: false },
  { id: 3, name: 'Eoin Murphy', email: 'eoin.murphy@oxygencare.ie', department: 'Warehouse', role: 'Warehouse User', status: 'Active', permissions: defaultPermissions(), canExport: false },
];
const starterParts: SparePart[] = [
  { id: 1, partNumber: 'SP-OC5-FLT', name: 'OC-5 Intake Filter', warehouseQty: 24 },
  { id: 2, partNumber: 'SP-PR2-REG', name: 'PR-2 Regulator Assembly', warehouseQty: 10 },
  { id: 3, partNumber: 'SP-OC5-TUB', name: 'OC-5 Tubing Kit', warehouseQty: 36 },
];
const demoTotpSecret = 'JBSWY3DPEHPK3PXP';

function base32Bytes(value: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', output: number[] = [];
  for (const character of value.replace(/\s|=/g, '').toUpperCase()) bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  for (let index = 0; index + 8 <= bits.length; index += 8) output.push(parseInt(bits.slice(index, index + 8), 2));
  return new Uint8Array(output);
}

async function currentTotp(counter: number) {
  const key = await crypto.subtle.importKey('raw', base32Bytes(demoTotpSecret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const bytes = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) { bytes[index] = remaining % 256; remaining = Math.floor(remaining / 256); }
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  const offset = signed[signed.length - 1] & 15;
  const value = ((signed[offset] & 127) << 24) | (signed[offset + 1] << 16) | (signed[offset + 2] << 8) | signed[offset + 3];
  return String(value % 1000000).padStart(6, '0');
}

function headerKey(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_/-]+/g, '');
}

function cell(row: Record<string, unknown>, label: string) {
  const expected = headerKey(label);
  const key = Object.keys(row).find((entry) => headerKey(entry) === expected);
  return String(key ? row[key] ?? '' : '').trim();
}

function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(value); value = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value); if (row.some((entry) => entry.trim())) rows.push(row); row = []; value = '';
    } else value += character;
  }
  row.push(value); if (row.some((entry) => entry.trim())) rows.push(row);
  const [headers = [], ...data] = rows;
  return data.map((items) => Object.fromEntries(headers.map((header, index) => [header.replace(/^\uFEFF/, ''), items[index] ?? ''])));
}

async function unzipEntry(buffer: ArrayBuffer, name: string): Promise<string | null> {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), decoder = new TextDecoder();
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('Invalid workbook');
  let pointer = view.getUint32(end + 16, true);
  const entries = view.getUint16(end + 10, true);
  for (let count = 0; count < entries; count += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) throw new Error('Invalid workbook');
    const compression = view.getUint16(pointer + 10, true), compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true), extraLength = view.getUint16(pointer + 30, true), commentLength = view.getUint16(pointer + 32, true);
    const entryName = decoder.decode(bytes.slice(pointer + 46, pointer + 46 + nameLength));
    const localOffset = view.getUint32(pointer + 42, true);
    if (entryName === name) {
      const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
      const data = bytes.slice(localOffset + 30 + localNameLength + localExtraLength, localOffset + 30 + localNameLength + localExtraLength + compressedSize);
      if (compression === 0) return decoder.decode(data);
      if (compression === 8 && typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return decoder.decode(await new Response(stream).arrayBuffer());
      }
      throw new Error('Unsupported workbook compression');
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function columnIndex(reference: string) {
  return reference.replace(/\d/g, '').split('').reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

async function parseXlsx(buffer: ArrayBuffer): Promise<Record<string, unknown>[]> {
  const workbook = await unzipEntry(buffer, 'xl/workbook.xml');
  if (!workbook) throw new Error('No workbook');
  const sheetMatch = workbook.match(/<sheet[^>]*r:id="([^"/]+)"[^>]*>/);
  const relationships = await unzipEntry(buffer, 'xl/_rels/workbook.xml.rels');
  const relationship = sheetMatch && relationships?.match(new RegExp(`<Relationship[^>]*Id="${sheetMatch[1]}"[^>]*Target="([^"]+)"`));
  const target = relationship?.[1]?.replace(/^\//, '') || 'worksheets/sheet1.xml';
  const sheet = await unzipEntry(buffer, `xl/${target.replace(/^xl\//, '')}`);
  if (!sheet) throw new Error('No worksheet');
  const sharedXml = await unzipEntry(buffer, 'xl/sharedStrings.xml');
  const xml = new DOMParser();
  const shared = sharedXml ? Array.from(xml.parseFromString(sharedXml, 'application/xml').querySelectorAll('si')).map((item) => item.textContent || '') : [];
  const rows = Array.from(xml.parseFromString(sheet, 'application/xml').querySelectorAll('sheetData > row')).map((sheetRow) => {
    const output: string[] = [];
    sheetRow.querySelectorAll('c').forEach((cellElement) => {
      const index = columnIndex(cellElement.getAttribute('r') || 'A1');
      const type = cellElement.getAttribute('t');
      const raw = cellElement.querySelector('v')?.textContent || '';
      output[index] = type === 's' ? shared[Number(raw)] || '' : type === 'inlineStr' ? cellElement.querySelector('is')?.textContent || '' : raw;
    });
    return output;
  });
  const [headers = [], ...data] = rows;
  return data.map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] ?? ''])));
}

export default function HomePage() {
  const [signedIn, setSignedIn] = useState(false);
  const [activeIdentity, setActiveIdentity] = useState<DemoIdentity | null>(null);
  const [pendingIdentity, setPendingIdentity] = useState<DemoIdentity | null>(null);
  const [accounts, setAccounts] = useState(startingAccounts);
  const [records, setRecords] = useState(starterRows);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [customFields, setCustomFields] = useState<string[]>([]);
  const [columnOrder, setColumnOrder] = useState(requiredColumns);
  const [draggedField, setDraggedField] = useState<string | null>(null);
  const [fieldTypes, setFieldTypes] = useState<Record<string, FieldType>>({});
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [accessAccountId, setAccessAccountId] = useState<number | null>(null);
  const [dashboardPage, setDashboardPage] = useState<'dashboard' | 'access' | 'spare-parts' | 'report' | 'edit-user'>('dashboard');
  const [activeReportId, setActiveReportId] = useState<number | null>(null);
  const [clientName, setClientName] = useState('');
  const [importUserIds, setImportUserIds] = useState<number[]>([1]);
  const [uploads, setUploads] = useState<UploadedReport[]>([]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [userFilter, setUserFilter] = useState('');
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [parts, setParts] = useState(starterParts);
  const [engineerStock, setEngineerStock] = useState<Record<string, number>>({});
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [loginStep, setLoginStep] = useState<'credentials' | 'mfa' | 'reset-email' | 'reset-mfa' | 'reset-password'>('credentials');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [resetNotice, setResetNotice] = useState('');

  const totalHours = useMemo(() => records.reduce((total, record) => total + (record.hoursOut ? 1 : 0), 0), [records]);
  const reportFields = columnOrder;
  const editingAccount = accounts.find((account) => account.id === editingAccountId);
  const accessAccount = accounts.find((account) => account.id === accessAccountId);
  const activeReport = uploads.find((report) => report.id === activeReportId);
  const engineers = accounts.filter((account) => account.role === 'Engineer');
  const assignedRecords = activeIdentity?.id === null ? records : records.filter((record) => activeIdentity ? record.ownerIds.includes(activeIdentity.id as number) : false);
  const stockKey = (engineerId: number, partId: number) => `${engineerId}:${partId}`;
  const assignedReports = activeIdentity?.id === null ? uploads : uploads.filter((report) => activeIdentity ? report.userIds.includes(activeIdentity.id as number) : false);
  const personalStock = activeIdentity?.role === 'Engineer' && activeIdentity.id !== null
    ? parts.filter((part) => (engineerStock[stockKey(activeIdentity.id as number, part.id)] || 0) > 0)
    : [];
  const recordValue = (record: ReportRow, field: string) => {
    const values: Record<string, string> = {
      'Device/Machine Name': record.deviceName,
      'Serial Number': record.serialNumber,
      'Lot Number': record.lotNumber,
      'Asset Number': record.assetNumber,
      'Amount in Hours': record.hoursIn,
      'Amount out of Hours': record.hoursOut,
      Comments: record.comments,
    };
    return values[field] ?? record.extra[field] ?? '';
  };
  const filteredRecords = useMemo(() => records.filter((record) => {
    if (userFilter && !record.ownerIds.includes(Number(userFilter))) return false;
    return reportFields.every((field) => !filters[field] || recordValue(record, field).toLowerCase().includes(filters[field].toLowerCase()));
  }), [records, reportFields, filters, userFilter]);

  function logActivity(action: string, detail: string) {
    setActivity((current) => [{ id: Date.now() + current.length, time: new Date().toLocaleString(), action, detail }, ...current].slice(0, 100));
  }

  function assignStock(partId: number, engineerId: number, quantity: number) {
    const part = parts.find((item) => item.id === partId);
    const engineer = accounts.find((account) => account.id === engineerId);
    if (!part || !engineer || !Number.isInteger(quantity) || quantity < 1) { setError('Choose a spare part, engineer and whole quantity.'); return; }
    if (quantity > part.warehouseQty) { setError(`Only ${part.warehouseQty} ${part.name} available in warehouse stock.`); return; }
    setParts((current) => current.map((item) => item.id === partId ? { ...item, warehouseQty: item.warehouseQty - quantity } : item));
    setEngineerStock((current) => ({ ...current, [stockKey(engineerId, partId)]: (current[stockKey(engineerId, partId)] || 0) + quantity }));
    setStockMovements((current) => [{ id: Date.now(), time: new Date().toLocaleString(), type: 'Assigned', partId, engineerId, quantity, detail: 'Warehouse allocation' }, ...current]);
    setError(''); setNotice(`${quantity} × ${part.name} assigned to ${engineer.name}.`);
    logActivity('Part assigned', `${quantity} × ${part.partNumber} assigned from warehouse to ${engineer.name}.`);
  }

  function assignPart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    assignStock(Number(values.get('partId')), Number(values.get('engineerId')), Number(values.get('quantity')));
    event.currentTarget.reset();
  }

  function fitStock(partId: number, engineerId: number, quantity: number, device: string) {
    const part = parts.find((item) => item.id === partId);
    const engineer = accounts.find((account) => account.id === engineerId);
    const available = engineerStock[stockKey(engineerId, partId)] || 0;
    if (!part || !engineer || !device || !Number.isInteger(quantity) || quantity < 1) { setError('Choose an engineer, part, quantity and device/machine.'); return; }
    if (quantity > available) { setError(`${engineer.name} has only ${available} ${part.name} in personal stock.`); return; }
    setEngineerStock((current) => ({ ...current, [stockKey(engineerId, partId)]: available - quantity }));
    setStockMovements((current) => [{ id: Date.now(), time: new Date().toLocaleString(), type: 'Fitted', partId, engineerId, quantity, detail: `Fitted to ${device}` }, ...current]);
    setError(''); setNotice(`${quantity} × ${part.name} recorded as fitted to ${device}; stock removed from ${engineer.name}.`);
    logActivity('Part fitted', `${engineer.name} fitted ${quantity} × ${part.partNumber} to ${device}.`);
  }

  function fitPart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    fitStock(Number(values.get('partId')), Number(values.get('engineerId')), Number(values.get('quantity')), String(values.get('device') || '').trim());
    event.currentTarget.reset();
  }

  function fitOwnPart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeIdentity || activeIdentity.role !== 'Engineer' || activeIdentity.id === null) return;
    const values = new FormData(event.currentTarget);
    fitStock(Number(values.get('partId')), activeIdentity.id, Number(values.get('quantity')), String(values.get('device') || '').trim());
    event.currentTarget.reset();
  }

  async function importWarehouseStock(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx'].includes(extension || '')) {
      setError('Choose a CSV or Excel workbook (.xlsx) for warehouse stock.');
      return;
    }
    try {
      const rawRows = extension === 'csv' ? parseCsv(await file.text()) : await parseXlsx(await file.arrayBuffer());
      const valueFrom = (row: Record<string, unknown>, names: string[]) => names.map((name) => cell(row, name)).find((value) => value !== '') || '';
      const imported = rawRows.map((row, index) => {
        const partNumber = valueFrom(row, ['Part Number', 'Part No', 'Part #']);
        const name = valueFrom(row, ['Part Name', 'Name', 'Description']);
        const quantityText = valueFrom(row, ['Warehouse Quantity', 'Warehouse Stock', 'Quantity', 'Stock']);
        const warehouseQty = Number(quantityText.replace(/,/g, ''));
        if (!partNumber || !name || !Number.isInteger(warehouseQty) || warehouseQty < 0) {
          throw new Error(`Row ${index + 2} needs Part Number, Part Name and a whole-number Warehouse Quantity.`);
        }
        return { partNumber, name, warehouseQty };
      });
      if (!imported.length) throw new Error('The selected file does not contain any stock rows.');
      let added = 0;
      let updated = 0;
      setParts((current) => {
        const existing = new Map(current.map((part) => [part.partNumber.trim().toLowerCase(), part]));
        const next = [...current];
        imported.forEach((entry, index) => {
          const key = entry.partNumber.trim().toLowerCase();
          const match = existing.get(key);
          if (match) {
            const position = next.findIndex((part) => part.id === match.id);
            next[position] = { ...match, partNumber: entry.partNumber, name: entry.name, warehouseQty: entry.warehouseQty };
            existing.set(key, next[position]);
            updated += 1;
          } else {
            const part = { id: Date.now() + index, ...entry };
            next.push(part);
            existing.set(key, part);
            added += 1;
          }
        });
        return next;
      });
      setError('');
      setNotice(`${file.name} imported: ${added} new part${added === 1 ? '' : 's'} and ${updated} updated balance${updated === 1 ? '' : 's'}.`);
      logActivity('Warehouse stock uploaded', `${file.name}: ${imported.length} stock row${imported.length === 1 ? '' : 's'} processed.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This stock file could not be read. Export it as CSV or a standard .xlsx workbook and try again.');
    }
  }

  function beginLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') || '').trim().toLowerCase();
    const account = accounts.find((item) => item.email.toLowerCase() === email);
    const identity = account
      ? { id: account.id, name: account.name, role: account.role }
      : email === 'admin@oxygencare.ie' ? { id: null, name: 'Super User', role: 'Super User' as Role } : null;
    if (!identity) { setMfaError('This email does not match a demo account. Use an account in Department Logins, or admin@oxygencare.ie for Super User access.'); return; }
    setPendingIdentity(identity);
    setMfaError('');
    setLoginStep('mfa');
  }

  async function verifyMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const counter = Math.floor(Date.now() / 30000);
    const validCodes = await Promise.all([counter - 1, counter, counter + 1].map(currentTotp));
    if (!validCodes.includes(mfaCode.replace(/\s/g, ''))) { setMfaError('That verification code is not valid. Please try the current Microsoft Authenticator code.'); return; }
    if (!pendingIdentity) { setMfaError('Return to login and enter an account email first.'); return; }
    setMfaError('');
    setSignedIn(true);
    setActiveIdentity(pendingIdentity);
    setLoginStep('credentials');
    setMfaCode('');
    logActivity('MFA verified', `${pendingIdentity.name} signed in as ${pendingIdentity.role}.`);
  }

  async function verifyResetMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const counter = Math.floor(Date.now() / 30000);
    const validCodes = await Promise.all([counter - 1, counter, counter + 1].map(currentTotp));
    if (!validCodes.includes(mfaCode.replace(/\s/g, ''))) { setMfaError('That verification code is not valid.'); return; }
    setMfaError(''); setMfaCode(''); setLoginStep('reset-password');
  }

  function submitPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const password = String(values.get('password') || '');
    const confirmation = String(values.get('confirmPassword') || '');
    if (password.length < 12) { setMfaError('Use at least 12 characters for the new password.'); return; }
    if (password !== confirmation) { setMfaError('The new passwords do not match.'); return; }
    setResetNotice(`Password reset completed for ${resetEmail}. You can now sign in.`);
    setLoginStep('credentials'); setMfaError('');
  }

  function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name') || '').trim();
    const email = String(values.get('email') || '').trim().toLowerCase();
    const department = String(values.get('department') || '');
    const role = String(values.get('role') || '') as Role;
    if (!name || !email || !department || !role) return;
    const permissions = Object.fromEntries(reportFields.map((field) => {
      const write = values.has(`write:${field}`);
      return [field, { read: write || values.has(`read:${field}`), write }];
    }));
    setAccounts((current) => [...current, { id: Date.now(), name, email, department, role, status: 'Active', permissions, canExport: values.has('canExport') }]);
    setNotice(`Login created for ${name}.`);
    logActivity('User created', `${name} added as ${role} in ${department}.`);
    event.currentTarget.reset();
  }

  function updatePermission(accountId: number, field: string, permission: keyof ColumnAccess, enabled: boolean) {
    setAccounts((current) => current.map((account) => {
      if (account.id !== accountId) return account;
      const currentAccess = account.permissions[field] || { read: false, write: false };
      const nextAccess = permission === 'write'
        ? { read: enabled || currentAccess.read, write: enabled }
        : { read: enabled, write: enabled ? currentAccess.write : false };
      return { ...account, permissions: { ...account.permissions, [field]: nextAccess } };
    }));
    logActivity('Column permission changed', `${accounts.find((account) => account.id === accountId)?.name || 'User'}: ${permission} ${enabled ? 'enabled' : 'removed'} for ${field}.`);
  }

  function updateExportAccess(accountId: number, canExport: boolean) {
    setAccounts((current) => current.map((account) => account.id === accountId ? { ...account, canExport } : account));
    logActivity('Export permission changed', `${accounts.find((account) => account.id === accountId)?.name || 'User'}: export ${canExport ? 'enabled' : 'removed'}.`);
  }

  function saveAccountEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingAccount) return;
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name') || '').trim();
    const email = String(values.get('email') || '').trim().toLowerCase();
    const department = String(values.get('department') || '');
    const role = String(values.get('role') || '') as Role;
    if (!name || !email || !department || !role) return;
    setAccounts((current) => current.map((account) => account.id === editingAccount.id ? { ...account, name, email, department, role, canExport: values.has('canExport') } : account));
    setEditingAccountId(null); setDashboardPage('dashboard'); setNotice(`${name}'s user profile was updated.`);
    logActivity('User edited', `${name}'s profile and role were updated.`);
  }

  function openUserEdit(account: Account) {
    setEditingAccountId(account.id);
    setDashboardPage('edit-user');
    logActivity('User edit opened', `Opened ${account.name}'s profile for editing.`);
  }

  function deleteAccount(account: Account) {
    if (!window.confirm(`Delete ${account.name}? This cannot be undone in the current demo session.`)) return;
    setAccounts((current) => current.filter((item) => item.id !== account.id));
    setRecords((current) => current.map((record) => ({ ...record, ownerIds: record.ownerIds.filter((id) => id !== account.id) })));
    setImportUserIds((current) => current.filter((id) => id !== account.id));
    setEditingAccountId(null); setNotice(`${account.name} was deleted.`);
    logActivity('User deleted', `${account.name} was deleted from the workspace.`);
  }

  function openAccessTab(account: Account) {
    setAccessAccountId(account.id);
    setDashboardPage('access');
    logActivity('Access screen opened', `Opened column access for ${account.name}.`);
  }

  function openSparePartsControl() {
    setDashboardPage('spare-parts');
    logActivity('Spare parts screen opened', 'Opened the warehouse-to-engineer stock control screen.');
  }
  function addCustomField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const fieldName = String(values.get('fieldName') || '').trim().replace(/\s+/g, ' ');
    const fieldType = String(values.get('fieldType') || 'text') as FieldType;
    if (!fieldName) return;
    if ([...requiredColumns, ...customFields].some((field) => headerKey(field) === headerKey(fieldName))) {
      setError('That field already exists in the report layout.');
      return;
    }
    setError('');
    setCustomFields((fields) => [...fields, fieldName]);
    setColumnOrder((fields) => [...fields, fieldName]);
    setFieldTypes((types) => ({ ...types, [fieldName]: fieldType }));
    const initialValue = fieldType === 'checkbox' ? 'false' : '';
    setRecords((current) => current.map((record) => ({ ...record, extra: { ...record.extra, [fieldName]: record.extra[fieldName] ?? initialValue } })));
    setAccounts((current) => current.map((account) => ({ ...account, permissions: { ...account.permissions, [fieldName]: account.permissions[fieldName] ?? { read: true, write: false } } })));
    setNotice(`“${fieldName}” was added to all existing client device lists${fieldType === 'checkbox' ? ' as unchecked' : ''}.`);
    logActivity('Field added', `${fieldName} added to all existing client device lists as a ${fieldType} field.`);
    form.reset();
  }

  function moveColumn(target: string) {
    if (!draggedField || draggedField === target) return;
    setColumnOrder((fields) => {
      const next = fields.filter((field) => field !== draggedField);
      next.splice(next.indexOf(target), 0, draggedField);
      return next;
    });
    setDraggedField(null);
    logActivity('Columns rearranged', `${draggedField} moved before ${target}.`);
  }

  function deleteColumn(field: string) {
    setColumnOrder((fields) => fields.filter((item) => item !== field));
    setFilters((current) => { const next = { ...current }; delete next[field]; return next; });
    if (customFields.includes(field)) {
      setCustomFields((fields) => fields.filter((item) => item !== field));
      setFieldTypes((types) => { const next = { ...types }; delete next[field]; return next; });
    }
    logActivity('Column deleted', `${field} removed from the report layout.`);
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setNotice('');
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx'].includes(extension || '')) {
      setError('Choose a CSV or Excel workbook (.xlsx). Legacy .xls files should be saved as .xlsx first.');
      return;
    }
    if (!clientName.trim()) { setError('Enter the client name before uploading a device list.'); return; }
    try {
      const rawRows = extension === 'csv' ? parseCsv(await file.text()) : await parseXlsx(await file.arrayBuffer());
      const headers = rawRows.length ? Object.keys(rawRows[0]) : [];
      const recognisedColumns = reportFields.filter((column) => headers.some((header) => headerKey(header) === headerKey(column)));
      if (!recognisedColumns.length) {
        setError('Import not added. No recognised device-list column names were found. Include at least one matching column name to continue.');
        return;
      }
      if (!importUserIds.length) { setError('Select at least one user before uploading a report.'); return; }
      const reportId = Date.now();
      const imported = rawRows
        .filter((row) => Object.values(row).some((value) => String(value).trim()))
        .map((row, index): ReportRow => ({
          id: reportId + index,
          deviceName: cell(row, 'Device/Machine Name'),
          serialNumber: cell(row, 'Serial Number'),
          lotNumber: cell(row, 'Lot Number'),
          assetNumber: cell(row, 'Asset Number'),
          hoursIn: cell(row, 'Amount in Hours'),
          hoursOut: cell(row, 'Amount out of Hours'),
          comments: cell(row, 'Comments'),
          extra: Object.fromEntries(customFields.map((field) => [field, cell(row, field)])),
          ownerIds: importUserIds,
          reportId,
        }));
      if (!imported.length) {
        setError('The selected file does not contain any data rows.');
        return;
      }
      setRecords((current) => [...current, ...imported]);
      setUploads((current) => [...current, { id: reportId, clientName: clientName.trim(), fileName: file.name, userIds: importUserIds, rowIds: imported.map((row) => row.id), uploadedAt: new Date().toLocaleString() }]);
      setFileName(file.name);
      setClientName('');
      const missingColumns = reportFields.filter((column) => !recognisedColumns.includes(column));
      setNotice(`${imported.length} record${imported.length === 1 ? '' : 's'} imported for ${clientName.trim()}${missingColumns.length ? `; ${missingColumns.length} missing column${missingColumns.length === 1 ? '' : 's'} left blank.` : '.'}`);
      logActivity('Client device list uploaded', `${clientName.trim()}: ${file.name}, ${imported.length} records assigned to ${accounts.filter((account) => importUserIds.includes(account.id)).map((account) => account.name).join(', ')}.`);
    } catch {
        setError('This file could not be read. Please export it as CSV or a standard .xlsx Excel workbook and try again.');
    }
  }

  function openReport(report: UploadedReport) {
    setActiveReportId(report.id);
    setDashboardPage('report');
    logActivity('Client device list opened', `${report.clientName}: ${report.fileName}`);
  }

  function updateRecordValue(recordId: number, field: string, value: string) {
    const standardField: Record<string, keyof Pick<ReportRow, 'deviceName' | 'serialNumber' | 'lotNumber' | 'assetNumber' | 'hoursIn' | 'hoursOut' | 'comments'>> = {
      'Device/Machine Name': 'deviceName', 'Serial Number': 'serialNumber', 'Lot Number': 'lotNumber', 'Asset Number': 'assetNumber', 'Amount in Hours': 'hoursIn', 'Amount out of Hours': 'hoursOut', Comments: 'comments',
    };
    setRecords((current) => current.map((record) => {
      if (record.id !== recordId) return record;
      const key = standardField[field];
      return key ? { ...record, [key]: value } : { ...record, extra: { ...record.extra, [field]: value } };
    }));
  }

  function toggleReportUser(reportId: number, userId: number, enabled: boolean) {
    setUploads((current) => current.map((report) => report.id !== reportId ? report : { ...report, userIds: enabled ? [...new Set([...report.userIds, userId])] : report.userIds.filter((id) => id !== userId) }));
    setRecords((current) => current.map((record) => record.reportId !== reportId ? record : { ...record, ownerIds: enabled ? [...new Set([...record.ownerIds, userId])] : record.ownerIds.filter((id) => id !== userId) }));
  }

  function exportCsv() {
    const columns = ['Users', ...reportFields];
    const quoted = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const content = [columns, ...filteredRecords.map((record) => [accounts.filter((account) => record.ownerIds.includes(account.id)).map((account) => account.name).join(', '), ...reportFields.map((field) => recordValue(record, field))])].map((row) => row.map((value) => quoted(value || '')).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    link.download = 'oxygen-care-filtered-report.csv';
    link.click();
    URL.revokeObjectURL(link.href);
    logActivity('CSV exported', `${filteredRecords.length} filtered records exported.`);
  }

  function exportPdf() {
    const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character));
    const popup = window.open('', '_blank');
    if (!popup) { setError('Your browser blocked the PDF window. Please allow pop-ups for this preview.'); return; }
    const headings = ['Users', ...reportFields];
    const rows = filteredRecords.map((record) => [accounts.filter((account) => record.ownerIds.includes(account.id)).map((account) => account.name).join(', '), ...reportFields.map((field) => recordValue(record, field))]);
    popup.document.write(`<!doctype html><title>Oxygen Care filtered report</title><style>body{font-family:Arial,sans-serif;color:#183f4b;padding:28px}h1{margin:0}p{color:#63818a}table{width:100%;border-collapse:collapse;margin-top:20px;font-size:12px}th,td{padding:8px;border-bottom:1px solid #cfeaf2;text-align:left;vertical-align:top}th{color:#277b91}@media print{body{padding:0}}</style><h1>Oxygen Care Reports</h1><p>Filtered report · ${filteredRecords.length} records · ${new Date().toLocaleDateString()}</p><table><thead><tr>${headings.map((heading) => `<th>${escape(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escape(value || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table><script>window.onload=()=>window.print()<\/script>`);
    popup.document.close();
    logActivity('PDF export opened', `${filteredRecords.length} filtered records prepared for PDF.`);
  }

  if (signedIn && activeIdentity && activeIdentity.role !== 'Super User' && dashboardPage === 'report' && activeReport) return (
    <main className="workspace-shell subpage-shell">
      <header className="workspace-header"><a className="brand" href="#top"><img src="/oxygen-care-logo-supplied.jpeg" alt="Oxygen Care" /><span>Reports<small>CLIENT DEVICE LIST</small></span></a><button className="back-page" onClick={() => setDashboardPage('dashboard')}>← Back to my clients</button></header>
      <section className="directory standalone-card"><div className="directory-heading"><div><p className="eyebrow">CLIENT DEVICE LIST</p><h1>{activeReport.clientName}</h1><p className="muted">Select a device record to review its details.</p></div><span>{assignedRecords.filter((record) => record.reportId === activeReport.id).length} devices</span></div><div className="table-wrap"><table><thead><tr>{reportFields.map((field) => <th key={field}>{field}</th>)}</tr></thead><tbody>{assignedRecords.filter((record) => record.reportId === activeReport.id).map((record) => <tr key={record.id}>{reportFields.map((field) => <td key={field} className={field === 'Comments' || fieldTypes[field] === 'comments' ? 'comments' : ''}>{fieldTypes[field] === 'checkbox' ? (['true', 'yes', '1', 'checked'].includes(recordValue(record, field).toLowerCase()) ? '✓' : '—') : (recordValue(record, field) || '—')}</td>)}</tr>)}</tbody></table></div></section>
    </main>
  );

  if (signedIn && activeIdentity && activeIdentity.role !== 'Super User') return (
    <main className="workspace-shell">
      <header className="workspace-header"><a className="brand" href="#top"><img src="/oxygen-care-logo-supplied.jpeg" alt="Oxygen Care" /><span>Reports<small>MY WORKSPACE</small></span></a><div className="account-chip"><span className="avatar">{activeIdentity.name.split(' ').map((name) => name[0]).join('').slice(0, 2)}</span><span>{activeIdentity.name} · {activeIdentity.role}</span><button onClick={() => { setSignedIn(false); setActiveIdentity(null); setPendingIdentity(null); }}>Log out</button></div></header>
      <section className="workspace-hero" id="top"><div><p className="eyebrow">MY ASSIGNED CLIENTS</p><h1>Your client device lists.</h1><p>Choose a client to view only the devices assigned to your account.</p></div><div className="hero-stat"><strong>{assignedReports.length}</strong><span>assigned clients</span></div></section>
      <section className="uploads-card"><p className="eyebrow">CLIENTS</p><h2>Open a client device list</h2><div>{assignedReports.length ? assignedReports.map((report) => <button key={report.id} className="report-link" onClick={() => openReport(report)}><span><strong>{report.clientName}</strong></span><b>Open devices →</b></button>) : <p className="muted">No client device lists are currently assigned to this account.</p>}</div></section>
      {activeIdentity.role === 'Engineer' && <section className="inventory-panel"><div><p className="eyebrow">MY SPARE PARTS STOCK</p><h2>Engineer stock</h2><p className="muted">Parts assigned to you by Warehouse. Record a fitting when a part is used.</p></div>{(notice || error) && <p className={error ? 'message error' : 'message success'} role="status">{error || notice}</p>}<div className="inventory-grid"><div className="stock-tables"><div><h3>My current stock</h3>{personalStock.length ? personalStock.map((part) => <p key={part.id}><strong>{part.partNumber}</strong><span>{part.name}</span><b>{engineerStock[stockKey(activeIdentity.id as number, part.id)]}</b></p>) : <p className="muted">No spare parts are currently assigned to you.</p>}</div></div><form onSubmit={fitOwnPart} className="inventory-form"><h3>Record fitted part</h3><label>PART<select name="partId" required defaultValue=""><option value="" disabled>Select assigned part</option>{personalStock.map((part) => <option key={part.id} value={part.id}>{part.partNumber} — {part.name} ({engineerStock[stockKey(activeIdentity.id as number, part.id)]} available)</option>)}</select></label><label>DEVICE / MACHINE<input name="device" placeholder="e.g. Oxygen Concentrator OC-5" required /></label><label>QUANTITY<input name="quantity" type="number" min="1" step="1" required /></label><button type="submit">Record fitting</button></form></div></section>}
    </main>
  );

  if (signedIn && dashboardPage === 'edit-user' && editingAccount) return (
    <main className="workspace-shell subpage-shell">
      <header className="workspace-header"><a className="brand" href="#top"><img src="/oxygen-care-logo-supplied.jpeg" alt="Oxygen Care" /><span>Reports<small>USER PROFILE</small></span></a><button className="back-page" onClick={() => { setEditingAccountId(null); setDashboardPage('dashboard'); }}>← Back to users</button></header>
      <section className="access-card standalone-card"><div className="directory-heading"><div><p className="eyebrow">EDIT USER</p><h1>{editingAccount.name}</h1><p className="muted">Update this user’s profile and role. Column permissions remain under Manage access.</p></div></div><form className="edit-user-form" onSubmit={saveAccountEdit}><label>FULL NAME<input name="name" defaultValue={editingAccount.name} required /></label><label>WORK EMAIL<input name="email" type="email" defaultValue={editingAccount.email} required /></label><label>DEPARTMENT<select name="department" defaultValue={editingAccount.department}>{departments.map((department) => <option key={department}>{department}</option>)}</select></label><label>ROLE<select name="role" defaultValue={editingAccount.role}>{roles.map((role) => <option key={role}>{role}</option>)}</select></label><label className="export-permission"><input name="canExport" type="checkbox" defaultChecked={Boolean(editingAccount.canExport)} /> Allow filtered CSV and PDF exports</label><button type="submit">Save user changes</button></form></section>
    </main>
  );

  if (signedIn && dashboardPage === 'report' && activeReport) return (
    <main className="workspace-shell subpage-shell">
      <header className="workspace-header"><a className="brand" href="#top"><img src="/oxygen-care-logo-supplied.jpeg" alt="Oxygen Care" /><span>Reports<small>CLIENT DEVICE LIST</small></span></a><button className="back-page" onClick={() => setDashboardPage('dashboard')}>← Back to reports</button></header>
      <section className="directory report-editor standalone-card">
        <div className="directory-heading"><div><p className="eyebrow">CLIENT DEVICE LIST</p><h1>{activeReport.clientName}</h1><p className="muted">{activeReport.fileName} · uploaded {activeReport.uploadedAt}. Review and edit the device records below.</p></div><span>{records.filter((record) => record.reportId === activeReport.id).length} devices</span></div>
        <fieldset className="report-users review-users"><legend>Assigned users</legend>{accounts.map((account) => <label key={account.id}><input type="checkbox" checked={activeReport.userIds.includes(account.id)} onChange={(event) => toggleReportUser(activeReport.id, account.id, event.target.checked)} /> {account.name} <small>{account.role}</small></label>)}</fieldset>
        <div className="table-wrap"><table><thead><tr><th>Assigned to</th>{reportFields.map((field) => <th key={field}>{field}</th>)}</tr></thead><tbody>{records.filter((record) => record.reportId === activeReport.id).map((record) => <tr key={record.id}><td>{accounts.filter((account) => record.ownerIds.includes(account.id)).map((account) => account.name).join(', ') || '—'}</td>{reportFields.map((field) => <td key={field} className={field === 'Comments' || fieldTypes[field] === 'comments' ? 'comments' : ''}>{fieldTypes[field] === 'checkbox' ? <input aria-label={`${field} for device ${record.deviceName}`} type="checkbox" checked={['true', 'yes', '1', 'checked'].includes(recordValue(record, field).toLowerCase())} onChange={(event) => updateRecordValue(record.id, field, event.target.checked ? 'true' : 'false')} /> : <input aria-label={`${field} for device ${record.deviceName}`} value={recordValue(record, field)} onChange={(event) => updateRecordValue(record.id, field, event.target.value)} />}</td>)}</tr>)}</tbody></table></div>
      </section>
    </main>
  );

  if (signedIn && dashboardPage === 'access' && accessAccount) return (
    <main className="workspace-shell subpage-shell">
      <header className="workspace-header"><a className="brand" href="#top"><img src="/oxygen-care-logo-supplied.jpeg" alt="Oxygen Care" /><span>Reports<small>SUPER USER WORKSPACE</small></span></a><button className="back-page" onClick={() => setDashboardPage('dashboard')}>← Back to dashboard</button></header>
      <section className="access-card standalone-card">
        <p className="eyebrow">COLUMN PERMISSIONS</p><h1>Manage access: {accessAccount.name}</h1><p className="muted">Choose which report columns this user can read or write.</p>
        <label className="export-permission"><input type="checkbox" checked={Boolean(accessAccount.canExport)} onChange={(event) => updateExportAccess(accessAccount.id, event.target.checked)} /> Allow filtered CSV and PDF exports</label>
        <div className="access-grid">{reportFields.map((field) => { const access = accessAccount.permissions[field] || { read: false, write: false }; return <div key={field}><strong>{field}</strong><label><input type="checkbox" checked={Boolean(access.read)} onChange={(event) => updatePermission(accessAccount.id, field, 'read', event.target.checked)} /> Read</label><label><input type="checkbox" checked={Boolean(access.write)} onChange={(event) => updatePermission(accessAccount.id, field, 'write', event.target.checked)} /> Write</label></div>; })}</div>
      </section>
    </main>
  );

  if (signedIn && dashboardPage === 'spare-parts') return (
    <main className="workspace-shell subpage-shell">
      <header className="workspace-header"><a className="brand" href="#top"><img src="/oxygen-care-logo-supplied.jpeg" alt="Oxygen Care" /><span>Reports<small>SUPER USER WORKSPACE</small></span></a><button className="back-page" onClick={() => setDashboardPage('dashboard')}>← Back to dashboard</button></header>
      <section className="inventory-panel standalone-card">
        <div><p className="eyebrow">SPARE PARTS CONTROL</p><h1>Warehouse to engineer stock</h1><p className="muted">Upload warehouse balances, assign parts to engineers, and record fitting when a part is used.</p></div>
        {(notice || error) && <p className={error ? 'message error' : 'message success'} role="status">{error || notice}</p>}
        <div className="inventory-grid">
          <section className="inventory-form stock-upload"><h3>Upload warehouse stock</h3><p>Use CSV or Excel with <strong>Part Number</strong>, <strong>Part Name</strong> and <strong>Warehouse Quantity</strong>. Matching part numbers are updated to the uploaded balance.</p><a className="stock-template" href="/warehouse-stock-template.csv" download>Download CSV template</a><label className="upload-control"><input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={importWarehouseStock} /><span className="upload-icon">↑</span><strong>Choose stock file</strong><small>CSV or XLSX</small></label></section>
          <form onSubmit={assignPart} className="inventory-form"><h3>Assign from warehouse</h3><label>PART<select name="partId" required defaultValue=""><option value="" disabled>Select part</option>{parts.map((part) => <option key={part.id} value={part.id}>{part.partNumber} — {part.name} ({part.warehouseQty} available)</option>)}</select></label><label>ENGINEER<select name="engineerId" required defaultValue=""><option value="" disabled>Select engineer</option>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.name}</option>)}</select></label><label>QUANTITY<input name="quantity" type="number" min="1" step="1" required /></label><button type="submit">Assign part</button></form>
          <form onSubmit={fitPart} className="inventory-form"><h3>Record fitted part</h3><label>ENGINEER<select name="engineerId" required defaultValue=""><option value="" disabled>Select engineer</option>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.name}</option>)}</select></label><label>PART<select name="partId" required defaultValue=""><option value="" disabled>Select part</option>{parts.map((part) => <option key={part.id} value={part.id}>{part.partNumber} — {part.name}</option>)}</select></label><label>DEVICE / MACHINE<input name="device" placeholder="e.g. Oxygen Concentrator OC-5" required /></label><label>QUANTITY<input name="quantity" type="number" min="1" step="1" required /></label><button type="submit">Record fitting</button></form>
        </div>
        <div className="stock-tables"><div><h3>Warehouse stock</h3>{parts.map((part) => <p key={part.id}><strong>{part.partNumber}</strong><span>{part.name}</span><b>{part.warehouseQty}</b></p>)}</div><div><h3>Engineer stock</h3>{engineers.flatMap((engineer) => parts.filter((part) => (engineerStock[stockKey(engineer.id, part.id)] || 0) > 0).map((part) => <p key={`${engineer.id}-${part.id}`}><strong>{engineer.name}</strong><span>{part.partNumber} — {part.name}</span><b>{engineerStock[stockKey(engineer.id, part.id)]}</b></p>))}{!Object.values(engineerStock).some((quantity) => quantity > 0) && <p className="muted">No parts currently assigned to engineers.</p>}</div></div>
        {stockMovements.length > 0 && <div className="movement-list"><h3>Recent movements</h3>{stockMovements.slice(0, 8).map((movement) => <p key={movement.id}><time>{movement.time}</time><strong>{movement.type}</strong><span>{parts.find((part) => part.id === movement.partId)?.partNumber} × {movement.quantity} · {accounts.find((account) => account.id === movement.engineerId)?.name} · {movement.detail}</span></p>)}</div>}
      </section>
    </main>
  );

  if (signedIn) return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <a className="brand" href="#top"><img src="/oxygen-care-logo-supplied.jpeg" alt="Oxygen Care" /><span>Reports<small>SUPER USER WORKSPACE</small></span></a>
        <div className="account-chip"><span className="avatar">SU</span><span>Super User</span><button onClick={() => setSignedIn(false)}>Log out</button></div>
      </header>
      <section className="workspace-hero" id="top"><div><p className="eyebrow">EQUIPMENT ACTIVITY REPORTING</p><h1>Import operational records in one secure place.</h1><p>Upload a CSV or Excel file to review machine activity, identifiers and service notes in a consistent format.</p></div><div className="hero-stat"><strong>{records.length}</strong><span>report records</span></div></section>

      <section className="import-card" aria-labelledby="import-title">
        <div><p className="eyebrow">BULK IMPORT</p><h2 id="import-title">Upload a report file</h2><p className="muted">Accepts CSV and Excel (.xlsx) files. The first worksheet will be imported.</p></div>
        <div className="upload-stack"><label className="import-owner">CLIENT NAME<input value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="e.g. St. Brigid's Care Home" /></label><fieldset className="report-users"><legend>Assign device list to users</legend>{accounts.map((account) => <label key={account.id}><input type="checkbox" checked={importUserIds.includes(account.id)} onChange={(event) => setImportUserIds((users) => event.target.checked ? [...users, account.id] : users.filter((id) => id !== account.id))} /> {account.name}</label>)}</fieldset><label className="upload-control"><input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={importFile} /><span className="upload-icon">↑</span><strong>Upload device list</strong><small>CSV or XLSX</small></label></div>
      </section>
      <section className="schema-card"><div><p className="eyebrow">REPORT LAYOUT</p><h2>Add, arrange or delete fields</h2><p className="muted">Choose a regular field, checkbox, or comments field. Drag a field name to arrange columns, or select × to remove it from the report layout.</p></div><form onSubmit={addCustomField} className="field-form"><label className="sr-only" htmlFor="fieldName">Field name</label><input id="fieldName" name="fieldName" placeholder="e.g. Service Engineer" maxLength={60} required /><select name="fieldType" defaultValue="text" aria-label="Field type"><option value="text">Regular field</option><option value="checkbox">Checkbox</option><option value="comments">Comments</option></select><button type="submit">Add field</button></form><div className="field-list" aria-label="Current report fields">{reportFields.map((field) => <span key={field} draggable onDragStart={() => setDraggedField(field)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveColumn(field)} className={draggedField === field ? 'dragging' : ''}><b aria-hidden="true">⠿</b>{field}{customFields.includes(field) && <small>{fieldTypes[field] === 'text' ? 'regular' : fieldTypes[field]}</small>}<button type="button" aria-label={`Delete ${field}`} title={`Delete ${field}`} onClick={() => deleteColumn(field)}>×</button></span>)}</div></section>
      <section className="column-guide" aria-label="Required import columns"><p>Required columns</p><div>{reportFields.map((column) => <span key={column}>{column}</span>)}</div></section>
      {(notice || error) && <p className={error ? 'message error' : 'message success'} role="status">{error || notice}</p>}

      <section className="filter-card"><div><p className="eyebrow">FILTER REPORTS</p><h2>Find the exact records you need</h2><p className="muted">Filters use a partial match and update as you type. New report fields appear here automatically.</p></div><div className="filter-controls"><label>User<select value={userFilter} onChange={(event) => setUserFilter(event.target.value)}><option value="">All users</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>{reportFields.map((field) => <label key={field}>{field}<input value={filters[field] || ''} onChange={(event) => setFilters((current) => ({ ...current, [field]: event.target.value }))} placeholder={`Filter ${field}`} /></label>)}</div><div className="export-actions"><button className="clear-filters" type="button" onClick={() => { setFilters({}); setUserFilter(''); }}>Clear filters</button><span>{filteredRecords.length} matching records</span><button type="button" onClick={exportCsv}>Export CSV</button><button type="button" onClick={exportPdf}>Export PDF</button></div></section>
      {uploads.length > 0 && <section className="uploads-card"><p className="eyebrow">CLIENT DEVICE LISTS</p><h2>Open a client list for review</h2><div>{uploads.map((report) => <button key={report.id} className="report-link" onClick={() => openReport(report)}><span><strong>{report.clientName}</strong><small>{report.fileName} · {report.rowIds.length} devices · {accounts.filter((account) => report.userIds.includes(account.id)).map((account) => account.name).join(', ')}</small></span><b>Review / edit →</b></button>)}</div></section>}
      <section className="directory report-table"><div className="directory-heading"><div><p className="eyebrow">IMPORTED DATA</p><h2>Machine activity register</h2></div><span>{filteredRecords.length} of {records.length} records</span></div><div className="table-wrap"><table><thead><tr><th>Users</th>{reportFields.map((field) => <th key={field}>{field}</th>)}</tr></thead><tbody>{filteredRecords.map((record) => <tr key={record.id}><td>{accounts.filter((account) => record.ownerIds.includes(account.id)).map((account) => account.name).join(', ') || '—'}</td>{reportFields.map((field) => <td key={field} className={field === 'Comments' || fieldTypes[field] === 'comments' ? 'comments' : ''}>{fieldTypes[field] === 'checkbox' ? (['true', 'yes', '1', 'checked'].includes((recordValue(record, field) || '').toLowerCase()) ? '✓' : '—') : (recordValue(record, field) || '—')}</td>)}</tr>)}</tbody></table></div></section>

      <section className="inventory-panel"><div><p className="eyebrow">SPARE PARTS CONTROL</p><h2>Warehouse to engineer stock</h2><p className="muted">Assign parts to engineers and record fitting on a dedicated screen.</p></div><button className="open-inventory" onClick={openSparePartsControl}>Open Spare Parts Control</button></section>

      <section className="admin-grid">
        <form className="create-card" onSubmit={createAccount}><p className="eyebrow">CREATE LOGIN</p><h2>Department account</h2><p className="muted">Give a team member access to the reporting workspace.</p><label>FULL NAME<input name="name" placeholder="e.g. Maeve O'Connor" required /></label><label>WORK EMAIL<input name="email" type="email" placeholder="name@oxygencare.ie" required /></label><div className="form-pair"><label>DEPARTMENT<select name="department" defaultValue="" required><option value="" disabled>Select department</option>{departments.map((department) => <option key={department}>{department}</option>)}</select></label><label>ROLE<select name="role" defaultValue="Department User">{roles.map((role) => <option key={role}>{role}</option>)}</select></label></div><label>TEMPORARY PASSWORD<input name="password" type="password" minLength={12} placeholder="12 characters minimum" required /></label><label className="export-permission"><input type="checkbox" name="canExport" /> Allow filtered CSV and PDF exports</label><fieldset className="permission-picker"><legend>COLUMN ACCESS</legend><p>Select exactly what this user can read or write. Write access automatically includes read access.</p>{reportFields.map((field) => <div key={field}><strong>{field}</strong><label><input type="checkbox" name={`read:${field}`} defaultChecked /> Read</label><label><input type="checkbox" name={`write:${field}`} /> Write</label></div>)}</fieldset><button className="primary" type="submit">Create department login <span>→</span></button></form>
        <section className="activity-log"><div className="directory-heading"><div><p className="eyebrow">ACTIVITY LOG</p><h2>Super User audit trail</h2></div><span>{activity.length} events</span></div>{activity.length ? <div className="activity-list">{activity.map((entry) => <article key={entry.id}><time>{entry.time}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div></article>)}</div> : <p className="muted">Activity will appear here as users, permissions, fields, reports, and exports are managed.</p>}</section>
      </section>
      <section className="directory"><div className="directory-heading"><div><p className="eyebrow">ACCOUNT DIRECTORY</p><h2>Department logins</h2></div><span>{accounts.length} active</span></div><div className="table-wrap"><table><thead><tr><th>Account</th><th>Department</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.id}><td><strong>{account.name}</strong><small>{account.email}</small></td><td>{account.department}</td><td><span className="role-pill">{account.role}</span></td><td><span className="status"><i />{account.status}</span></td><td className="account-actions"><button type="button" className="access-button" onClick={() => openAccessTab(account)}>Manage access</button><button type="button" className="access-button" onClick={() => openUserEdit(account)}>Edit user</button><button type="button" className="delete-user" onClick={() => deleteAccount(account)}>Delete user</button></td></tr>)}</tbody></table></div></section>
      <section className="role-card"><p className="eyebrow">ROLE ACCESS</p><h2>Clear responsibility at every level.</h2><div className="role-list"><article><span className="role-icon">◉</span><div><strong>Department User</strong><p>Add and view reporting records for their work.</p></div></article><article><span className="role-icon">✓</span><div><strong>Department Head</strong><p>Review reporting records within their department.</p></div></article><article><span className="role-icon">✦</span><div><strong>Super User</strong><p>Manage accounts, imports, reports and approvals.</p></div></article></div></section>
      {editingAccount && <section className="access-card"><div className="directory-heading"><div><p className="eyebrow">EDIT USER</p><h2>{editingAccount.name}</h2><p className="muted">Update the account profile and role. Column permissions remain in Manage access.</p></div><button className="access-button" onClick={() => setEditingAccountId(null)}>Close</button></div><form className="edit-user-form" onSubmit={saveAccountEdit}><label>FULL NAME<input name="name" defaultValue={editingAccount.name} required /></label><label>WORK EMAIL<input name="email" type="email" defaultValue={editingAccount.email} required /></label><label>DEPARTMENT<select name="department" defaultValue={editingAccount.department}>{departments.map((department) => <option key={department}>{department}</option>)}</select></label><label>ROLE<select name="role" defaultValue={editingAccount.role}>{roles.map((role) => <option key={role}>{role}</option>)}</select></label><label className="export-permission"><input name="canExport" type="checkbox" defaultChecked={editingAccount.canExport} /> Allow filtered CSV and PDF exports</label><button type="submit">Save user changes</button></form></section>}
    </main>
  );

  return <main className="landing"><section className="landing-copy"><a className="brand" href="#top"><img src="/oxygen-care-logo-supplied.jpeg" alt="Oxygen Care" /><span>Reports<small>CLEARER REPORTING, BETTER CARE</small></span></a><div className="landing-message" id="top"><p className="eyebrow">OXYGEN CARE REPORTS</p><h1>Care for every detail. <em>Including reporting.</em></h1><p>One clear home for device activity reports, spreadsheet imports and accountable departmental access.</p><div className="trust-row"><span>✓ CSV & Excel import</span><span>✓ Complete asset records</span><span>✓ Microsoft Authenticator MFA</span></div></div><p className="copyright">© 2026 Oxygen Care. Internal reporting workspace.</p></section><section className="login-panel"><div key={loginStep} className="login-card"><span className="lock">⌁</span><p className="eyebrow">SECURE ACCESS</p>{loginStep === 'credentials' ? <><h2>Welcome back.</h2><p className="muted">Enter your account details, then verify with Microsoft Authenticator.</p>{mfaError && <p className="message error">{mfaError}</p>}{resetNotice && <p className="message success">{resetNotice}</p>}<form onSubmit={beginLogin}><label>EMAIL ADDRESS<input name="email" type="email" placeholder="you@oxygencare.ie" autoComplete="email" required /></label><label>PASSWORD<input type="password" placeholder="Enter your password" autoComplete="current-password" required /></label><div className="form-actions"><label className="remember"><input type="checkbox" /> Remember this device</label><button type="button" className="text-link" onClick={() => { setResetNotice(''); setLoginStep('reset-email'); }}>Reset password</button></div><button className="primary" type="submit">Continue <span>→</span></button></form><p className="demo-note">Local demo: credentials are not yet stored. MFA is required for access.</p></> : loginStep === 'mfa' ? <><h2>Verify your identity.</h2><p className="muted">Open Microsoft Authenticator and enter the current six-digit code.</p><div className="mfa-setup"><strong>One-time demo setup</strong><span>Microsoft Authenticator → add account → other account → enter setup key:</span><code>{demoTotpSecret}</code><small>Account name: Oxygen Care Reports · Type: time based</small></div><form onSubmit={verifyMfa}><label>AUTHENTICATOR CODE<input value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" required /></label>{mfaError && <p className="message error">{mfaError}</p>}<button className="primary" type="submit">Verify and sign in <span>→</span></button><button className="back-login" type="button" onClick={() => { setLoginStep('credentials'); setMfaError(''); }}>Back to login</button></form></> : loginStep === 'reset-email' ? <><h2>Reset your password.</h2><p className="muted">Enter your account email. We will then verify your identity with MFA before resetting your password.</p><form onSubmit={(event) => { event.preventDefault(); setResetEmail(String(new FormData(event.currentTarget).get('email') || '')); setLoginStep('reset-mfa'); }}><label>EMAIL ADDRESS<input name="email" type="email" autoComplete="email" required /></label><button className="primary" type="submit">Send reset email <span>→</span></button><button className="back-login" type="button" onClick={() => setLoginStep('credentials')}>Back to login</button></form><p className="demo-note">Demo mode: the reset email is simulated locally; no email is sent.</p></> : loginStep === 'reset-mfa' ? <><h2>Verify reset request.</h2><p className="muted">A reset link has been prepared for {resetEmail}. Enter your Microsoft Authenticator code to continue.</p><form onSubmit={verifyResetMfa}><label>AUTHENTICATOR CODE<input value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" required /></label>{mfaError && <p className="message error">{mfaError}</p>}<button className="primary" type="submit">Verify MFA <span>→</span></button><button className="back-login" type="button" onClick={() => setLoginStep('credentials')}>Back to login</button></form></> : <><h2>Create a new password.</h2><p className="muted">MFA verified for {resetEmail}.</p><form onSubmit={submitPasswordReset}><label>NEW PASSWORD<input name="password" type="password" minLength={12} autoComplete="new-password" required /></label><label>CONFIRM PASSWORD<input name="confirmPassword" type="password" minLength={12} autoComplete="new-password" required /></label>{mfaError && <p className="message error">{mfaError}</p>}<button className="primary" type="submit">Reset password <span>→</span></button></form><p className="demo-note">In production this would save a securely hashed password for the verified account.</p></>}</div></section></main>;
}
