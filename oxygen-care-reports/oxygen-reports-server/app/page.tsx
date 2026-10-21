'use client';

import './filter.css';
import DeviceAttachments from './device-attachments';
import './shell.css';
import './sidebar-brand.css';
import './appointments.css';
import './contracts.css';
import './contract-navigation.css';
import './service-visits.css';
import RepairRegistry from './repair-registry';
import AdminEntries from './admin-entries';
import './entry-layout.css';
import './mobile.css';
import CustomerPortal from './customer-portal';
import CustomerAccounts from './customer-accounts';
import ImportReview from './import-review';
import type { ImportWarning } from '../lib/import-duplicates';
import Fieldwork, { CalloutNav } from './fieldwork';
import { SecondStep, SecondStepInfo } from './second-step';
import {
  AppointmentInvitations,
  AppointmentResponse,
  appointmentsUpdated,
  CalendarNav,
  ResponseBadge,
  responseLabel
} from './appointment-responses';
import { brandPrintWindow } from './print-layout';
import { openServiceReport } from './service-report';
import { EntryList } from './entry-list';
import { BookingDates, FieldEditor, CsvPreview } from './report-tools';
import { csvCell } from '../lib/csv-export';
import { coversDate } from '../lib/booking-dates';
import { initialServiceStatuses, serviceStatus } from '../lib/service-status';
import { unzipEntry } from '../lib/workbook-zip';
import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';

type Role =
  | 'Department Head'
  | 'Department User'
  | 'Engineer'
  | 'Warehouse User'
  | 'Super User'
  | 'Customer';
type WorkspacePage =
  | 'dashboard'
  | 'access'
  | 'spare-parts'
  | 'calendar'
  | 'clients'
  | 'contracts'
  | 'repairs'
  | 'callouts'
  | 'dockets'
  | 'users'
  | 'manage-entries';
type ServerRole =
  | 'super_user'
  | 'department_head'
  | 'department_user'
  | 'engineer'
  | 'warehouse_user'
  | 'customer';
type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: ServerRole;
  departmentId: string | null;
  departmentName: string | null;
  canExport: boolean;
};
type ColumnAccess = { read: boolean; write: boolean };
type Account = {
  id: string;
  name: string;
  email: string;
  department: string;
  role: Role;
  status: 'Active';
  permissions: Record<string, ColumnAccess>;
  canExport: boolean;
  mfaEnabled?: boolean;
};
type FieldDefinition = {
  id: string;
  name: string;
  sourceKey?: string;
  kind: FieldType;
  position: number;
  canRead?: boolean;
  canWrite?: boolean;
};
type FieldType = 'text' | 'comments' | 'checkbox';
type UploadedReport = {
  id: string;
  fileName: string;
  clientName: string;
  userIds: string[];
  rowCount: number;
  uploadedAt: string;
};
type Appointment = {
  id: string;
  appointmentDate: string;
  endDate?: string;
  startTime: string | null;
  title: string;
  clientName: string;
  location: string;
  notes: string;
  assignedUserId: string | null;
  assignedUserName: string | null;
  responseStatus?: AppointmentResponse;
  responseNote?: string;
  respondedAt?: string | null;
  createdByName?: string | null;
};
type Client = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
};
type ContractSummary = {
  id: string;
  contractNumber: string;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  notes: string;
  clientId: string;
  clientName: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  deviceCount: number;
  visitCount: number;
  lastServiceDate: string | null;
  userIds: string[];
};
type ContractDevice = {
  id: string;
  deviceName: string;
  serialNumber: string;
  lotNumber: string;
  assetNumber: string;
  status: 'active' | 'decommissioned';
  purchasedOn: string | null;
  decommissionedOn: string | null;
  decommissionReason: string;
  notes: string;
  addedOn: string;
  removedOn: string | null;
};
type ContractVisit = {
  id: string;
  serviceDate: string;
  title: string;
  location: string;
  summary: string;
  recommendations: string;
  status: 'draft' | 'finalized';
  finalizedAt: string | null;
  deviceCount: number;
  partCount: number;
  signatureCount: number;
};
type ContractDetail = {
  contract: ContractSummary & { clientNotes: string };
  devices: ContractDevice[];
  visits: ContractVisit[];
  assignedUsers: Array<{ id: string; name: string; email: string }>;
};
type VisitDevice = {
  deviceId: string;
  deviceName: string;
  serialNumber: string;
  assetNumber: string;
  lotNumber: string;
  status: string;
  recordId: string | null;
  hoursIn: string;
  hoursOut: string;
  serviced: boolean;
  serviceStatus?: string;
  comments: string;
  values: Record<string, string>;
  parts: Array<{
    id: string;
    partId: string;
    partNumber: string;
    partName: string;
    quantity: number;
    notes: string;
  }>;
};
type VisitDetail = {
  visit: ContractVisit & {
    contractId: string;
    contractName: string;
    contractNumber: string;
    clientName: string;
    contactName: string;
    email: string;
    phone: string;
    address: string;
  };
  devices: VisitDevice[];
  signatures: Array<{
    id: string;
    signerRole: 'engineer' | 'client';
    signerName: string;
    signatureData: string;
    signedAt: string;
  }>;
  availableParts: Array<{
    id: string;
    partNumber: string;
    name: string;
    warehouseQuantity: number;
  }>;
};
type SparePart = {
  id: string;
  partNumber: string;
  name: string;
  location?: string;
  warehouseQty: number;
};
type StockMovement = {
  id: string;
  time: string;
  type: 'Assigned' | 'Fitted';
  partId: string;
  engineerId: string;
  quantity: number;
  detail: string;
};
type ReportRow = {
  id: string;
  deviceName: string;
  serialNumber: string;
  lotNumber: string;
  assetNumber: string;
  hoursIn: string;
  hoursOut: string;
  comments: string;
  extra: Record<string, string>;
  ownerIds: string[];
  reportId: string;
};

const departments = ['Engineering', 'Sales', 'Warehouse', 'In-House', 'Marketing'];
const roles: Role[] = [
  'Department Head',
  'Department User',
  'Engineer',
  'Warehouse User',
  'Super User'
];
const requiredColumns = [
  'Device/Machine Name',
  'Serial Number',
  'Lot Number',
  'Asset Number',
  'Amount in Hours',
  'Amount out of Hours',
  'Comments'
];

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    window.sessionStorage.setItem(
      'oxygen_reports_login_notice',
      'Your session expired after 30 minutes of inactivity. Please sign in again.'
    );
    window.location.reload();
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data as T;
}

const roleLabel = (role: ServerRole): Role =>
  (
    ({
      super_user: 'Super User',
      department_head: 'Department Head',
      department_user: 'Department User',
      engineer: 'Engineer',
      warehouse_user: 'Warehouse User',
      customer: 'Customer'
    }) satisfies Record<ServerRole, Role>
  )[role];
const serverRole = (role: Role): ServerRole =>
  (
    ({
      'Super User': 'super_user',
      'Department Head': 'department_head',
      'Department User': 'department_user',
      Engineer: 'engineer',
      'Warehouse User': 'warehouse_user',
      Customer: 'customer'
    }) satisfies Record<Role, ServerRole>
  )[role];

function AppSidebar({
  page,
  user,
  navigate,
  logout
}: {
  page: WorkspacePage;
  user: SessionUser;
  navigate: (page: WorkspacePage, anchor?: string) => void;
  logout: () => void;
}) {
  const stockAllowed = ['super_user', 'engineer', 'warehouse_user'].includes(user.role);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => setMenuOpen(false), [page]);
  return (
    <aside
      className={'app-sidebar' + (menuOpen ? ' mobile-menu-open' : '')}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          setMenuOpen(false);
          menuButton.current?.focus();
        }
      }}
    >
      <div className="sidebar-brand">
        <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care — support for life" />
      </div>
      <button
        ref={menuButton}
        className="mobile-menu-toggle"
        type="button"
        aria-expanded={menuOpen}
        aria-controls="workspace-navigation"
        onClick={() => setMenuOpen(!menuOpen)}
      >
        {menuOpen ? 'Close menu' : 'Menu'}
      </button>
      <div
        id="workspace-navigation"
        className="sidebar-menu"
        onClick={event => {
          if ((event.target as HTMLElement).closest('button')) setMenuOpen(false);
        }}
      >
        <nav aria-label="Main navigation">
          <CalendarNav
            active={page === 'calendar'}
            onClick={() => navigate('calendar')}
            superUser={user.role === 'super_user'}
          />
          <button
            className={page === 'clients' ? 'active' : ''}
            onClick={() => navigate('clients')}
          >
            <b>◉</b>Clients
          </button>
          <button
            className={page === 'contracts' ? 'active' : ''}
            onClick={() => navigate('contracts')}
          >
            <b>▤</b>Contracts
          </button>
          <button
            className={page === 'repairs' ? 'active' : ''}
            onClick={() => navigate('repairs')}
          >
            <b>⌁</b>Repair Registry
          </button>
          <CalloutNav active={page === 'callouts'} onClick={() => navigate('callouts')} />
          <button
            className={page === 'dockets' ? 'active' : ''}
            onClick={() => navigate('dockets')}
          >
            <b aria-hidden="true">▧</b>Dockets
          </button>
          {user.role === 'super_user' && (
            <button
              className={page === 'dashboard' ? 'active' : ''}
              onClick={() => navigate('dashboard')}
            >
              <b>□</b>Reports
            </button>
          )}
          {stockAllowed && (
            <button
              className={page === 'spare-parts' ? 'active' : ''}
              onClick={() => navigate('spare-parts')}
            >
              <b>◇</b>Stock
            </button>
          )}
          {user.role === 'super_user' && (
            <>
              <button
                className={page === 'users' || page === 'access' ? 'active' : ''}
                onClick={() => navigate('users')}
              >
                <b>♙</b>Users
              </button>
              <button
                className={page === 'manage-entries' ? 'active' : ''}
                onClick={() => navigate('manage-entries')}
              >
                <b>✎</b>Manage entries
              </button>
            </>
          )}
        </nav>
        <div className="sidebar-account">
          <strong>{user.displayName}</strong>
          <small>{roleLabel(user.role)}</small>
          <button onClick={logout}>Log out</button>
        </div>
      </div>
    </aside>
  );
}

function SignaturePad({
  role,
  onSave,
  disabled
}: {
  role: 'engineer' | 'client';
  onSave: (name: string, data: string) => void;
  disabled: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null),
    drawing = useRef(false);
  const [name, setName] = useState('');
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
  };
  const start = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    drawing.current = true;
    const ctx = canvasRef.current!.getContext('2d')!,
      p = point(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    const ctx = canvasRef.current!.getContext('2d')!,
      p = point(event);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#173f4a';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };
  const stop = () => {
    drawing.current = false;
  };
  const clear = () => {
    const canvas = canvasRef.current!,
      ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  return (
    <div className="signature-pad">
      <h4>{role === 'engineer' ? 'Engineer' : 'Client representative'} signature</h4>
      <canvas
        ref={canvasRef}
        width={520}
        height={150}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
      />
      <input
        value={name}
        onChange={event => setName(event.target.value)}
        placeholder="Printed signer name"
        disabled={disabled}
      />
      <div>
        <button type="button" onClick={clear} disabled={disabled}>
          Clear
        </button>
        <button
          type="button"
          onClick={() => {
            const canvas = canvasRef.current;
            if (!name.trim() || !canvas) return;
            onSave(name.trim(), canvas.toDataURL('image/png'));
          }}
          disabled={disabled || !name.trim()}
        >
          Save signature
        </button>
      </div>
    </div>
  );
}

function headerKey(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_/-]+/g, '');
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function cell(row: Record<string, unknown>, label: string) {
  const expected = headerKey(label);
  const key = Object.keys(row).find(entry => headerKey(entry) === expected);
  return String(key ? (row[key] ?? '') : '').trim();
}

function tabularRecords(rows: string[][]): Record<string, unknown>[] {
  if (
    rows.length > 50000 ||
    rows.some(row => row.length > 1024) ||
    rows.reduce((sum, row) => sum + row.length, 0) > 200000
  )
    throw new Error('Import exceeds the safe row or column limit.');
  if (!rows.length) return [];
  const expected = new Set(requiredColumns.map(headerKey));
  const headerIndex = rows.reduce(
    (best, row, index) => {
      const populated = row.filter(value => String(value || '').trim()).length;
      const recognised = row.filter(value => expected.has(headerKey(value))).length;
      const score = recognised * 1000 + populated;
      return score > best.score ? { index, score } : best;
    },
    { index: 0, score: -1 }
  ).index;
  const headers = rows[headerIndex];
  const columns = headers
    .map((header, index) => ({
      header: String(header || '')
        .replace(/^\uFEFF/, '')
        .trim(),
      index
    }))
    .filter(column => column.header);
  return rows
    .slice(headerIndex + 1)
    .map(items =>
      Object.fromEntries(columns.map(column => [column.header, items[column.index] ?? '']))
    );
}

function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some(entry => entry.trim())) rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  row.push(value);
  if (row.some(entry => entry.trim())) rows.push(row);
  return tabularRecords(rows);
}

async function parseXlsx(buffer: ArrayBuffer): Promise<Record<string, unknown>[]> {
  const workbook = await unzipEntry(buffer, 'xl/workbook.xml');
  if (!workbook) throw new Error('No workbook');
  const parseXml = (source: string) => {
    if (/<!DOCTYPE|<!ENTITY/i.test(source))
      throw new Error('Workbook XML declarations are not supported.');
    const document = new DOMParser().parseFromString(source, 'application/xml');
    if (document.querySelector('parsererror')) throw new Error('Invalid workbook XML.');
    return document;
  };
  const sheetId = parseXml(workbook).querySelector('sheet')?.getAttribute('r:id');
  const relationships = await unzipEntry(buffer, 'xl/_rels/workbook.xml.rels');
  const relationship = relationships
    ? Array.from(parseXml(relationships).querySelectorAll('Relationship')).find(
        item => item.getAttribute('Id') === sheetId
      )
    : undefined;
  if (relationship?.getAttribute('TargetMode') === 'External')
    throw new Error('External worksheets are not supported.');
  const target =
    relationship?.getAttribute('Target')?.replace(/^\//, '') || 'worksheets/sheet1.xml';
  if (target.includes('..') || target.includes(':') || target.includes('\\'))
    throw new Error('Invalid worksheet path.');
  const sheet = await unzipEntry(buffer, `xl/${target.replace(/^xl\//, '')}`);
  if (!sheet) throw new Error('No worksheet');
  const sharedXml = await unzipEntry(buffer, 'xl/sharedStrings.xml');
  const shared = sharedXml
    ? Array.from(parseXml(sharedXml).querySelectorAll('si')).map(item => item.textContent || '')
    : [];
  const sheetRows = parseXml(sheet).querySelectorAll('sheetData > row');
  if (sheetRows.length > 50000) throw new Error('Workbook contains too many rows.');
  let cells = 0;
  const rows = Array.from(sheetRows).map(sheetRow => {
    const output: string[] = [];
    sheetRow.querySelectorAll('c').forEach(cellElement => {
      if (++cells > 200000) throw new Error('Workbook contains too many cells.');
      const reference = cellElement.getAttribute('r') || 'A1';
      if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(reference))
        throw new Error('Invalid workbook cell reference.');
      let column = 0;
      for (const character of reference.match(/^[A-Z]+/)![0])
        column = column * 26 + character.charCodeAt(0) - 64;
      if (column > 1024) throw new Error('Workbook contains too many columns.');
      const index = column - 1;
      const type = cellElement.getAttribute('t');
      const raw = cellElement.querySelector('v')?.textContent || '';
      output[index] =
        type === 's'
          ? shared[Number(raw)] || ''
          : type === 'inlineStr'
            ? cellElement.querySelector('is')?.textContent || ''
            : raw;
    });
    return output;
  });
  return tabularRecords(rows);
}

