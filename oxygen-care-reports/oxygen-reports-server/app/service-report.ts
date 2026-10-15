import { brandPrintWindow } from './print-layout';
import { serviceStatus } from '../lib/service-status';

/** The fields of a signed service report, shared by the staff and customer copies. */
export type ServiceReport = {
  visit: {
    serviceDate: string;
    title: string;
    location: string;
    status: string;
    summary: string;
    recommendations: string;
    contractName: string;
    contractNumber: string;
    clientName: string;
    contactName: string;
    email: string;
    phone: string;
    address: string;
  };
  devices: Array<{
    deviceName: string;
    serialNumber: string;
    assetNumber: string;
    lotNumber: string;
    serviced?: boolean;
    serviceStatus?: string;
    comments: string;
    parts: Array<{ partNumber: string; partName: string; quantity: number }>;
  }>;
  signatures: Array<{
    signerRole: 'engineer' | 'client';
    signerName: string;
    signatureData: string;
    signedAt: string;
  }>;
};

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c
  );

export function serviceReportHtml({ visit: v, devices, signatures }: ServiceReport) {
  const e = escapeHtml;
  return `<!doctype html><title>${e(v.clientName)} service report</title><style>body{font:13px Arial;color:#173f4a;margin:28px}header{display:flex;justify-content:space-between;border-bottom:3px solid #277b91;padding-bottom:14px}h1,h2{margin:0 0 8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0}.card{border:1px solid #cadde1;border-radius:8px;padding:12px}table{width:100%;border-collapse:collapse;margin:12px 0 24px}th,td{padding:7px;border-bottom:1px solid #dce9ec;text-align:left;vertical-align:top}th{color:#277b91}.sig{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:35px}.sig img{max-width:100%;height:85px;object-fit:contain}.line{border-top:1px solid #173f4a;padding-top:7px}@media print{.no-print{display:none}}</style><header><div><h1>Oxygen Care</h1><p>Full service report · ${e(v.serviceDate)}</p></div><button class="no-print" onclick="window.print()">Print / Save PDF</button></header><div class="grid"><div class="card"><h2>Client</h2><b>${e(v.clientName)}</b><p>${e(v.contactName)}</p><p>${e(v.address)}</p><p>${e(v.email)} · ${e(v.phone)}</p></div><div class="card"><h2>Contract and visit</h2><b>${e(v.contractName)}</b><p>${e(v.contractNumber)}</p><p>${e(v.title)} · ${e(v.location)}</p><p>Status: ${e(v.status)}</p></div></div><h2>Device service details</h2><table><thead><tr><th>Device</th><th>Identifiers</th><th>Service status</th><th>Comments / parts fitted</th></tr></thead><tbody>${devices.map(d => `<tr><td>${e(d.deviceName)}</td><td>Serial: ${e(d.serialNumber || '—')}<br>Asset: ${e(d.assetNumber || '—')}<br>Lot: ${e(d.lotNumber || '—')}</td><td>${e(d.serviceStatus || serviceStatus(d.serviced))}</td><td>${e(d.comments)}${d.parts.map(p => `<br>${e(p.partNumber)} ${e(p.partName)} × ${e(p.quantity)}`).join('')}</td></tr>`).join('')}</tbody></table><div class="card"><h2>Summary</h2><p>${e(v.summary || '—')}</p><h2>Recommendations</h2><p>${e(v.recommendations || '—')}</p></div><div class="sig">${(
    ['engineer', 'client'] as const
  )
    .map(role => {
      const s = signatures.find(item => item.signerRole === role);
      const label = role === 'engineer' ? 'Engineer' : 'Client representative';
      // Signatures are stored as PNG data URLs; anything else is not rendered as an image.
      const image =
        s && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s.signatureData)
          ? `<img src="${e(s.signatureData)}">`
          : '';
      return `<div>${s ? `${image}<div class="line"><b>${e(s.signerName)}</b><br>${label} · ${e(new Date(s.signedAt).toLocaleString())}</div>` : `<div class="line">${label} signature</div>`}</div>`;
    })
    .join('')}</div>`;
}

/** Write the report into a window opened by the caller and apply the print branding. */
export function writeServiceReport(popup: Window, report: ServiceReport) {
  popup.document.open();
  popup.document.write(serviceReportHtml(report));
  popup.document.close();
  brandPrintWindow(popup);
}

/** Open the report in a branded print window. Returns false if the browser blocked the pop-up. */
export function openServiceReport(report: ServiceReport) {
  const popup = window.open('', '_blank');
  if (!popup) return false;
  writeServiceReport(popup, report);
  return true;
}