export default function HomePage() {
  const [signedIn, setSignedIn] = useState(false);
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [authStatus, setAuthStatus] = useState<'checking' | 'signed-out' | 'signed-in'>('checking');
  const [loginError, setLoginError] = useState('');
  // After a correct password: the authenticator or email code step.
  const [secondStep, setSecondStep] = useState<SecondStepInfo | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [records, setRecords] = useState<ReportRow[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [importError, setImportError] = useState(''),
    [importNotice, setImportNotice] = useState('');
  const [importVisitId, setImportVisitId] = useState('');
  const [importReview, setImportReview] = useState<{
    accepted: number;
    warnings: ImportWarning[];
    payload: Record<string, unknown>;
    newFields: string[];
    filename: string;
  } | null>(null);
  const importLock = useRef(false);
  const [importBusy, setImportBusy] = useState(false);

  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(null);
  const [importInputKey, setImportInputKey] = useState(0);
  const [clientName, setClientName] = useState('');
  const [columnOrder, setColumnOrder] = useState(requiredColumns);
  const [draggedField, setDraggedField] = useState<string | null>(null);
  const [fieldTypes, setFieldTypes] = useState<Record<string, FieldType>>({});
  const [serviceStatuses, setServiceStatuses] = useState<string[]>(initialServiceStatuses);
  const isServiceField = (field: string) =>
    fieldDefinitions.find(item => item.name === field)?.sourceKey === 'Serviced' ||
    field === 'Service status';
  useEffect(() => {
    if (authStatus !== 'signed-in' || sessionUser?.role === 'customer') return;
    void api<{ options: string[] }>('/api/service-status-options')
      .then(data => {
        if (Array.isArray(data.options) && data.options.length) setServiceStatuses(data.options);
      })
      .catch(reason =>
        setError(reason instanceof Error ? reason.message : 'Could not load service statuses.')
      );
  }, [authStatus, sessionUser?.role]);
  async function addServiceStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/service-status-options', {
        method: 'POST',
        body: JSON.stringify({ name: new FormData(form).get('name') })
      });
      const data = await api<{ options: string[] }>('/api/service-status-options');
      setServiceStatuses(data.options);
      form.reset();
      setError('');
      setNotice('Service status added.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add service status.');
    }
  }
  const [fieldDefinitions, setFieldDefinitions] = useState<FieldDefinition[]>([]);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [accessAccountId, setAccessAccountId] = useState<string | null>(null);
  const [dashboardPage, setDashboardPage] = useState<WorkspacePage>('calendar');
  // A call-out chosen with "Create docket", pre-selected when the Dockets page opens.
  const [docketCalloutId, setDocketCalloutId] = useState('');
  const [importUserIds, setImportUserIds] = useState<string[]>([]);
  const [uploads, setUploads] = useState<UploadedReport[]>([]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [userFilter, setUserFilter] = useState('');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  const contractRequest = useRef(0);
  const [contractSection, setContractSection] = useState<'browse' | 'new' | 'tools'>('browse');
  const [contractTab, setContractTab] = useState<'overview' | 'devices' | 'visits'>('overview');
  const [contractDetail, setContractDetail] = useState<ContractDetail | null>(null);
  const [contractSearch, setContractSearch] = useState('');
  const [editingField, setEditingField] = useState<FieldDefinition | null>(null);
  const [csvPreview, setCsvPreview] = useState<{ columns: string[]; rows: string[][] } | null>(
    null
  );
  const [contractStatus, setContractStatus] = useState('');
  const [selectedVisitId, setSelectedVisitId] = useState<string | null>(null);
  const [visitDetail, setVisitDetail] = useState<VisitDetail | null>(null);
  const visitRequest = useRef(0);
  const [clientSearch, setClientSearch] = useState('');
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedAppointmentDate, setSelectedAppointmentDate] = useState<string | null>(null);
  const [editingAppointmentId, setEditingAppointmentId] = useState<string | null>(null);
  const [editingReportRowId, setEditingReportRowId] = useState<string | null>(null);
  const [parts, setParts] = useState<SparePart[]>([]);
  const [engineerStock, setEngineerStock] = useState<Record<string, number>>({});
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);

  const reportFields = columnOrder;
  const editingAccount = accounts.find(account => account.id === editingAccountId);
  const accessAccount = accounts.find(account => account.id === accessAccountId);
  const [engineers, setEngineers] = useState<Array<{ id: string; name: string }>>([]);
  const writableFields = fieldDefinitions
    .filter(field => field.canWrite || sessionUser?.role === 'super_user')
    .map(field => field.name);
  const editingReportRow = records.find(record => record.id === editingReportRowId);
  const calendarMonthKey = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`;
  const calendarDays = useMemo(() => {
    const blanks = calendarMonth.getDay();
    const count = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
    return [
      ...Array.from({ length: blanks }, () => null),
      ...Array.from(
        { length: count },
        (_, index) => new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), index + 1)
      )
    ];
  }, [calendarMonth]);
  const filteredClients = clients.filter(client =>
    [client.name, client.contactName, client.email, client.phone, client.address].some(value =>
      value.toLowerCase().includes(clientSearch.toLowerCase())
    )
  );
  const filteredContracts = contracts.filter(
    contract =>
      (!contractStatus ||
        (contractStatus === 'closed'
          ? contract.status === 'closed'
          : contract.status !== 'closed')) &&
      [contract.clientName, contract.name, contract.contractNumber].some(value =>
        value.toLowerCase().includes(contractSearch.toLowerCase())
      )
  );
  const stockKey = (engineerId: string, partId: string) => `${engineerId}:${partId}`;
  const recordValue = (record: ReportRow, field: string) => {
    const values: Record<string, string> = {
      'Device/Machine Name': record.deviceName,
      'Serial Number': record.serialNumber,
      'Lot Number': record.lotNumber,
      'Asset Number': record.assetNumber,
      'Amount in Hours': record.hoursIn,
      'Amount out of Hours': record.hoursOut,
      Comments: record.comments
    };
    const source =
      fieldDefinitions.find(definition => definition.name === field)?.sourceKey || field;
    const raw = String(
      (Object.hasOwn(values, source) ? values[source] : record.extra[source]) ?? ''
    );
    return isServiceField(field)
      ? serviceStatus(raw)
      : fieldTypes[field] === 'checkbox'
        ? ['true', 'yes', '1', 'checked'].includes(raw.toLowerCase())
          ? 'Yes'
          : 'No'
        : raw;
  };
  const filteredRecords = useMemo(
    () =>
      records.filter(record => {
        if (userFilter && !record.ownerIds.includes(userFilter)) return false;
        return reportFields.every(
          field =>
            !filters[field] ||
            (isServiceField(field)
              ? recordValue(record, field) === filters[field]
              : recordValue(record, field).toLowerCase().includes(filters[field].toLowerCase()))
        );
      }),
    [records, reportFields, filters, userFilter, fieldDefinitions, fieldTypes]
  );

  useEffect(() => {
    let active = true;
    const expiredNotice = window.sessionStorage.getItem('oxygen_reports_login_notice');
    if (expiredNotice) {
      setLoginError(expiredNotice);
      window.sessionStorage.removeItem('oxygen_reports_login_notice');
    }
    api<{ user: SessionUser }>('/api/auth/me')
      .then(({ user }) => {
        if (!active) return;
        setSessionUser(user);
        setSignedIn(true);
        setAuthStatus('signed-in');
        window.dispatchEvent(new Event('session-signed-in'));
      })
      .catch(() => {
        if (active) setAuthStatus('signed-out');
      });
    return () => {
      active = false;
    };
  }, []);

  async function loadDirectory() {
    const [{ fields }, { users }] = await Promise.all([
      api<{ fields: FieldDefinition[] }>('/api/fields'),
      api<{
        users: Array<{
          id: string;
          email: string;
          displayName: string;
          role: ServerRole;
          departmentName: string | null;
          canExport: boolean;
          active: boolean;
          mfaEnabled: boolean;
          permissions: Record<string, ColumnAccess>;
        }>;
      }>('/api/users')
    ]);
    const orderedFields = fields.sort((left, right) => left.position - right.position);
    const namesById = new Map(orderedFields.map(field => [field.id, field.name]));
    setFieldDefinitions(orderedFields);
    setColumnOrder(orderedFields.map(field => field.name));
    setFieldTypes(Object.fromEntries(orderedFields.map(field => [field.name, field.kind])));
    setAccounts(
      users
        .filter(user => user.active)
        .map(user => ({
          id: user.id,
          name: user.displayName,
          email: user.email,
          department: user.departmentName || '',
          role: roleLabel(user.role),
          status: 'Active' as const,
          canExport: user.canExport,
          mfaEnabled: user.mfaEnabled,
          permissions: Object.fromEntries(
            Object.entries(user.permissions || {}).flatMap(([fieldId, access]) => {
              const name = namesById.get(fieldId);
              return name ? [[name, access]] : [];
            })
          )
        }))
    );
  }

  async function loadMemberFields() {
    const { fields } = await api<{ fields: FieldDefinition[] }>('/api/fields');
    const orderedFields = fields.sort((left, right) => left.position - right.position);
    setFieldDefinitions(orderedFields);
    setColumnOrder(orderedFields.filter(field => field.canRead).map(field => field.name));
    setFieldTypes(
      Object.fromEntries(
        orderedFields.filter(field => field.canRead).map(field => [field.name, field.kind])
      )
    );
    if (sessionUser)
      setAccounts([
        {
          id: sessionUser.id,
          name: sessionUser.displayName,
          email: sessionUser.email,
          department: sessionUser.departmentName || '',
          role: roleLabel(sessionUser.role),
          status: 'Active',
          permissions: Object.fromEntries(
            orderedFields.map(field => [
              field.name,
              { read: Boolean(field.canRead), write: Boolean(field.canWrite) }
            ])
          ),
          canExport: sessionUser.canExport
        }
      ]);
  }

  async function loadReports() {
    const { reports } = await api<{
      reports: Array<{
        id: string;
        clientName: string;
        originalFilename: string;
        uploadedAt: string;
        userIds: string[];
        rowCount: number;
      }>;
    }>('/api/reports');
    const details = await Promise.all(
      reports.map(report =>
        api<{
          rows: Array<{
            id: string;
            deviceName: string;
            serialNumber: string;
            lotNumber: string;
            assetNumber: string;
            hoursIn: string;
            hoursOut: string;
            comments: string;
            values: Record<string, string>;
          }>;
        }>(`/api/reports/${report.id}`)
      )
    );
    setUploads(
      reports.map(report => ({
        id: report.id,
        fileName: report.originalFilename,
        clientName: report.clientName,
        userIds: report.userIds,
        rowCount: report.rowCount,
        uploadedAt: new Date(report.uploadedAt).toLocaleString()
      }))
    );
    setRecords(
      reports.flatMap((report, index) =>
        details[index].rows.map(row => ({
          id: row.id,
          deviceName: row.deviceName,
          serialNumber: row.serialNumber,
          lotNumber: row.lotNumber,
          assetNumber: row.assetNumber,
          hoursIn: row.hoursIn,
          hoursOut: row.hoursOut,
          comments: row.comments,
          extra: row.values || {},
          ownerIds: report.userIds,
          reportId: report.id
        }))
      )
    );
  }

  async function loadStock() {
    const stock = await api<{
      engineers: Array<{ id: string; name: string }>;
      parts: Array<{
        id: string;
        partNumber: string;
        name: string;
        location?: string;
        warehouseQuantity: number;
      }>;
      engineerStock: Array<{ engineerId: string; partId: string; quantity: number }>;
      movements: Array<{
        id: string;
        movement: 'assigned' | 'fitted';
        quantity: number;
        detail: string;
        createdAt: string;
        partId: string;
        engineerId: string;
      }>;
    }>('/api/stock');
    setEngineers(stock.engineers);
    setParts(
      stock.parts.map(part => ({
        id: part.id,
        partNumber: part.partNumber,
        name: part.name,
        location: part.location || '',
        warehouseQty: part.warehouseQuantity
      }))
    );
    setEngineerStock(
      Object.fromEntries(
        stock.engineerStock.map(item => [stockKey(item.engineerId, item.partId), item.quantity])
      )
    );
    setStockMovements(
      stock.movements.map(movement => ({
        id: movement.id,
        time: new Date(movement.createdAt).toLocaleString(),
        type: movement.movement === 'assigned' ? 'Assigned' : 'Fitted',
        partId: movement.partId,
        engineerId: movement.engineerId,
        quantity: movement.quantity,
        detail: movement.detail
      }))
    );
  }

  async function loadAppointments(month = calendarMonthKey) {
    const result = await api<{ appointments: Appointment[] }>(`/api/appointments?month=${month}`);
    setAppointments(result.appointments);
  }

  async function loadClients() {
    const result = await api<{ clients: Client[] }>('/api/clients');
    setClients(result.clients);
  }

  async function loadContracts() {
    const result = await api<{ contracts: ContractSummary[] }>('/api/contracts');
    setContracts(result.contracts);
  }

  async function openContract(id: string, preserveSection = false) {
    setImportVisitId('');
    const request = ++contractRequest.current;
    if (id !== selectedContractId) {
      ++visitRequest.current;
      setContractTab('overview');
      setContractDetail(null);
      setVisitDetail(null);
      setSelectedVisitId(null);
    }
    if (!preserveSection) setContractSection('browse');
    setSelectedContractId(id);
    try {
      const detail = await api<ContractDetail>(`/api/contracts/${id}`);
      if (request !== contractRequest.current) return;
      setContractDetail(detail);
      setClientName(detail.contract.clientName);
      setImportUserIds(detail.assignedUsers.map(user => user.id));
      setError('');
    } catch (reason) {
      if (request === contractRequest.current)
        setError(reason instanceof Error ? reason.message : 'Could not open the contract.');
    }
  }

  useEffect(() => {
    if (authStatus !== 'signed-in' || dashboardPage !== 'contracts' || contractSection !== 'browse')
      return;
    if (!filteredContracts.length) {
      if (selectedContractId) {
        ++contractRequest.current;
        setSelectedContractId(null);
        setContractDetail(null);
      }
      return;
    }
    if (
      !selectedContractId ||
      !filteredContracts.some(contract => contract.id === selectedContractId)
    )
      void openContract(filteredContracts[0].id);
  }, [
    authStatus,
    dashboardPage,
    contractSection,
    contracts,
    contractSearch,
    contractStatus,
    selectedContractId
  ]);

  async function createContract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    try {
      const userIds = accounts
        .filter(account => values.has(`user:${account.id}`))
        .map(account => account.id);
      const created = await api<{ id: string }>('/api/contracts', {
        method: 'POST',
        body: JSON.stringify({
          clientId: values.get('clientId'),
          contractNumber: values.get('contractNumber'),
          name: values.get('name'),
          startDate: values.get('startDate'),
          endDate: values.get('endDate'),
          notes: values.get('notes'),
          userIds
        })
      });
      await loadContracts();
      await openContract(created.id);
      setNotice('Contract created.');
      setError('');
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the contract.');
    }
  }

  async function addContractDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedContractId) return;
    const form = event.currentTarget,
      values = new FormData(form);
    try {
      await api(`/api/contracts/${selectedContractId}/devices`, {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(values))
      });
      await openContract(selectedContractId);
      setNotice('Device added to the contract.');
      setError('');
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add the device.');
    }
  }

  async function setDeviceStatus(device: ContractDevice, status: 'active' | 'decommissioned') {
    if (!selectedContractId) return;
    const reason =
      status === 'decommissioned'
        ? window.prompt('Reason for decommissioning this device:', '') || ''
        : '';
    if (status === 'decommissioned' && !reason) return;
    try {
      await api(`/api/contracts/${selectedContractId}/devices/${device.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, reason })
      });
      await openContract(selectedContractId);
      setNotice(
        status === 'active'
          ? 'Device reactivated.'
          : 'Device decommissioned; its history has been retained.'
      );
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the device.');
    }
  }

  async function createServiceVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedContractId) return;
    const form = event.currentTarget,
      values = new FormData(form);
    try {
      const result = await api<{ id: string; warning: string | null }>(
        `/api/contracts/${selectedContractId}/visits`,
        { method: 'POST', body: JSON.stringify(Object.fromEntries(values)) }
      );
      await openContract(selectedContractId);
      setNotice(result.warning || 'Service visit added.');
      setError('');
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add the service visit.');
    }
  }

  async function openVisit(id: string) {
    const request = ++visitRequest.current;
    try {
      const detail = await api<VisitDetail>(`/api/service-visits/${id}`);
      if (request !== visitRequest.current) return;
      setSelectedVisitId(id);
      setVisitDetail(detail);
      setError('');
    } catch (reason) {
      if (request === visitRequest.current)
        setError(reason instanceof Error ? reason.message : 'Could not open the service visit.');
    }
  }

  async function saveVisitDevice(event: FormEvent<HTMLFormElement>, device: VisitDevice) {
    event.preventDefault();
    if (!selectedVisitId) return;
    const values = new FormData(event.currentTarget);
    try {
      await api(`/api/service-visits/${selectedVisitId}/devices/${device.deviceId}`, {
        method: 'PUT',
        body: JSON.stringify({
          serviceStatus: values.get('serviceStatus'),
          comments: values.get('comments')
        })
      });
      await openVisit(selectedVisitId);
      setNotice(`${device.deviceName || 'Device'} service record saved.`);
      setError('');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not save the device service record.'
      );
    }
  }
  async function addVisitPart(event: FormEvent<HTMLFormElement>, device: VisitDevice) {
    event.preventDefault();
    if (!selectedVisitId) return;
    const form = event.currentTarget,
      values = new FormData(form);
    try {
      await api(`/api/service-visits/${selectedVisitId}/parts`, {
        method: 'POST',
        body: JSON.stringify({
          deviceId: device.deviceId,
          partId: values.get('partId'),
          quantity: Number(values.get('quantity')),
          notes: values.get('notes')
        })
      });
      await openVisit(selectedVisitId);
      setNotice('Fitted part added.');
      setError('');
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add the fitted part.');
    }
  }
  async function removeVisitPart(id: string) {
    if (!selectedVisitId) return;
    try {
      await api(`/api/service-visits/${selectedVisitId}/parts`, {
        method: 'DELETE',
        body: JSON.stringify({ fittedPartId: id })
      });
      await openVisit(selectedVisitId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove the fitted part.');
    }
  }
  async function saveVisitSignature(
    role: 'engineer' | 'client',
    signerName: string,
    signatureData: string
  ) {
    if (!selectedVisitId) return;
    try {
      await api(`/api/service-visits/${selectedVisitId}/signatures`, {
        method: 'POST',
        body: JSON.stringify({ signerRole: role, signerName, signatureData })
      });
      await openVisit(selectedVisitId);
      setNotice(`${role === 'engineer' ? 'Engineer' : 'Client'} signature saved.`);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the signature.');
    }
  }
  async function finalizeVisit() {
    if (
      !selectedVisitId ||
      !window.confirm('Finalize this signed service report? It will become read-only.')
    )
      return;
    try {
      await api(`/api/service-visits/${selectedVisitId}`, {
        method: 'PATCH',
        body: JSON.stringify({ finalize: true })
      });
      await openVisit(selectedVisitId);
      if (selectedContractId) await openContract(selectedContractId);
      setNotice('Service report finalized.');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not finalize the report.');
    }
  }
  function printVisit() {
    if (!visitDetail) return;
    if (!openServiceReport(visitDetail)) setError('Your browser blocked the print window.');
  }

  function printContract() {
    if (!contractDetail) return;
    const popup = window.open('', '_blank');
    if (!popup) {
      setError('Your browser blocked the print window. Please allow pop-ups.');
      return;
    }
    const escape = (value: unknown) =>
      String(value ?? '').replace(
        /[&<>"']/g,
        character =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ||
          character
      );
    const { contract, devices, visits, assignedUsers } = contractDetail;
    popup.document.write(
      `<!doctype html><title>${escape(contract.clientName)} · ${escape(contract.name)}</title><style>body{font:14px Arial;color:#173f4a;margin:32px}header{display:flex;justify-content:space-between;border-bottom:3px solid #277b91;padding-bottom:16px}h1,h2{margin:0 0 8px}p{margin:4px 0}.meta{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:22px 0}.card{border:1px solid #cfe1e5;border-radius:10px;padding:14px}table{width:100%;border-collapse:collapse;margin:12px 0 24px}th,td{border-bottom:1px solid #dce9ec;padding:8px;text-align:left;vertical-align:top}th{color:#277b91}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:45px}.signature{border-top:1px solid #173f4a;padding-top:8px;min-height:50px}@media print{body{margin:12mm}.no-print{display:none}}</style><header><div><h1>Oxygen Care</h1><p>Contract service record</p></div><button class="no-print" onclick="window.print()">Print / Save PDF</button></header><section class="meta"><div class="card"><h2>Client details</h2><p><b>${escape(contract.clientName)}</b></p><p>${escape(contract.contactName)}</p><p>${escape(contract.address)}</p><p>${escape(contract.email)}</p><p>${escape(contract.phone)}</p></div><div class="card"><h2>Contract details</h2><p><b>${escape(contract.name)}</b></p><p>Contract number: ${escape(contract.contractNumber || '—')}</p><p>Status: ${escape(contract.status)}</p><p>Assigned to: ${escape(assignedUsers.map(user => user.name).join(', ') || '—')}</p></div></section><h2>Registered devices</h2><table><thead><tr><th>Device</th><th>Serial</th><th>Asset</th><th>Lot</th><th>Status</th></tr></thead><tbody>${devices.map(device => `<tr><td>${escape(device.deviceName)}</td><td>${escape(device.serialNumber || '—')}</td><td>${escape(device.assetNumber || '—')}</td><td>${escape(device.lotNumber || '—')}</td><td>${escape(device.status)}</td></tr>`).join('')}</tbody></table><h2>Service history</h2><table><thead><tr><th>Date</th><th>Visit</th><th>Devices</th><th>Parts</th><th>Status</th></tr></thead><tbody>${visits.map(visit => `<tr><td>${escape(visit.serviceDate)}</td><td>${escape(visit.title)}<br>${escape(visit.summary)}</td><td>${visit.deviceCount}</td><td>${visit.partCount}</td><td>${escape(visit.status)}</td></tr>`).join('')}</tbody></table><div class="signatures"><div class="signature">Engineer signature / name / date</div><div class="signature">Client representative signature / name / date</div></div>`
    );
    popup.document.close();
    brandPrintWindow(popup);
  }

  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    try {
      await api('/api/clients', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(values))
      });
      await loadClients();

      setNotice('Client added.');
      setError('');
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add the client.');
    }
  }

  function navigateWorkspace(page: WorkspacePage, anchor?: string) {
    setError('');
    setNotice('');
    setImportError('');
    setImportNotice('');
    setDashboardPage(page);
    if (anchor)
      window.setTimeout(
        () => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' }),
        0
      );
  }

  async function createAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAppointmentDate) return;
    const form = event.currentTarget,
      values = new FormData(form);
    try {
      const saved = await api<{ responseStatus: string | null }>('/api/appointments', {
        method: 'POST',
        body: JSON.stringify({
          appointmentDate: values.get('appointmentDate') || selectedAppointmentDate,
          endDate: values.get('endDate'),
          startTime: values.get('startTime'),
          title: values.get('title'),
          clientName: values.get('clientName'),
          location: values.get('location'),
          notes: values.get('notes'),
          assignedUserId: values.get('assignedUserId')
        })
      });
      await loadAppointments();
      appointmentsUpdated();
      setNotice(
        saved.responseStatus === 'pending'
          ? 'Appointment added. The engineer has been asked to accept it.'
          : 'Appointment added to the calendar.'
      );
      setError('');
      setSelectedAppointmentDate(null);
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the appointment.');
    }
  }

  async function updateAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const appointment = appointments.find(item => item.id === editingAppointmentId);
    if (!appointment) return;
    const values = new FormData(event.currentTarget);
    try {
      const saved = await api<{ responseStatus: string | null }>('/api/appointments', {
        method: 'PATCH',
        body: JSON.stringify({
          id: appointment.id,
          appointmentDate: values.get('appointmentDate'),
          endDate: values.get('endDate'),
          startTime: values.get('startTime'),
          title: values.get('title'),
          clientName: values.get('clientName'),
          location: values.get('location'),
          notes: values.get('notes'),
          assignedUserId: values.get('assignedUserId')
        })
      });
      await loadAppointments();
      appointmentsUpdated();
      setEditingAppointmentId(null);
      setNotice(
        saved.responseStatus === 'pending'
          ? 'Appointment updated. The engineer has been asked to accept it.'
          : 'Appointment updated.'
      );
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update the appointment.');
    }
  }

  async function deleteAppointment(appointment: Appointment) {
    if (!window.confirm(`Delete “${appointment.title}”?`)) return;
    try {
      await api('/api/appointments', {
        method: 'DELETE',
        body: JSON.stringify({ id: appointment.id })
      });
      await loadAppointments();
      appointmentsUpdated();
      setEditingAppointmentId(null);
      setNotice('Appointment deleted.');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete the appointment.');
    }
  }

  useEffect(() => {
    if (authStatus !== 'signed-in' || sessionUser?.role === 'customer') return;
    loadAppointments(calendarMonthKey).catch(reason =>
      setError(reason instanceof Error ? reason.message : 'Could not load the calendar.')
    );
  }, [authStatus, calendarMonthKey, sessionUser?.role]);

  useEffect(() => {
    if (authStatus !== 'signed-in' || !sessionUser || sessionUser.role === 'customer') return;
    const loaders =
      sessionUser.role === 'super_user'
        ? [loadDirectory(), loadReports(), loadStock(), loadClients(), loadContracts()]
        : [
            loadMemberFields(),
            loadReports(),
            loadClients(),
            loadContracts(),
            ...(['engineer', 'warehouse_user'].includes(sessionUser.role) ? [loadStock()] : [])
          ];
    Promise.all(loaders).catch(reason =>
      setError(reason instanceof Error ? reason.message : 'Could not load the Reports workspace.')
    );
  }, [authStatus, sessionUser?.role]);

  useEffect(() => {
    if (authStatus !== 'signed-in' || sessionUser?.role !== 'super_user') return;
    const refresh = () => {
      setContractDetail(null);
      setVisitDetail(null);
      setSelectedContractId(null);
      setSelectedVisitId(null);
      void Promise.all([
        loadReports(),
        loadClients(),
        loadContracts(),
        loadStock(),
        loadAppointments(calendarMonthKey)
      ]).catch(reason =>
        setError(reason instanceof Error ? reason.message : 'Could not refresh the workspace.')
      );
    };
    window.addEventListener('admin-entries-updated', refresh);
    return () => window.removeEventListener('admin-entries-updated', refresh);
  }, [authStatus, sessionUser?.role, calendarMonthKey]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError('');
    const values = new FormData(event.currentTarget);
    try {
      const next = await api<SecondStepInfo>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: values.get('email'), password: values.get('password') })
      });
      setSecondStep(next);
    } catch (reason) {
      setLoginError(reason instanceof Error ? reason.message : 'Sign-in failed.');
    }
  }

  async function finishSignIn() {
    setLoginError('');
    try {
      const { user } = await api<{ user: SessionUser }>('/api/auth/me');
      setSecondStep(null);
      setSessionUser(user);
      setSignedIn(true);
      setAuthStatus('signed-in');
      window.dispatchEvent(new Event('session-signed-in'));
    } catch (reason) {
      setLoginError(reason instanceof Error ? reason.message : 'Sign-in failed.');
    }
  }

  async function signOut() {
    window.dispatchEvent(new Event('session-signed-out'));
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (reason) {
      setLoginError(
        reason instanceof Error
          ? 'Could not confirm server logout: ' + reason.message
          : 'Could not confirm server logout. Close this browser session.'
      );
    } finally {
      setSessionUser(null);
      setSignedIn(false);
      setAuthStatus('signed-out');
      setDashboardPage('calendar');
      setCsvPreview(null);
      setEditingField(null);
    }
  }

  async function assignStock(partId: string, engineerId: string, quantity: number) {
    const part = parts.find(item => item.id === partId);
    const engineer = engineers.find(account => account.id === engineerId);
    if (!part || !engineer || !Number.isInteger(quantity) || quantity < 1) {
      setError('Choose a spare part, engineer and whole quantity.');
      return;
    }
    if (quantity > part.warehouseQty) {
      setError(`Only ${part.warehouseQty} ${part.name} available in warehouse stock.`);
      return;
    }
    try {
      await api('/api/stock/movements', {
        method: 'POST',
        body: JSON.stringify({
          partId,
          engineerId,
          movement: 'assigned',
          quantity,
          detail: 'Warehouse allocation'
        })
      });
      await loadStock();
      setError('');
      setNotice(`${quantity} × ${part.name} assigned to ${engineer.name}.`);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not assign the part.');
    }
  }

  async function assignPart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    if (
      await assignStock(
        String(values.get('partId') || ''),
        String(values.get('engineerId') || ''),
        Number(values.get('quantity'))
      )
    )
      form.reset();
  }

  async function fitStock(partId: string, engineerId: string, quantity: number, device: string) {
    const part = parts.find(item => item.id === partId);
    const engineer = engineers.find(account => account.id === engineerId);
    const available = engineerStock[stockKey(engineerId, partId)] || 0;
    if (!part || !engineer || !device || !Number.isInteger(quantity) || quantity < 1) {
      setError('Choose an engineer, part, quantity and device/machine.');
      return;
    }
    if (quantity > available) {
      setError(`${engineer.name} has only ${available} ${part.name} in personal stock.`);
      return;
    }
    try {
      await api('/api/stock/movements', {
        method: 'POST',
        body: JSON.stringify({
          partId,
          engineerId,
          movement: 'fitted',
          quantity,
          detail: `Fitted to ${device}`
        })
      });
      await loadStock();
      setError('');
      setNotice(
        `${quantity} × ${part.name} recorded as fitted to ${device}; stock removed from ${engineer.name}.`
      );
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not record the fitted part.');
    }
  }

  async function fitPart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    if (
      await fitStock(
        String(values.get('partId') || ''),
        String(values.get('engineerId') || ''),
        Number(values.get('quantity')),
        String(values.get('device') || '').trim()
      )
    )
      form.reset();
  }

  async function saveWarehousePart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    const partNumber = String(values.get('partNumber') || '').trim();
    const name = String(values.get('name') || '').trim();
    const warehouseQuantity = Number(values.get('warehouseQuantity'));
    try {
      await api('/api/stock/parts', {
        method: 'PUT',
        body: JSON.stringify({
          parts: [
            {
              partNumber,
              name,
              location: String(values.get('location') || '').trim(),
              warehouseQuantity
            }
          ]
        })
      });
      await loadStock();
      setError('');
      setNotice(`${partNumber} was added or updated in warehouse stock.`);
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update warehouse stock.');
    }
  }

  async function importStockFile(file: File) {
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose a stock file smaller than 5 MB.');
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (!['csv', 'xlsx'].includes(extension || ''))
        throw new Error('Choose a CSV or Excel workbook (.xlsx).');
      const rows =
        extension === 'csv'
          ? parseCsv(await file.text())
          : await parseXlsx(await file.arrayBuffer());
      const value = (row: Record<string, unknown>, names: string[]) =>
        names.map(name => cell(row, name)).find(Boolean) || '';
      const importedParts = rows
        .map(row => ({
          partNumber: value(row, ['Part Number', 'Part No', 'Part Code', 'SKU']),
          name: value(row, ['Part Name', 'Name', 'Description']),
          warehouseQuantity: Number(
            value(row, ['Warehouse Quantity', 'Quantity', 'Qty', 'Stock']).replace(/,/g, '')
          )
        }))
        .filter(part => part.partNumber || part.name);
      if (!importedParts.length)
        throw new Error('The selected stock file does not contain any data rows.');
      if (
        importedParts.some(
          part =>
            !part.partNumber ||
            !part.name ||
            !Number.isInteger(part.warehouseQuantity) ||
            part.warehouseQuantity < 0
        )
      )
        throw new Error(
          'Each row needs Part Number, Part Name and a non-negative whole Warehouse Quantity.'
        );
      await api('/api/stock/parts', {
        method: 'PUT',
        body: JSON.stringify({ parts: importedParts })
      });
      await loadStock();
      const message = `${importedParts.length} stock items imported from ${file.name}.`;
      setNotice(message);
      setError('');
      window.alert(message);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not import the stock file.';
      setError(message);
      window.alert(message);
    }
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name') || '').trim();
    const email = String(values.get('email') || '')
      .trim()
      .toLowerCase();
    const department = String(values.get('department') || '');
    const role = String(values.get('role') || '') as Role;
    if (!name || !email || !department || !role) return;
    const permissions = Object.fromEntries(
      reportFields.map(field => {
        const write = values.has(`write:${field}`);
        return [field, { read: write || values.has(`read:${field}`), write }];
      })
    );
    const form = event.currentTarget;
    setError('');
    try {
      const created = await api<{ id: string }>('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          displayName: name,
          email,
          departmentName: department,
          role: serverRole(role),
          password: values.get('password'),
          canExport: values.has('canExport')
        })
      });
      await savePermissions(created.id, permissions, values.has('canExport'));
      await loadDirectory();
      setNotice(`Login created for ${name}.`);
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the user.');
    }
  }

  async function savePermissions(
    accountId: string,
    permissions: Record<string, ColumnAccess>,
    canExport: boolean
  ) {
    await api(`/api/users/${accountId}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({
        canExport,
        permissions: fieldDefinitions.map(field => ({
          fieldId: field.id,
          canRead: permissions[field.name]?.read || false,
          canWrite: permissions[field.name]?.write || false
        }))
      })
    });
  }

  async function updatePermission(
    accountId: string,
    field: string,
    permission: keyof ColumnAccess,
    enabled: boolean
  ) {
    const account = accounts.find(item => item.id === accountId);
    if (!account) return;
    const currentAccess = account.permissions[field] || { read: false, write: false };
    const nextAccess =
      permission === 'write'
        ? { read: enabled || currentAccess.read, write: enabled }
        : { read: enabled, write: enabled ? currentAccess.write : false };
    const permissions = { ...account.permissions, [field]: nextAccess };
    setAccounts(current =>
      current.map(item => {
        if (item.id !== accountId) return item;
        return { ...item, permissions };
      })
    );
    try {
      await savePermissions(accountId, permissions, account.canExport);
    } catch (reason) {
      setAccounts(current => current.map(item => (item.id === accountId ? account : item)));
      setError(reason instanceof Error ? reason.message : 'Could not save permissions.');
    }
  }

  async function updateExportAccess(accountId: string, canExport: boolean) {
    const account = accounts.find(item => item.id === accountId);
    if (!account) return;
    setAccounts(current =>
      current.map(account => (account.id === accountId ? { ...account, canExport } : account))
    );
    try {
      await savePermissions(accountId, account.permissions, canExport);
    } catch (reason) {
      setAccounts(current => current.map(item => (item.id === accountId ? account : item)));
      setError(reason instanceof Error ? reason.message : 'Could not save export access.');
    }
  }

  async function saveAccountEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingAccount) return;
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name') || '').trim();
    const email = String(values.get('email') || '')
      .trim()
      .toLowerCase();
    const department = String(values.get('department') || '');
    const role = String(values.get('role') || '') as Role;
    if (!name || !email || !department || !role) return;
    try {
      await api(`/api/users/${editingAccount.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: name,
          email,
          departmentName: department,
          role: serverRole(role),
          canExport: values.has('canExport')
        })
      });
      await loadDirectory();
      setEditingAccountId(null);
      setNotice(`${name}'s user profile was updated.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update the user.');
    }
  }

  async function resetAuthenticator(account: Account) {
    if (
      !window.confirm(
        `Reset ${account.name}'s authenticator? They will be signed out and set up a new one at their next sign-in.`
      )
    )
      return;
    try {
      await api(`/api/users/${account.id}/mfa`, { method: 'DELETE' });
      await loadDirectory();
      setNotice(`${account.name}'s authenticator was reset.`);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reset the authenticator.');
    }
  }

  async function deleteAccount(account: Account) {
    if (
      !window.confirm(
        `Delete ${account.name}? This permanently removes the login and its permissions.`
      )
    )
      return;
    try {
      await api(`/api/users/${account.id}`, { method: 'DELETE' });
      await loadDirectory();
      setRecords(current =>
        current.map(record => ({
          ...record,
          ownerIds: record.ownerIds.filter(id => id !== account.id)
        }))
      );
      setImportUserIds(current => current.filter(id => id !== account.id));
      setEditingAccountId(null);
      setNotice(`${account.name} was deleted.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete the user.');
    }
  }

  function openAccessTab(account: Account) {
    setAccessAccountId(account.id);
    setDashboardPage('access');
  }

  async function saveField(field: FieldDefinition, name: string, kind: string) {
    await api('/api/fields', {
      method: 'PATCH',
      body: JSON.stringify({ id: field.id, name, kind })
    });
    await Promise.all([loadDirectory(), loadReports()]);
    setFilters(current => {
      const next = { ...current };
      if (field.name !== name && next[field.name]) {
        next[name] = next[field.name];
        delete next[field.name];
      }
      return next;
    });
    setNotice('Report field updated. Existing values and permissions have been retained.');
    setError('');
  }

  function openMachineHistory(record: ReportRow) {
    const popup = window.open(
      '/machine-history?row=' + encodeURIComponent(record.id),
      '_blank',
      'width=1100,height=850'
    );
    if (!popup) {
      setError('Please allow the machine history window.');
      return;
    }
    popup.opener = null;
  }

  async function addCustomField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const fieldName = String(values.get('fieldName') || '')
      .trim()
      .replace(/\s+/g, ' ');
    const fieldType = String(values.get('fieldType') || 'text') as FieldType;
    if (!fieldName) return;
    if (reportFields.some(field => headerKey(field) === headerKey(fieldName))) {
      setError('That field already exists in the report layout.');
      return;
    }
    setError('');
    try {
      await api('/api/fields', {
        method: 'POST',
        body: JSON.stringify({ name: fieldName, kind: fieldType })
      });
      await Promise.all([loadDirectory(), loadReports()]);
      setNotice(
        `“${fieldName}” was added as a ${fieldType === 'checkbox' ? 'checkbox' : fieldType} field.${fieldType === 'checkbox' ? ' Existing report rows are unchecked.' : ''}`
      );
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add the report field.');
    }
  }

  function moveColumn(target: string) {
    if (!draggedField || draggedField === target) return;
    setColumnOrder(fields => {
      const next = fields.filter(field => field !== draggedField);
      next.splice(next.indexOf(target), 0, draggedField);
      return next;
    });
    setDraggedField(null);
  }

  async function deleteColumn(field: string) {
    if (!window.confirm(`Remove the “${field}” column from the report layout?`)) return;
    try {
      await api('/api/fields', { method: 'DELETE', body: JSON.stringify({ name: field }) });
      await Promise.all([loadDirectory(), loadReports()]);
      setFilters(current => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      setNotice(`“${field}” was removed from the report layout.`);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove the report field.');
    }
  }

  async function importFile() {
    if (importLock.current) return;
    importLock.current = true;
    setImportBusy(true);
    try {
      await prepareImport();
    } finally {
      importLock.current = false;
      setImportBusy(false);
    }
  }

  async function prepareImport() {
    const file = selectedImportFile;
    setImportError('');
    setImportNotice('');
    const missing = [
      !importVisitId && 'a service visit',
      !clientName.trim() && 'a client name',
      !importUserIds.length && 'at least one assigned user',
      !file && 'a CSV or XLSX file'
    ].filter(Boolean);
    if (missing.length) {
      setImportError(`Before importing, provide ${missing.join(', ')}.`);
      return;
    }
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setImportError('Choose a report file smaller than 5 MB.');
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx'].includes(extension || '')) {
      setImportError('Choose a CSV or Excel workbook (.xlsx).');
      return;
    }
    try {
      const rawRows =
        extension === 'csv'
          ? parseCsv(await file.text())
          : await parseXlsx(await file.arrayBuffer());
      const headers = rawRows.length ? Object.keys(rawRows[0]) : [];
      const canonicalHeader = (header: string) =>
        fieldDefinitions.find(
          field =>
            (field.sourceKey === 'Serviced' && headerKey(header) === 'serviced') ||
            headerKey(field.name) === headerKey(header)
        )?.name || header.trim();
      const importedCell = (row: Record<string, unknown>, source: string) => {
        const field = fieldDefinitions.find(
          definition => (definition.sourceKey || definition.name) === source
        );
        return (field && cell(row, field.name)) || cell(row, source);
      };
      const newFields = headers
        .filter(
          header =>
            !['amountinhours', 'amountoutofhours', 'hoursin', 'hoursout'].includes(
              headerKey(header)
            )
        )
        .map(header => canonicalHeader(header))
        .filter(
          (header, index, all) =>
            header &&
            !reportFields.some(field => headerKey(field) === headerKey(header)) &&
            all.findIndex(item => headerKey(item) === headerKey(header)) === index
        );
      // New fields are created only after the user confirms the duplicate review.
      const imported = rawRows
        .filter(row => Object.values(row).some(value => String(value).trim()))
        .map(row => ({
          deviceName: importedCell(row, 'Device/Machine Name'),
          serialNumber: importedCell(row, 'Serial Number'),
          lotNumber: importedCell(row, 'Lot Number'),
          assetNumber: importedCell(row, 'Asset Number'),
          hoursIn: importedCell(row, 'Amount in Hours'),
          hoursOut: importedCell(row, 'Amount out of Hours'),
          comments: importedCell(row, 'Comments'),
          values: Object.fromEntries(
            headers
              .map(header => canonicalHeader(header))
              .filter(
                header => !requiredColumns.some(field => headerKey(field) === headerKey(header))
              )
              .map(header => [
                header,
                isServiceField(header)
                  ? serviceStatus(importedCell(row, 'Serviced'))
                  : cell(row, header)
              ])
          )
        }));
      if (!imported.length) {
        setImportError('The selected file does not contain any data rows.');
        return;
      }
      const payload = {
        clientName: contractDetail!.contract.clientName,
        serviceVisitId: importVisitId,
        originalFilename: file.name,
        userIds: [...importUserIds],
        rows: imported
      };
      const result = await api<{ accepted: number; warnings: ImportWarning[] }>('/api/reports', {
        method: 'POST',
        body: JSON.stringify({ ...payload, preview: true })
      });
      setImportReview({ ...result, payload, newFields, filename: file.name });
    } catch (reason) {
      setImportError(
        reason instanceof Error
          ? reason.message
          : 'This file could not be read. Please export it as CSV or a standard .xlsx Excel workbook and try again.'
      );
    }
  }

  async function confirmImport() {
    if (!importReview) return;
    const current = await api<{ fields: FieldDefinition[] }>('/api/fields');
    for (const name of importReview.newFields.filter(
      name => !current.fields.some(f => headerKey(f.name) === headerKey(name))
    ))
      await api('/api/fields', { method: 'POST', body: JSON.stringify({ name, kind: 'text' }) });
    const result = await api<{ imported: number; skipped: number }>('/api/reports', {
      method: 'POST',
      body: JSON.stringify(importReview.payload)
    });
    setImportReview(null);
    setSelectedImportFile(null);
    setImportInputKey(key => key + 1);
    setImportNotice(result.imported + ' rows imported · ' + result.skipped + ' rows skipped.');
    try {
      await Promise.all([
        loadReports(),
        loadDirectory(),
        loadContracts(),
        selectedContractId ? openContract(selectedContractId, true) : Promise.resolve()
      ]);
    } catch (reason) {
      setImportError(
        'Import saved, but the workspace could not refresh. Reload the page. ' +
          (reason instanceof Error ? reason.message : '')
      );
    }
  }

  async function saveReportRow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingReportRow) return;
    const values = new FormData(event.currentTarget);
    const fields = Object.fromEntries(
      writableFields.map(field => [
        field,
        !isServiceField(field) && fieldTypes[field] === 'checkbox'
          ? values.has(field)
            ? 'Yes'
            : 'No'
          : String(values.get(field) || '')
      ])
    );
    try {
      await api(`/api/report-rows/${editingReportRow.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields })
      });
      await loadReports();
      setEditingReportRowId(null);
      setError('');
      setNotice('Report row updated.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update the report row.');
    }
  }

  function canWriteField(field: string) {
    return (
      sessionUser?.role === 'super_user' ||
      fieldDefinitions.some(definition => definition.name === field && definition.canWrite)
    );
  }

  async function updateReportCheckbox(record: ReportRow, field: string, checked: boolean) {
    if (!canWriteField(field)) return;
    setRecords(current =>
      current.map(item =>
        item.id === record.id
          ? { ...item, extra: { ...item.extra, [field]: checked ? 'Yes' : 'No' } }
          : item
      )
    );
    try {
      await api(`/api/report-rows/${record.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { [field]: checked ? 'Yes' : 'No' } })
      });

      setError('');
      setNotice(`${field} updated.`);
    } catch (reason) {
      await loadReports();
      setError(reason instanceof Error ? reason.message : 'Could not update the checkbox.');
    }
  }

  function openReport(report: UploadedReport) {
    const rows = records.filter(record => record.reportId === report.id);
    const escape = (value: string) =>
      value.replace(
        /[&<>"']/g,
        character =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ||
          character
      );
    const headers = ['User', ...reportFields];
    const tableRows = rows
      .map(
        record =>
          `<tr>${[
            accounts
              .filter(account => record.ownerIds.includes(account.id))
              .map(account => account.name)
              .join(', '),
            ...reportFields.map(field => recordValue(record, field))
          ]
            .map(value => `<td>${escape(value || '—')}</td>`)
            .join('')}</tr>`
      )
      .join('');
    const popup = window.open('', '_blank');
    if (!popup) {
      setError('Your browser blocked the report window. Please allow pop-ups for this preview.');
      return;
    }
    popup.document.write(
      `<!doctype html><title>${escape(report.fileName)}</title><style>body{font-family:Arial,sans-serif;color:#183f4b;padding:32px}h1{margin:0 0 6px}p{color:#63818a}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{padding:10px;border-bottom:1px solid #cfeaf2;text-align:left;vertical-align:top}th{font-size:12px;color:#277b91}</style><h1>Oxygen Care Reports</h1><p>${escape(report.fileName)} · ${escape(report.uploadedAt)}</p><table><thead><tr>${headers.map(header => `<th>${escape(header)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table>`
    );
    popup.document.close();
    brandPrintWindow(popup);
    popup.opener = null;
  }

  function exportCsv() {
    if (sessionUser?.role !== 'super_user' && !sessionUser?.canExport) {
      setError('You do not have export permission.');
      return;
    }
    const columns = ['Users', ...reportFields];
    const rows = filteredRecords.map(record =>
      [
        accounts
          .filter(account => record.ownerIds.includes(account.id))
          .map(account => account.name)
          .join(', '),
        ...reportFields.map(field => recordValue(record, field))
      ].map(csvCell)
    );
    setCsvPreview({ columns: columns.map(csvCell), rows });
  }

  function printContractList() {
    const popup = window.open('', '_blank', 'width=1000,height=850');
    if (!popup) {
      setError('Please allow the print window.');
      return;
    }
    const doc = popup.document;
    doc.open();
    doc.write('<!doctype html><html><head><title>Contract list</title></head><body></body></html>');
    doc.close();
    const title = doc.createElement('h1');
    title.textContent = 'Client contracts';
    doc.body.append(title);
    const summary = doc.createElement('p');
    summary.textContent =
      filteredContracts.length +
      ' contracts · Status: ' +
      (contractStatus || 'All') +
      ' · Search: ' +
      (contractSearch || 'All');
    doc.body.append(summary);
    const table = doc.createElement('table'),
      head = table.createTHead().insertRow(),
      body = table.createTBody();
    for (const label of ['Client', 'Contract', 'Number', 'Status', 'Devices', 'Visits']) {
      const th = doc.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    for (const c of filteredContracts) {
      const row = body.insertRow();
      for (const value of [
        c.clientName,
        c.name,
        c.contractNumber,
        c.status,
        String(c.deviceCount),
        String(c.visitCount)
      ])
        row.insertCell().textContent = value || '—';
    }
    doc.body.append(table);
    brandPrintWindow(popup);
  }

  function printClientList() {
    const popup = window.open('', '_blank', 'width=1000,height=850');
    if (!popup) {
      setError('Please allow the print window.');
      return;
    }
    const doc = popup.document;
    doc.open();
    doc.write('<!doctype html><html><head><title>Client list</title></head><body></body></html>');
    doc.close();
    const title = doc.createElement('h1');
    title.textContent = 'Client list';
    doc.body.append(title);
    const summary = doc.createElement('p');
    summary.textContent = filteredClients.length + ' clients · Search: ' + (clientSearch || 'All');
    doc.body.append(summary);
    const table = doc.createElement('table'),
      head = table.createTHead().insertRow(),
      body = table.createTBody();
    for (const label of ['Client', 'Contact', 'Email', 'Phone', 'Address']) {
      const th = doc.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    for (const client of filteredClients) {
      const row = body.insertRow();
      for (const value of [
        client.name,
        client.contactName,
        client.email,
        client.phone,
        client.address
      ])
        row.insertCell().textContent = value || '—';
    }
    doc.body.append(table);
    brandPrintWindow(popup);
  }

  function exportPdf() {
    const escape = (value: string) =>
      value.replace(
        /[&<>"']/g,
        character =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ||
          character
      );
    const popup = window.open('', '_blank');
    if (!popup) {
      setError('Your browser blocked the PDF window. Please allow pop-ups for this preview.');
      return;
    }
    const headings = ['Users', ...reportFields];
    const rows = filteredRecords.map(record => [
      accounts
        .filter(account => record.ownerIds.includes(account.id))
        .map(account => account.name)
        .join(', '),
      ...reportFields.map(field => recordValue(record, field))
    ]);
    popup.document.write(
      `<!doctype html><title>Oxygen Care filtered report</title><style>body{font-family:Arial,sans-serif;color:#183f4b;padding:28px}h1{margin:0}p{color:#63818a}table{width:100%;border-collapse:collapse;margin-top:20px;font-size:12px}th,td{padding:8px;border-bottom:1px solid #cfeaf2;text-align:left;vertical-align:top}th{color:#277b91}@media print{body{padding:0}}</style><h1>Oxygen Care Reports</h1><p>Filtered report · ${filteredRecords.length} records · ${new Date().toLocaleDateString()}</p><table><thead><tr>${headings.map(heading => `<th>${escape(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escape(value || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    );
    popup.document.close();
    brandPrintWindow(popup);
  }

  if (authStatus === 'checking')
    return (
      <main className="login-only">
        <section className="login-card" role="status" aria-label="Checking session">
          <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care" />
        </section>
      </main>
    );

  if (!signedIn || !sessionUser)
    return (
      <main className="login-only">
        <section className="login-card">
          <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care" />
          {secondStep ? (
            <SecondStep
              info={secondStep}
              onDone={() => void finishSignIn()}
              onRestart={message => {
                setSecondStep(null);
                setLoginError(message);
              }}
            />
          ) : (
            <form onSubmit={signIn} aria-label="Login">
              <label>
                EMAIL ADDRESS
                <input name="email" type="email" autoComplete="email" required />
              </label>
              <label>
                PASSWORD
                <input name="password" type="password" autoComplete="current-password" required />
              </label>
              {loginError && (
                <p className="message error" role="alert">
                  {loginError}
                </p>
              )}
              <button className="primary" type="submit">
                Sign in
              </button>
            </form>
          )}
        </section>
      </main>
    );

  if (sessionUser.role === 'customer') return <CustomerPortal logout={signOut} />;

  const csvPreviewOverlay = csvPreview ? (
    <CsvPreview {...csvPreview} close={() => setCsvPreview(null)} />
  ) : null;

  if (
    sessionUser.role !== 'super_user' &&
    !['calendar', 'clients', 'contracts', 'spare-parts', 'repairs', 'callouts', 'dockets'].includes(
      dashboardPage
    )
  )
    return (
      <main className="workspace-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <a className="brand" href="#top">
            <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care" />
            <span>
              Reports<small>{roleLabel(sessionUser.role).toUpperCase()} WORKSPACE</small>
            </span>
          </a>
          <div className="account-chip">
            <span className="avatar">
              {sessionUser.displayName
                .split(' ')
                .map(part => part[0])
                .join('')
                .slice(0, 2)
                .toUpperCase()}
            </span>
            <span>
              {sessionUser.displayName} · {roleLabel(sessionUser.role)}
            </span>
          </div>
        </header>
        {(notice || error) && (
          <p className={error ? 'message error' : 'message success'} role="status">
            {error || notice}
          </p>
        )}
        {reportFields.length > 0 && (
          <section className="filter-card">
            <div className="filter-controls">
              {reportFields.map(field => (
                <label key={field}>
                  {field}
                  {isServiceField(field) ? (
                    <select
                      aria-label="Filter service status"
                      value={filters[field] || ''}
                      onChange={event =>
                        setFilters(current => ({ ...current, [field]: event.target.value }))
                      }
                    >
                      <option value="">All service statuses</option>
                      {serviceStatuses.map(status => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={filters[field] || ''}
                      onChange={event =>
                        setFilters(current => ({ ...current, [field]: event.target.value }))
                      }
                      placeholder={`Filter ${field}`}
                    />
                  )}
                </label>
              ))}
            </div>
            <div className="export-actions">
              <button className="clear-filters" type="button" onClick={() => setFilters({})}>
                Clear filters
              </button>
              <span>{filteredRecords.length} matching records</span>
              {sessionUser.canExport && (
                <>
                  <button type="button" onClick={exportCsv}>
                    Export CSV
                  </button>
                  <button type="button" onClick={exportPdf}>
                    Export PDF
                  </button>
                </>
              )}
            </div>
          </section>
        )}
        {uploads.length > 0 && (
          <section className="uploads-card">
            <p className="eyebrow">YOUR REPORTS</p>
            <h2>Open an assigned report</h2>
            <EntryList
              label="Uploaded reports"
              items={uploads}
              getKey={report => report.id}
              onOpen={report => openReport(report)}
              line={report => [
                report.clientName,
                report.fileName,
                `${report.rowCount} records`,
                report.uploadedAt
              ]}
              actions={report => (
                <button type="button" onClick={() => openReport(report)}>
                  Open
                </button>
              )}
            />
          </section>
        )}
        {editingReportRow && writableFields.length > 0 && (
          <section className="access-card">
            <div className="directory-heading">
              <div>
                <p className="eyebrow">EDIT REPORT ROW</p>
                <h2>Update permitted fields</h2>
              </div>
              <button
                className="access-button"
                type="button"
                onClick={() => setEditingReportRowId(null)}
              >
                Close
              </button>
            </div>
            <form className="edit-user-form" onSubmit={saveReportRow}>
              {writableFields.map(field => (
                <label key={field}>
                  {field}
                  {isServiceField(field) ? (
                    <select name={field} defaultValue={recordValue(editingReportRow, field)}>
                      {Array.from(
                        new Set([...serviceStatuses, recordValue(editingReportRow, field)])
                      ).map(status => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                  ) : fieldTypes[field] === 'checkbox' ? (
                    <input
                      name={field}
                      type="checkbox"
                      defaultChecked={['true', 'yes', '1', 'checked'].includes(
                        (recordValue(editingReportRow, field) || '').toLowerCase()
                      )}
                    />
                  ) : (
                    <input name={field} defaultValue={recordValue(editingReportRow, field)} />
                  )}
                </label>
              ))}
              <button type="submit">Save report changes</button>
            </form>
          </section>
        )}
        <section className="directory report-table">
          <div className="directory-heading">
            <div>
              <p className="eyebrow">ASSIGNED DATA</p>
              <h2>Machine activity register</h2>
            </div>
            <span>{filteredRecords.length} records</span>
          </div>
          {reportFields.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Machine history</th>
                    {reportFields.map(field => (
                      <th key={field}>{field}</th>
                    ))}
                    {writableFields.length > 0 && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredRecords.map(record => (
                    <tr
                      key={record.id}
                      className="machine-history-row"
                      onClick={event => {
                        if (
                          !(event.target as HTMLElement).closest('button,input,select,textarea,a')
                        )
                          openMachineHistory(record);
                      }}
                    >
                      <td>
                        <button
                          className="machine-history-link"
                          aria-label={
                            'Open history for ' +
                            (record.deviceName || record.serialNumber || 'machine')
                          }
                          onClick={() => openMachineHistory(record)}
                        >
                          Open history
                        </button>
                      </td>
                      {reportFields.map(field => (
                        <td
                          key={field}
                          className={
                            field === 'Comments' || fieldTypes[field] === 'comments'
                              ? 'comments'
                              : ''
                          }
                        >
                          {fieldTypes[field] === 'checkbox' ? (
                            <input
                              type="checkbox"
                              checked={['true', 'yes', '1', 'checked'].includes(
                                (recordValue(record, field) || '').toLowerCase()
                              )}
                              disabled={!canWriteField(field)}
                              onChange={event =>
                                updateReportCheckbox(record, field, event.target.checked)
                              }
                              aria-label={'Update ' + field}
                            />
                          ) : (
                            recordValue(record, field) || '—'
                          )}
                        </td>
                      ))}
                      {writableFields.length > 0 && (
                        <td>
                          <button
                            className="access-button"
                            type="button"
                            onClick={() => setEditingReportRowId(record.id)}
                          >
                            Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No report fields have been granted to this account.</p>
          )}
        </section>
        {!uploads.length && (
          <section className="directory standalone-card">
            <p className="muted">No reports are assigned to your account yet.</p>
          </section>
        )}
        {csvPreviewOverlay}
      </main>
    );

  if (dashboardPage === 'callouts' || dashboardPage === 'dockets')
    return (
      <Fieldwork
        key={dashboardPage}
        mode={dashboardPage}
        user={sessionUser}
        initialCalloutId={dashboardPage === 'dockets' ? docketCalloutId : ''}
        onInitialCalloutUsed={() => setDocketCalloutId('')}
        openDocket={calloutId => {
          setDocketCalloutId(calloutId);
          navigateWorkspace('dockets');
        }}
        sidebar={
          <AppSidebar
            page={dashboardPage}
            user={sessionUser}
            navigate={navigateWorkspace}
            logout={signOut}
          />
        }
      />
    );
  const contractImportTools =
    sessionUser?.role === 'super_user' ? (
      <section className="contract-import-tools" aria-label="Contract report upload and layout">
        <h2>Upload and arrange report layout</h2>
        <section className="schema-card">
          <div>
            <h2>Service status options</h2>
            <p className="muted">{serviceStatuses.join(' · ')}</p>
          </div>
          <form className="field-form" onSubmit={addServiceStatus}>
            <label>
              New option
              <input name="name" maxLength={80} required />
            </label>
            <button type="submit">Add option</button>
          </form>
        </section>
        <section className="import-card" aria-labelledby="import-title">
          <div>
            <p className="eyebrow">BULK IMPORT</p>
            <h2 id="import-title">Upload a report file</h2>
            <p className="muted">
              Accepts CSV and Excel (.xlsx) files. The first worksheet will be imported.
            </p>
          </div>
          <div className="upload-stack">
            <label>
              CONTRACT
              <select
                aria-label="Import contract"
                value={selectedContractId || ''}
                onChange={event => void openContract(event.target.value, true)}
                disabled={importBusy}
              >
                <option value="" disabled>
                  Select contract
                </option>
                {contracts.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.clientName} · {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CLIENT NAME
              <input value={contractDetail?.contract.clientName || ''} readOnly />
            </label>
            <label>
              SERVICE VISIT
              <select
                aria-label="Import service visit"
                required
                value={importVisitId}
                disabled={importBusy || contractDetail?.contract.id !== selectedContractId}
                onChange={event => {
                  setImportVisitId(event.target.value);
                  setImportError('');
                  setImportNotice('');
                }}
              >
                <option value="" disabled>
                  Select a draft service visit
                </option>
                {contractDetail?.visits
                  .filter(v => v.status === 'draft')
                  .map(v => (
                    <option key={v.id} value={v.id}>
                      {v.serviceDate} — {v.title}
                    </option>
                  ))}
              </select>
            </label>
            <fieldset className="report-users">
              <legend>Assign report to users</legend>
              {accounts.map(account => (
                <label key={account.id}>
                  <input
                    type="checkbox"
                    checked={importUserIds.includes(account.id)}
                    onChange={event =>
                      setImportUserIds(users =>
                        event.target.checked
                          ? [...users, account.id]
                          : users.filter(id => id !== account.id)
                      )
                    }
                  />{' '}
                  {account.name}
                </label>
              ))}
            </fieldset>
            <label className="upload-control">
              <input
                key={importInputKey}
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={event => {
                  const file = event.target.files?.[0] || null;
                  setSelectedImportFile(file);
                  setImportError('');
                  setImportNotice('');
                }}
              />
              <span className="upload-icon">↑</span>
              <strong>{selectedImportFile ? selectedImportFile.name : 'Choose a file'}</strong>
              <small>CSV or XLSX</small>
            </label>
            <button className="primary" type="button" disabled={importBusy} onClick={importFile}>
              Import selected report <span>→</span>
            </button>
            {(importError || importNotice) && (
              <p
                className={importError ? 'message error' : 'message success'}
                role={importError ? 'alert' : 'status'}
              >
                {importError || importNotice}
              </p>
            )}
          </div>
        </section>
        <section className="schema-card report-layout-card">
          <div>
            <h2>Report layout</h2>
            <p className="muted">Drag rows to arrange columns.</p>
          </div>
          <form onSubmit={addCustomField} className="field-form">
            <label htmlFor="fieldName">
              Field name
              <input
                id="fieldName"
                name="fieldName"
                placeholder="e.g. Service Engineer"
                maxLength={80}
                required
              />
            </label>
            <label htmlFor="fieldType">
              Field type
              <select id="fieldType" name="fieldType" defaultValue="text" aria-label="Field type">
                <option value="text">Regular field</option>
                <option value="checkbox">Checkbox</option>
                <option value="comments">Comments</option>
              </select>
            </label>
            <button type="submit">Add field</button>
          </form>
          <div className="field-list" aria-label="Current report fields">
            {reportFields.map((field, index) => (
              <span
                key={field}
                draggable
                onDragStart={() => setDraggedField(field)}
                onDragOver={event => event.preventDefault()}
                onDrop={() => moveColumn(field)}
                className={draggedField === field ? 'dragging' : ''}
              >
                <b aria-hidden="true">⠿</b>
                <small className="field-position">{index + 1}</small>
                <strong className="field-title">{field}</strong>
                <small className="field-kind">
                  {isServiceField(field)
                    ? 'Dropdown'
                    : fieldTypes[field] === 'checkbox'
                      ? 'Checkbox'
                      : fieldTypes[field] === 'comments'
                        ? 'Comments'
                        : 'Text'}
                </small>
                <span className="field-actions">
                  <button
                    type="button"
                    aria-label={`Edit ${field}`}
                    onClick={() =>
                      setEditingField(
                        fieldDefinitions.find(definition => definition.name === field) || null
                      )
                    }
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${field}`}
                    title={`Delete ${field}`}
                    onClick={() => deleteColumn(field)}
                  >
                    Remove
                  </button>
                </span>
              </span>
            ))}
          </div>
        </section>
        {importReview && (
          <ImportReview
            accepted={importReview.accepted}
            warnings={importReview.warnings}
            confirm={confirmImport}
            close={() => setImportReview(null)}
          />
        )}
        {editingField && (
          <FieldEditor
            key={editingField.id}
            field={editingField}
            close={() => setEditingField(null)}
            save={(name, kind) => saveField(editingField, name, kind)}
          />
        )}
      </section>
    ) : null;

  if (signedIn && dashboardPage === 'manage-entries' && sessionUser.role === 'super_user')
    return (
      <AdminEntries
        sidebar={
          <AppSidebar
            page={dashboardPage}
            user={sessionUser}
            navigate={navigateWorkspace}
            logout={signOut}
          />
        }
      />
    );

  if (signedIn && dashboardPage === 'repairs')
    return (
      <RepairRegistry
        user={sessionUser}
        sidebar={
          <AppSidebar
            page={dashboardPage}
            user={sessionUser}
            navigate={navigateWorkspace}
            logout={signOut}
          />
        }
      />
    );

  if (signedIn && dashboardPage === 'calendar')
    return (
      <main className="workspace-shell subpage-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <a className="brand" href="#top">
            <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care" />
            <span>
              Reports<small>APPOINTMENT CALENDAR</small>
            </span>
          </a>
          <button className="back-page" onClick={() => setDashboardPage('dashboard')}>
            ← Back to dashboard
          </button>
        </header>
        <AppointmentInvitations
          onChanged={() =>
            void loadAppointments().catch(reason =>
              setError(reason instanceof Error ? reason.message : 'Could not load the calendar.')
            )
          }
        />
        <section className="calendar-card standalone-card">
          <div className="calendar-heading">
            <div>
              <p className="eyebrow">APPOINTMENTS</p>
              <h1>
                {calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </h1>
              <p className="muted">Select a date to add an appointment.</p>
            </div>
            <div>
              <button
                type="button"
                onClick={() =>
                  setCalendarMonth(month => new Date(month.getFullYear(), month.getMonth() - 1, 1))
                }
              >
                ← Previous
              </button>
              <button
                type="button"
                onClick={() =>
                  setCalendarMonth(month => new Date(month.getFullYear(), month.getMonth() + 1, 1))
                }
              >
                Next →
              </button>
            </div>
          </div>
          {(notice || error) && (
            <p className={error ? 'message error' : 'message success'} role="status">
              {error || notice}
            </p>
          )}
          <div className="calendar-weekdays">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
              <strong key={day}>{day}</strong>
            ))}
          </div>
          <div className="calendar-grid">
            {calendarDays.map((date, index) =>
              date ? (
                <button
                  type="button"
                  className={
                    localDateKey(date) === selectedAppointmentDate
                      ? 'calendar-day selected'
                      : 'calendar-day'
                  }
                  key={localDateKey(date)}
                  onClick={() => {
                    setSelectedAppointmentDate(localDateKey(date));
                    setNotice('');
                    setError('');
                  }}
                >
                  <b>{date.getDate()}</b>
                  {appointments
                    .filter(appointment => coversDate(appointment, localDateKey(date)))
                    .slice(0, 3)
                    .map(appointment => (
                      <span
                        key={appointment.id}
                        className={appointment.responseStatus}
                        title={responseLabel(appointment.responseStatus) || undefined}
                      >
                        {appointment.startTime || 'Any time'} · {appointment.title}
                      </span>
                    ))}
                </button>
              ) : (
                <span className="calendar-day empty" key={`empty-${index}`} />
              )
            )}
          </div>
        </section>
        {selectedAppointmentDate && (
          <div
            className="appointment-modal-backdrop"
            role="presentation"
            onMouseDown={event => {
              if (event.target === event.currentTarget) setSelectedAppointmentDate(null);
            }}
          >
            <section
              className="access-card appointment-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="appointment-modal-title"
            >
              <div className="directory-heading">
                <div>
                  <p className="eyebrow">NEW APPOINTMENT</p>
                  <h2 id="appointment-modal-title">
                    {new Date(`${selectedAppointmentDate}T12:00:00`).toLocaleDateString(undefined, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric'
                    })}
                  </h2>
                </div>
                <button
                  className="access-button"
                  type="button"
                  onClick={() => setSelectedAppointmentDate(null)}
                >
                  Close
                </button>
              </div>
              <form className="edit-user-form" onSubmit={createAppointment}>
                <BookingDates start={selectedAppointmentDate} />
                <label>
                  APPOINTMENT TITLE
                  <input
                    name="title"
                    placeholder="e.g. Equipment service visit"
                    autoFocus
                    required
                  />
                </label>
                <label>
                  START TIME
                  <input name="startTime" type="time" />
                </label>
                <label>
                  CLIENT
                  <select name="clientName" defaultValue="">
                    <option value="">No client</option>
                    {clients.map(client => (
                      <option key={client.id} value={client.name}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  LOCATION
                  <input name="location" />
                </label>
                {sessionUser.role === 'super_user' && (
                  <label>
                    ASSIGN TO
                    <select name="assignedUserId" defaultValue="">
                      <option value="">Unassigned</option>
                      {accounts.map(account => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  NOTES
                  <textarea name="notes" rows={3} />
                </label>
                <button type="submit">Add appointment</button>
              </form>
            </section>
          </div>
        )}
        <section className="directory standalone-card">
          <div className="directory-heading">
            <div>
              <p className="eyebrow">THIS MONTH</p>
              <h2>Appointment list</h2>
            </div>
            <span>{appointments.length} appointments</span>
          </div>
          <EntryList
            label="Appointment list"
            items={appointments}
            getKey={appointment => appointment.id}
            title={appointment => appointment.title}
            details={appointment => [
              [
                'Date',
                appointment.appointmentDate +
                  (appointment.endDate && appointment.endDate !== appointment.appointmentDate
                    ? ' – ' + appointment.endDate
                    : '')
              ],
              ['Time', appointment.startTime || 'Any time'],
              ['Client', appointment.clientName],
              ['Location', appointment.location],
              ['Assigned to', appointment.assignedUserName],
              ['Assigned by', appointment.createdByName],
              ['Engineer reply', responseLabel(appointment.responseStatus)],
              [
                appointment.responseStatus === 'rejected' ? 'Reason for rejecting' : 'Reply note',
                appointment.responseNote
              ],
              [
                'Replied',
                appointment.respondedAt ? new Date(appointment.respondedAt).toLocaleString() : ''
              ],
              ['Notes', appointment.notes]
            ]}
            badge={appointment => <ResponseBadge status={appointment.responseStatus} />}
            empty="No appointments this month."
            line={appointment => [
              appointment.appointmentDate +
                (appointment.endDate && appointment.endDate !== appointment.appointmentDate
                  ? ' – ' + appointment.endDate
                  : ''),
              appointment.startTime || 'Any time',
              appointment.title,
              appointment.clientName,
              appointment.location,
              appointment.assignedUserName
            ]}
            actions={appointment => (
              <button type="button" onClick={() => setEditingAppointmentId(appointment.id)}>
                Edit
              </button>
            )}
          />
        </section>
        {appointments.find(item => item.id === editingAppointmentId) &&
          (() => {
            const appointment = appointments.find(item => item.id === editingAppointmentId)!;
            return (
              <section className="access-card standalone-card">
                <div className="directory-heading">
                  <div>
                    <p className="eyebrow">EDIT APPOINTMENT</p>
                    <h2>{appointment.title}</h2>
                  </div>
                  <button
                    className="access-button"
                    type="button"
                    onClick={() => setEditingAppointmentId(null)}
                  >
                    Close
                  </button>
                </div>
                <form key={appointment.id} className="edit-user-form" onSubmit={updateAppointment}>
                  <BookingDates start={appointment.appointmentDate} end={appointment.endDate} />
                  <label>
                    TITLE
                    <input name="title" defaultValue={appointment.title} required />
                  </label>
                  <label>
                    START TIME
                    <input
                      name="startTime"
                      type="time"
                      defaultValue={appointment.startTime || ''}
                    />
                  </label>
                  <label>
                    CLIENT
                    <select name="clientName" defaultValue={appointment.clientName}>
                      <option value="">No client</option>
                      {clients.map(client => (
                        <option key={client.id} value={client.name}>
                          {client.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    LOCATION
                    <input name="location" defaultValue={appointment.location} />
                  </label>
                  {sessionUser.role === 'super_user' && (
                    <label>
                      ASSIGN TO
                      <select name="assignedUserId" defaultValue={appointment.assignedUserId || ''}>
                        <option value="">Unassigned</option>
                        {accounts.map(account => (
                          <option key={account.id} value={account.id}>
                            {account.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    NOTES
                    <textarea name="notes" rows={4} defaultValue={appointment.notes} />
                  </label>
                  <div className="form-actions">
                    <button type="submit">Save appointment</button>
                    <button
                      className="delete-user"
                      type="button"
                      onClick={() => deleteAppointment(appointment)}
                    >
                      Delete
                    </button>
                  </div>
                </form>
              </section>
            );
          })()}
      </main>
    );

  const serviceVisitChoice = contractDetail?.visits.some(visit => visit.id === selectedVisitId)
    ? selectedVisitId
    : contractDetail?.visits[0]?.id;
  const openServiceTab = (
    <>
      <label className="service-visit-picker">
        Service visit
        <select
          aria-label="Service visit"
          value={serviceVisitChoice || ''}
          disabled={!contractDetail?.visits.length}
          onChange={event => {
            if (visitDetail) void openVisit(event.target.value);
            else setSelectedVisitId(event.target.value);
          }}
        >
          {!contractDetail?.visits.length && <option value="">No service visits</option>}
          {contractDetail?.visits.map(visit => (
            <option key={visit.id} value={visit.id}>
              {visit.serviceDate} — {visit.title}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-pressed={!!visitDetail}
        disabled={!serviceVisitChoice}
        onClick={() => {
          if (serviceVisitChoice) void openVisit(serviceVisitChoice);
        }}
      >
        Open service
      </button>
    </>
  );

  if (signedIn && dashboardPage === 'contracts' && visitDetail)
    return (
      <main className="workspace-shell subpage-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <div>
            <p className="eyebrow">SERVICE VISIT</p>
            <h1>
              {visitDetail.visit.clientName} · {visitDetail.visit.serviceDate}
            </h1>
          </div>
          <div className="visit-header-actions">
            <button className="access-button" onClick={printVisit}>
              Print / Save PDF
            </button>
            <button
              className="access-button"
              onClick={() => {
                ++visitRequest.current;
                setVisitDetail(null);
                setSelectedVisitId(null);
              }}
            >
              Back to contract
            </button>
          </div>
        </header>
        <nav className="contract-workspace-nav" aria-label="Contracts workspace">
          <button
            type="button"
            aria-pressed={false}
            onClick={() => {
              ++visitRequest.current;
              setVisitDetail(null);
            }}
          >
            Contracts
          </button>
          {openServiceTab}
        </nav>
        {(notice || error) && (
          <p className={error ? 'message error' : 'message success'} role="status">
            {error || notice}
          </p>
        )}
        <section className="visit-summary">
          <div>
            <strong>{visitDetail.visit.contractName}</strong>
            <span>{visitDetail.visit.contractNumber || 'No contract number'}</span>
          </div>
          <div>
            <strong>{visitDetail.visit.title}</strong>
            <span>{visitDetail.visit.location || 'No location'}</span>
          </div>
          <div>
            <strong>Status</strong>
            <span>{visitDetail.visit.status}</span>
          </div>
        </section>
        <section className="visit-device-list">
          {visitDetail.devices.map(device => (
            <article key={device.deviceId}>
              <div className="visit-device-heading">
                <div>
                  <h2>{device.deviceName || 'Unnamed device'}</h2>
                  <p>
                    Serial: {device.serialNumber || '—'} · Asset: {device.assetNumber || '—'} · Lot:{' '}
                    {device.lotNumber || '—'}
                  </p>
                </div>
                <span>{device.serviced ? 'Serviced' : 'Not serviced'}</span>
              </div>
              <form
                className="visit-device-form"
                onSubmit={event => saveVisitDevice(event, device)}
              >
                <label>
                  Service status
                  <select
                    name="serviceStatus"
                    defaultValue={device.serviceStatus || serviceStatus(device.serviced)}
                  >
                    {serviceStatuses.map(status => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                </label>
                <label className="wide">
                  COMMENTS
                  <textarea
                    name="comments"
                    rows={2}
                    defaultValue={device.comments}
                    disabled={visitDetail.visit.status === 'finalized'}
                  />
                </label>
                {visitDetail.visit.status === 'draft' && (
                  <button type="submit">Save device service</button>
                )}
              </form>
              <DeviceAttachments
                key={selectedVisitId + device.deviceId}
                visitId={selectedVisitId!}
                deviceId={device.deviceId}
                readOnly={visitDetail.visit.status !== 'draft'}
              />
              <div className="fitted-parts">
                <h3>Parts fitted</h3>
                {device.parts.map(part => (
                  <p key={part.id}>
                    <span>
                      {part.partNumber} · {part.partName} × {part.quantity}
                    </span>
                    {visitDetail.visit.status === 'draft' && (
                      <button type="button" onClick={() => removeVisitPart(part.id)}>
                        Remove
                      </button>
                    )}
                  </p>
                ))}
                {visitDetail.visit.status === 'draft' && (
                  <form onSubmit={event => addVisitPart(event, device)}>
                    <select name="partId" required defaultValue="">
                      <option value="" disabled>
                        Select stock part
                      </option>
                      {visitDetail.availableParts.map(part => (
                        <option key={part.id} value={part.id}>
                          {part.partNumber} — {part.name}
                        </option>
                      ))}
                    </select>
                    <input name="quantity" type="number" min="1" defaultValue="1" required />
                    <input name="notes" placeholder="Part notes" />
                    <button type="submit">Add fitted part</button>
                  </form>
                )}
              </div>
            </article>
          ))}
        </section>
        <section className="signature-section">
          <div className="directory-heading">
            <div>
              <p className="eyebrow">DIGITAL SIGN-OFF</p>
              <h2>Service report signatures</h2>
            </div>
            <span>{visitDetail.signatures.length}/2 signed</span>
          </div>
          <div className="signature-grid">
            {(['engineer', 'client'] as const).map(role => {
              const saved = visitDetail.signatures.find(signature => signature.signerRole === role);
              return saved ? (
                <article className="saved-signature" key={role}>
                  <img src={saved.signatureData} alt={`${role} signature`} />
                  <strong>{saved.signerName}</strong>
                  <span>
                    {role === 'engineer' ? 'Engineer' : 'Client representative'} ·{' '}
                    {new Date(saved.signedAt).toLocaleString()}
                  </span>
                </article>
              ) : (
                <SignaturePad
                  key={role}
                  role={role}
                  onSave={(name, data) => saveVisitSignature(role, name, data)}
                  disabled={visitDetail.visit.status === 'finalized'}
                />
              );
            })}
          </div>
          {visitDetail.visit.status === 'draft' && (
            <button className="finalize-report" type="button" onClick={finalizeVisit}>
              Finalize signed service report
            </button>
          )}
        </section>
      </main>
    );

  if (signedIn && dashboardPage === 'contracts')
    return (
      <main className="workspace-shell subpage-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <div>
            <p className="eyebrow">CLIENT SERVICE CONTRACTS</p>
            <h1>Contracts</h1>
          </div>
          {contractSection === 'browse' && contractDetail && (
            <button className="access-button" type="button" onClick={printContract}>
              Print / Save PDF
            </button>
          )}
        </header>
        {(notice || error) && (
          <p className={error ? 'message error' : 'message success'} role="status">
            {error || notice}
          </p>
        )}
        <nav className="contract-workspace-nav" aria-label="Contracts workspace">
          <button
            type="button"
            aria-pressed={contractSection === 'browse'}
            onClick={() => setContractSection('browse')}
          >
            Contracts
          </button>
          {openServiceTab}
          {sessionUser.role === 'super_user' && (
            <>
              <button
                type="button"
                aria-pressed={contractSection === 'new'}
                onClick={() => setContractSection('new')}
              >
                New contract
              </button>
              <button
                type="button"
                aria-pressed={contractSection === 'tools'}
                onClick={() => setContractSection('tools')}
              >
                Report tools
              </button>
            </>
          )}
        </nav>
        {contractSection === 'tools' ? (
          <section className="contract-tools-view">{contractImportTools}</section>
        ) : (
          <section
            className={
              'contracts-layout ' + (contractSection === 'new' ? 'contract-create-view' : '')
            }
          >
            <aside hidden={contractSection !== 'browse'} className="contract-browser">
              <label>
                SEARCH CONTRACTS
                <input
                  value={contractSearch}
                  onChange={event => setContractSearch(event.target.value)}
                  placeholder="Client, contract or number"
                />
              </label>
              <label>
                STATUS
                <select
                  value={contractStatus}
                  onChange={event => setContractStatus(event.target.value)}
                >
                  <option value="">All</option>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
              <button type="button" onClick={printContractList}>
                Print filtered list
              </button>
              <div>
                {filteredContracts.map(contract => (
                  <button
                    key={contract.id}
                    className={selectedContractId === contract.id ? 'active' : ''}
                    onClick={() => openContract(contract.id)}
                  >
                    <strong>{contract.clientName}</strong>
                    <span>{contract.name}</span>
                    <small>
                      {contract.deviceCount} devices · {contract.visitCount} visits
                    </small>
                  </button>
                ))}
                {!filteredContracts.length && <p className="muted">No assigned contracts found.</p>}
              </div>
            </aside>
            <div className="contract-content">
              {sessionUser.role === 'super_user' && contractSection === 'new' && (
                <section className="access-card">
                  <p className="eyebrow">NEW CONTRACT</p>
                  <h2>Create client contract</h2>
                  <form className="edit-user-form" onSubmit={createContract}>
                    <label>
                      CLIENT
                      <select name="clientId" required defaultValue="">
                        <option value="" disabled>
                          Select client
                        </option>
                        {clients.map(client => (
                          <option key={client.id} value={client.id}>
                            {client.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      CONTRACT NAME
                      <input name="name" required placeholder="e.g. Annual Service Contract" />
                    </label>
                    <label>
                      CONTRACT NUMBER
                      <input name="contractNumber" />
                    </label>
                    <label>
                      START DATE
                      <input name="startDate" type="date" />
                    </label>
                    <label>
                      END DATE
                      <input name="endDate" type="date" />
                    </label>
                    <fieldset className="report-users">
                      <legend>Assign complete contract</legend>
                      {accounts.map(account => (
                        <label key={account.id}>
                          <input type="checkbox" name={`user:${account.id}`} /> {account.name}
                        </label>
                      ))}
                    </fieldset>
                    <label>
                      NOTES
                      <textarea name="notes" rows={3} />
                    </label>
                    <button type="submit">Create contract</button>
                  </form>
                </section>
              )}
              {contractSection === 'browse' && !contractDetail && (
                <section className="contract-empty">
                  <h2>
                    {filteredContracts.length
                      ? error
                        ? 'Could not open contract'
                        : 'Loading contract…'
                      : contracts.length
                        ? 'No matching contracts'
                        : 'No contracts yet'}
                  </h2>
                  {sessionUser.role === 'super_user' && (
                    <button className="access-button" onClick={() => setContractSection('new')}>
                      Create a contract
                    </button>
                  )}
                </section>
              )}
              {contractSection === 'browse' && contractDetail && (
                <>
                  <section className="contract-hero">
                    <div>
                      <p className="eyebrow">
                        {contractDetail.contract.contractNumber || 'CLIENT CONTRACT'}
                      </p>
                      <h2>{contractDetail.contract.clientName}</h2>
                      <p>
                        {contractDetail.contract.name} · {contractDetail.contract.status}
                      </p>
                    </div>
                  </section>
                  <nav className="contract-detail-nav" aria-label="Selected contract">
                    <button
                      type="button"
                      aria-pressed={contractTab === 'overview'}
                      onClick={() => setContractTab('overview')}
                    >
                      Overview
                    </button>
                    <button
                      type="button"
                      aria-pressed={contractTab === 'devices'}
                      onClick={() => setContractTab('devices')}
                    >
                      Devices ({contractDetail.devices.length})
                    </button>
                    <button
                      type="button"
                      aria-pressed={contractTab === 'visits'}
                      onClick={() => setContractTab('visits')}
                    >
                      Service visits ({contractDetail.visits.length})
                    </button>
                  </nav>
                  {contractTab === 'overview' && (
                    <div className="contract-overview-actions">
                      <button onClick={() => setContractTab('devices')}>
                        <strong>
                          {
                            contractDetail.devices.filter(device => device.status === 'active')
                              .length
                          }
                        </strong>
                        Active devices →
                      </button>
                      <button onClick={() => setContractTab('visits')}>
                        <strong>{contractDetail.visits.length}</strong>Service history →
                      </button>
                    </div>
                  )}
                  <section hidden={contractTab !== 'overview'} className="contract-client-details">
                    <div>
                      <strong>Contact</strong>
                      <span>{contractDetail.contract.contactName || '—'}</span>
                    </div>
                    <div>
                      <strong>Email</strong>
                      <span>{contractDetail.contract.email || '—'}</span>
                    </div>
                    <div>
                      <strong>Phone</strong>
                      <span>{contractDetail.contract.phone || '—'}</span>
                    </div>
                    <div>
                      <strong>Address</strong>
                      <span>{contractDetail.contract.address || '—'}</span>
                    </div>
                  </section>
                  <section hidden={contractTab !== 'devices'} className="directory">
                    <div className="directory-heading">
                      <div>
                        <p className="eyebrow">REGISTERED EQUIPMENT</p>
                        <h2>Contract devices</h2>
                      </div>
                      <span>
                        {contractDetail.devices.filter(device => device.status === 'active').length}{' '}
                        active
                      </span>
                    </div>
                    <div className="contract-device-grid">
                      {contractDetail.devices.map(device => (
                        <article className={device.status} key={device.id}>
                          <div>
                            <strong>{device.deviceName || 'Unnamed device'}</strong>
                            <p>
                              Serial: {device.serialNumber || '—'} · Asset:{' '}
                              {device.assetNumber || '—'} · Lot: {device.lotNumber || '—'}
                            </p>
                            {device.decommissionReason && (
                              <small>{device.decommissionReason}</small>
                            )}
                          </div>
                          <button
                            className="access-button"
                            onClick={() =>
                              setDeviceStatus(
                                device,
                                device.status === 'active' ? 'decommissioned' : 'active'
                              )
                            }
                          >
                            {device.status === 'active' ? 'Decommission' : 'Reactivate'}
                          </button>
                        </article>
                      ))}
                    </div>
                  </section>
                  <section hidden={contractTab === 'overview'} className="contract-actions">
                    <form
                      hidden={contractTab !== 'devices'}
                      className="access-card"
                      onSubmit={addContractDevice}
                    >
                      <h3>Add purchased device</h3>
                      <label>
                        DEVICE NAME
                        <input name="deviceName" required />
                      </label>
                      <label>
                        SERIAL NUMBER
                        <input name="serialNumber" />
                      </label>
                      <label>
                        ASSET NUMBER
                        <input name="assetNumber" />
                      </label>
                      <label>
                        LOT NUMBER
                        <input name="lotNumber" />
                      </label>
                      <label>
                        PURCHASE DATE
                        <input name="purchasedOn" type="date" />
                      </label>
                      <label>
                        NOTES
                        <textarea name="notes" rows={2} />
                      </label>
                      <button type="submit">Add device</button>
                    </form>
                    <form
                      hidden={contractTab !== 'visits'}
                      className="access-card"
                      onSubmit={createServiceVisit}
                    >
                      <h3>Add service visit</h3>
                      <label>
                        SERVICE DATE
                        <input name="serviceDate" type="date" required />
                      </label>
                      <label>
                        TITLE
                        <input name="title" defaultValue="Scheduled service" required />
                      </label>
                      <label>
                        LOCATION
                        <input name="location" />
                      </label>
                      <label>
                        SUMMARY
                        <textarea name="summary" rows={2} />
                      </label>
                      <label>
                        RECOMMENDATIONS
                        <textarea name="recommendations" rows={2} />
                      </label>
                      <button type="submit">Add service visit</button>
                    </form>
                  </section>
                  <section hidden={contractTab !== 'visits'} className="directory">
                    <div className="directory-heading">
                      <div>
                        <p className="eyebrow">SERVICE HISTORY</p>
                        <h2>Visits by year and month</h2>
                      </div>
                      <span>{contractDetail.visits.length} visits</span>
                    </div>
                    <div className="visit-list">
                      {contractDetail.visits.map(visit => (
                        <article key={visit.id}>
                          <time>
                            {new Date(`${visit.serviceDate}T12:00:00`).toLocaleDateString(
                              undefined,
                              { year: 'numeric', month: 'long', day: 'numeric' }
                            )}
                          </time>
                          <div>
                            <strong>{visit.title}</strong>
                            <p>{visit.summary || 'No visit summary yet.'}</p>
                          </div>
                          <span>
                            {visit.deviceCount} devices · {visit.partCount} parts ·{' '}
                            {visit.signatureCount}/2 signatures
                          </span>
                        </article>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </div>
          </section>
        )}
      </main>
    );

  if (signedIn && dashboardPage === 'clients')
    return (
      <main className="workspace-shell subpage-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <div>
            <p className="eyebrow">CLIENT DIRECTORY</p>
            <h1>Clients</h1>
          </div>
        </header>
        {(notice || error) && (
          <p className={error ? 'message error' : 'message success'}>{error || notice}</p>
        )}
        <section className="filter-card">
          <label>
            SEARCH CLIENTS
            <input
              value={clientSearch}
              onChange={event => setClientSearch(event.target.value)}
              placeholder="Name, contact, email or phone"
            />
          </label>
        </section>
        {sessionUser.role === 'super_user' && (
          <details className="access-card">
            <summary>Add client</summary>
            <form className="edit-user-form" onSubmit={createClient}>
              <label>
                CLIENT NAME
                <input name="name" required />
              </label>
              <label>
                CONTACT NAME
                <input name="contactName" />
              </label>
              <label>
                EMAIL
                <input name="email" type="email" />
              </label>
              <label>
                PHONE
                <input name="phone" />
              </label>
              <label>
                ADDRESS
                <input name="address" />
              </label>
              <label>
                NOTES
                <textarea name="notes" rows={3} />
              </label>
              <button type="submit">Add client</button>
            </form>
          </details>
        )}
        <section className="directory">
          <div className="directory-heading">
            <div>
              <p className="eyebrow">ALL CLIENTS</p>
              <h2>Client list</h2>
            </div>
            <span>{filteredClients.length} clients</span>
            <button type="button" onClick={printClientList}>
              Print client list
            </button>
          </div>
          <EntryList
            label="Client list"
            items={filteredClients}
            getKey={client => client.id}
            title={client => client.name}
            details={client => [
              ['Contact', client.contactName],
              ['Phone', client.phone],
              ['Email', client.email],
              ['Address', client.address],
              ['Notes', client.notes]
            ]}
            empty="No clients match."
            line={client => [
              client.name,
              client.contactName,
              client.phone,
              client.email,
              client.address,
              client.notes
            ]}
            actions={client => (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setClientName(client.name);
                    navigateWorkspace('dashboard');
                  }}
                >
                  {uploads.filter(report => report.clientName === client.name).length} reports
                </button>
                <button type="button" onClick={() => navigateWorkspace('calendar')}>
                  {
                    appointments.filter(appointment => appointment.clientName === client.name)
                      .length
                  }{' '}
                  appointments
                </button>
              </>
            )}
          />
        </section>
      </main>
    );

  if (signedIn && dashboardPage === 'users' && sessionUser.role === 'super_user')
    return (
      <main className="workspace-shell subpage-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <div>
            <p className="eyebrow">ACCESS MANAGEMENT</p>
            <h1>Users</h1>
          </div>
          <span>{accounts.length} active accounts</span>
        </header>
        {(notice || error) && (
          <p className={error ? 'message error' : 'message success'} role="status">
            {error || notice}
          </p>
        )}
        <section className="admin-grid standalone-card">
          <form className="create-card" onSubmit={createAccount}>
            <p className="eyebrow">CREATE LOGIN</p>
            <h2>Department account</h2>
            <label>
              FULL NAME
              <input name="name" required />
            </label>
            <label>
              WORK EMAIL
              <input name="email" type="email" required />
            </label>
            <div className="form-pair">
              <label>
                DEPARTMENT
                <select name="department" defaultValue="" required>
                  <option value="" disabled>
                    Select department
                  </option>
                  {departments.map(department => (
                    <option key={department}>{department}</option>
                  ))}
                </select>
              </label>
              <label>
                ROLE
                <select name="role" defaultValue="Department User">
                  {roles.map(role => (
                    <option key={role}>{role}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              TEMPORARY PASSWORD
              <input name="password" type="password" minLength={12} required />
            </label>
            <label className="export-permission">
              <input type="checkbox" name="canExport" /> Allow exports
            </label>
            <fieldset className="permission-picker">
              <legend>COLUMN ACCESS</legend>
              {reportFields.map(field => (
                <div key={field}>
                  <strong>{field}</strong>
                  <label>
                    <input type="checkbox" name={`read:${field}`} defaultChecked /> Read
                  </label>
                  <label>
                    <input type="checkbox" name={`write:${field}`} /> Write
                  </label>
                </div>
              ))}
            </fieldset>
            <button className="primary" type="submit">
              Create login <span>→</span>
            </button>
          </form>
          <section className="directory">
            <div className="directory-heading">
              <div>
                <p className="eyebrow">ACCOUNT DIRECTORY</p>
                <h2>Department logins</h2>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Department</th>
                    <th>Role</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(account => (
                    <tr key={account.id}>
                      <td>
                        <strong>{account.name}</strong>
                        <small>{account.email}</small>
                        <small className={account.mfaEnabled ? 'mfa-on' : 'mfa-off'}>
                          {account.mfaEnabled
                            ? 'Authenticator set up'
                            : 'Authenticator: set up at next sign-in'}
                        </small>
                      </td>
                      <td>{account.department}</td>
                      <td>
                        <span className="role-pill">{account.role}</span>
                      </td>
                      <td className="account-actions">
                        <button className="access-button" onClick={() => openAccessTab(account)}>
                          Permissions
                        </button>
                        <button
                          className="access-button"
                          onClick={() => setEditingAccountId(account.id)}
                        >
                          Edit
                        </button>
                        {account.mfaEnabled && account.id !== sessionUser.id && (
                          <button
                            className="access-button"
                            onClick={() => void resetAuthenticator(account)}
                          >
                            Reset authenticator
                          </button>
                        )}
                        <button className="delete-user" onClick={() => deleteAccount(account)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </section>
        {editingAccount && (
          <section className="access-card standalone-card">
            <div className="directory-heading">
              <div>
                <p className="eyebrow">EDIT USER</p>
                <h2>{editingAccount.name}</h2>
              </div>
              <button className="access-button" onClick={() => setEditingAccountId(null)}>
                Close
              </button>
            </div>
            <form className="edit-user-form" onSubmit={saveAccountEdit}>
              <label>
                FULL NAME
                <input name="name" defaultValue={editingAccount.name} required />
              </label>
              <label>
                WORK EMAIL
                <input name="email" type="email" defaultValue={editingAccount.email} required />
              </label>
              <label>
                DEPARTMENT
                <select name="department" defaultValue={editingAccount.department}>
                  {departments.map(department => (
                    <option key={department}>{department}</option>
                  ))}
                </select>
              </label>
              <label>
                ROLE
                <select name="role" defaultValue={editingAccount.role}>
                  {roles.map(role => (
                    <option key={role}>{role}</option>
                  ))}
                </select>
              </label>
              <label className="export-permission">
                <input name="canExport" type="checkbox" defaultChecked={editingAccount.canExport} />{' '}
                Allow exports
              </label>
              <button type="submit">Save changes</button>
            </form>
          </section>
        )}
        <CustomerAccounts clients={clients} />
      </main>
    );

  if (signedIn && dashboardPage === 'access' && accessAccount)
    return (
      <main className="workspace-shell subpage-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <a className="brand" href="#top">
            <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care" />
            <span>
              Reports<small>SUPER USER WORKSPACE</small>
            </span>
          </a>
          <button className="back-page" onClick={() => setDashboardPage('dashboard')}>
            ← Back to dashboard
          </button>
        </header>
        <section className="access-card standalone-card">
          <p className="eyebrow">COLUMN PERMISSIONS</p>
          <h1>Manage access: {accessAccount.name}</h1>
          <p className="muted">Choose which report columns this user can read or write.</p>
          <label className="export-permission">
            <input
              type="checkbox"
              checked={accessAccount.canExport}
              onChange={event => updateExportAccess(accessAccount.id, event.target.checked)}
            />{' '}
            Allow filtered CSV and PDF exports
          </label>
          <div className="access-grid">
            {reportFields.map(field => {
              const access = accessAccount.permissions[field] || { read: false, write: false };
              return (
                <div key={field}>
                  <strong>{field}</strong>
                  <label>
                    <input
                      type="checkbox"
                      checked={access.read}
                      onChange={event =>
                        updatePermission(accessAccount.id, field, 'read', event.target.checked)
                      }
                    />{' '}
                    Read
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={access.write}
                      onChange={event =>
                        updatePermission(accessAccount.id, field, 'write', event.target.checked)
                      }
                    />{' '}
                    Write
                  </label>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    );

  if (signedIn && dashboardPage === 'spare-parts' && sessionUser.role === 'engineer')
    return (
      <main className="workspace-shell subpage-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <div>
            <p className="eyebrow">PERSONAL STOCK</p>
            <h1>Engineer stock</h1>
          </div>
        </header>
        <section className="inventory-panel standalone-card">
          <div>
            <p className="eyebrow">PARTS ASSIGNED TO YOU</p>
            <h2>Record parts as they are fitted</h2>
            <p className="muted">
              Warehouse users assign stock to you. Recording a fitting removes the quantity from
              your personal stock.
            </p>
          </div>
          {(notice || error) && (
            <p className={error ? 'message error' : 'message success'} role="status">
              {error || notice}
            </p>
          )}
          <div className="inventory-grid">
            <form onSubmit={fitPart} className="inventory-form">
              <h3>Record fitted part</h3>
              <input name="engineerId" type="hidden" value={sessionUser.id} />
              <label>
                PART
                <select name="partId" required defaultValue="">
                  <option value="" disabled>
                    Select part
                  </option>
                  {parts
                    .filter(part => (engineerStock[stockKey(sessionUser.id, part.id)] || 0) > 0)
                    .map(part => (
                      <option key={part.id} value={part.id}>
                        {part.partNumber} — {part.name} (
                        {engineerStock[stockKey(sessionUser.id, part.id)]} available)
                      </option>
                    ))}
                </select>
              </label>
              <label>
                DEVICE / MACHINE
                <input name="device" placeholder="e.g. Oxygen Concentrator OC-5" required />
              </label>
              <label>
                QUANTITY
                <input name="quantity" type="number" min="1" step="1" required />
              </label>
              <button type="submit">Record fitting</button>
            </form>
            <div className="stock-tables engineer-personal-stock">
              <div>
                <h3>Your current stock</h3>
                {parts
                  .filter(part => (engineerStock[stockKey(sessionUser.id, part.id)] || 0) > 0)
                  .map(part => (
                    <p key={part.id}>
                      <strong>{part.partNumber}</strong>
                      <span>{part.name}</span>
                      <b>{engineerStock[stockKey(sessionUser.id, part.id)]}</b>
                    </p>
                  ))}
                {!parts.some(
                  part => (engineerStock[stockKey(sessionUser.id, part.id)] || 0) > 0
                ) && <p className="muted">No parts are currently assigned to you.</p>}
              </div>
            </div>
          </div>
        </section>
      </main>
    );

  if (signedIn && dashboardPage === 'spare-parts')
    return (
      <main className="workspace-shell subpage-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <a className="brand" href="#top">
            <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care" />
            <span>
              Reports<small>SUPER USER WORKSPACE</small>
            </span>
          </a>
          <button className="back-page" onClick={() => setDashboardPage('dashboard')}>
            ← Back to dashboard
          </button>
        </header>
        <section className="inventory-panel standalone-card">
          <div className="stock-page-heading">
            <h1>Spare Parts control</h1>
            <label className="stock-import-control">
              Import Stock
              <input
                type="file"
                aria-label="Import Stock CSV or Excel"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) void importStockFile(file);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          {(notice || error) && (
            <p className={error ? 'message error' : 'message success'} role="status">
              {error || notice}
            </p>
          )}
          <form onSubmit={saveWarehousePart} className="inventory-form">
            <h3>Add or update warehouse part</h3>
            <label>
              PART NUMBER
              <input name="partNumber" placeholder="e.g. SP-OC5-FLT" required />
            </label>
            <label>
              PART NAME
              <input name="name" placeholder="e.g. OC-5 Intake Filter" required />
            </label>
            <label>
              LOCATION
              <input name="location" placeholder="e.g. Warehouse A — Shelf B2" maxLength={160} />
            </label>
            <label>
              WAREHOUSE QUANTITY
              <input name="warehouseQuantity" type="number" min="0" step="1" required />
            </label>
            <button type="submit">Save warehouse part</button>
          </form>
          <div className="inventory-grid">
            <form onSubmit={assignPart} className="inventory-form">
              <h3>Assign from warehouse</h3>
              <label>
                PART
                <select name="partId" required defaultValue="">
                  <option value="" disabled>
                    Select part
                  </option>
                  {parts.map(part => (
                    <option key={part.id} value={part.id}>
                      {part.partNumber} — {part.name} ({part.warehouseQty} available)
                    </option>
                  ))}
                </select>
              </label>
              <label>
                ENGINEER
                <select name="engineerId" required defaultValue="">
                  <option value="" disabled>
                    Select engineer
                  </option>
                  {engineers.map(engineer => (
                    <option key={engineer.id} value={engineer.id}>
                      {engineer.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                QUANTITY
                <input name="quantity" type="number" min="1" step="1" required />
              </label>
              <button type="submit">Assign part</button>
            </form>
            <form onSubmit={fitPart} className="inventory-form">
              <h3>Record fitted part</h3>
              <label>
                ENGINEER
                <select name="engineerId" required defaultValue="">
                  <option value="" disabled>
                    Select engineer
                  </option>
                  {engineers.map(engineer => (
                    <option key={engineer.id} value={engineer.id}>
                      {engineer.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                PART
                <select name="partId" required defaultValue="">
                  <option value="" disabled>
                    Select part
                  </option>
                  {parts.map(part => (
                    <option key={part.id} value={part.id}>
                      {part.partNumber} — {part.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                DEVICE / MACHINE
                <input name="device" placeholder="e.g. Oxygen Concentrator OC-5" required />
              </label>
              <label>
                QUANTITY
                <input name="quantity" type="number" min="1" step="1" required />
              </label>
              <button type="submit">Record fitting</button>
            </form>
          </div>
          <div className="stock-tables">
            <div>
              <h3>Warehouse stock</h3>
              {parts.map(part => (
                <p key={part.id}>
                  <strong>{part.partNumber}</strong>
                  <span>
                    {part.name}
                    {part.location && <small>{part.location}</small>}
                  </span>
                  <b>{part.warehouseQty}</b>
                </p>
              ))}
            </div>
            <div>
              <h3>Engineer stock</h3>
              {engineers.flatMap(engineer =>
                parts
                  .filter(part => (engineerStock[stockKey(engineer.id, part.id)] || 0) > 0)
                  .map(part => (
                    <p key={`${engineer.id}-${part.id}`}>
                      <strong>{engineer.name}</strong>
                      <span>
                        {part.partNumber} — {part.name}
                      </span>
                      <b>{engineerStock[stockKey(engineer.id, part.id)]}</b>
                    </p>
                  ))
              )}
              {!Object.values(engineerStock).some(quantity => quantity > 0) && (
                <p className="muted">No parts currently assigned to engineers.</p>
              )}
            </div>
          </div>
          {stockMovements.length > 0 && (
            <div className="movement-list">
              <h3>Recent movements</h3>
              {stockMovements.slice(0, 8).map(movement => (
                <p key={movement.id}>
                  <time>{movement.time}</time>
                  <strong>{movement.type}</strong>
                  <span>
                    {parts.find(part => part.id === movement.partId)?.partNumber} ×{' '}
                    {movement.quantity} ·{' '}
                    {accounts.find(account => account.id === movement.engineerId)?.name} ·{' '}
                    {movement.detail}
                  </span>
                </p>
              ))}
            </div>
          )}
        </section>
      </main>
    );
  if (signedIn)
    return (
      <main className="workspace-shell">
        <AppSidebar
          page={dashboardPage}
          user={sessionUser}
          navigate={navigateWorkspace}
          logout={signOut}
        />
        <header className="workspace-header">
          <a className="brand" href="#top">
            <img src="/oxygen-care-logo-sidebar.png" alt="Oxygen Care" />
            <span>
              Reports<small>SUPER USER WORKSPACE</small>
            </span>
          </a>
          <div className="account-chip">
            <span className="avatar">SU</span>
            <span>{sessionUser.displayName} · Super User</span>
          </div>
        </header>

        {(notice || error) && (
          <p className={error ? 'message error' : 'message success'} role="status">
            {error || notice}
          </p>
        )}

        <section className="filter-card">
          <div className="filter-controls">
            <label>
              User
              <select value={userFilter} onChange={event => setUserFilter(event.target.value)}>
                <option value="">All users</option>
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
            {reportFields.map(field => (
              <label key={field}>
                {field}
                {isServiceField(field) ? (
                  <select
                    aria-label="Filter service status"
                    value={filters[field] || ''}
                    onChange={event =>
                      setFilters(current => ({ ...current, [field]: event.target.value }))
                    }
                  >
                    <option value="">All service statuses</option>
                    {serviceStatuses.map(status => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={filters[field] || ''}
                    onChange={event =>
                      setFilters(current => ({ ...current, [field]: event.target.value }))
                    }
                    placeholder={`Filter ${field}`}
                  />
                )}
              </label>
            ))}
          </div>
          <div className="export-actions">
            <button
              className="clear-filters"
              type="button"
              onClick={() => {
                setFilters({});
                setUserFilter('');
              }}
            >
              Clear filters
            </button>
            <span>{filteredRecords.length} matching records</span>
            <button type="button" onClick={exportCsv}>
              Export CSV
            </button>
            <button type="button" onClick={exportPdf}>
              Export PDF
            </button>
          </div>
        </section>
        {uploads.length > 0 && (
          <section className="uploads-card">
            <p className="eyebrow">UPLOADED REPORTS</p>
            <h2>Open an uploaded report</h2>
            <EntryList
              label="Uploaded reports"
              items={uploads}
              getKey={report => report.id}
              onOpen={report => openReport(report)}
              line={report => [
                report.clientName,
                report.fileName,
                `${report.rowCount} records`,
                accounts
                  .filter(account => report.userIds.includes(account.id))
                  .map(account => account.name)
                  .join(', ')
              ]}
              actions={report => (
                <button type="button" onClick={() => openReport(report)}>
                  Open
                </button>
              )}
            />
          </section>
        )}
        <section className="directory report-table">
          <div className="directory-heading">
            <div>
              <p className="eyebrow">IMPORTED DATA</p>
              <h2>Machine activity register</h2>
            </div>
            <span>
              {filteredRecords.length} of {records.length} records
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Users</th>
                  <th>Machine history</th>
                  {reportFields.map(field => (
                    <th key={field}>{field}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map(record => (
                  <tr
                    key={record.id}
                    className="machine-history-row"
                    onClick={event => {
                      if (!(event.target as HTMLElement).closest('button,input,select,textarea,a'))
                        openMachineHistory(record);
                    }}
                  >
                    <td>
                      {accounts
                        .filter(account => record.ownerIds.includes(account.id))
                        .map(account => account.name)
                        .join(', ') || '—'}
                    </td>
                    <td>
                      <button
                        className="machine-history-link"
                        aria-label={
                          'Open history for ' +
                          (record.deviceName || record.serialNumber || 'machine')
                        }
                        onClick={() => openMachineHistory(record)}
                      >
                        Open history
                      </button>
                    </td>
                    {reportFields.map(field => (
                      <td
                        key={field}
                        className={
                          field === 'Comments' || fieldTypes[field] === 'comments' ? 'comments' : ''
                        }
                      >
                        {isServiceField(field) ? (
                          <select
                            aria-label={'Update ' + field}
                            disabled={!canWriteField(field)}
                            value={recordValue(record, field)}
                            onChange={event => {
                              void api('/api/report-rows/' + record.id, {
                                method: 'PATCH',
                                body: JSON.stringify({ fields: { [field]: event.target.value } })
                              })
                                .then(() => loadReports())
                                .catch(reason => setError(reason.message));
                            }}
                          >
                            {Array.from(
                              new Set([...serviceStatuses, recordValue(record, field)])
                            ).map(status => (
                              <option key={status}>{status}</option>
                            ))}
                          </select>
                        ) : fieldTypes[field] === 'checkbox' ? (
                          <input
                            type="checkbox"
                            checked={['true', 'yes', '1', 'checked'].includes(
                              (recordValue(record, field) || '').toLowerCase()
                            )}
                            disabled={!canWriteField(field)}
                            onChange={event =>
                              updateReportCheckbox(record, field, event.target.checked)
                            }
                            aria-label={'Update ' + field}
                          />
                        ) : (
                          recordValue(record, field) || '—'
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {csvPreviewOverlay}
      </main>
    );

  return null;
}
