/** Apply the shared Oxygen Care stationery after a print document has been built. */
export function brandPrintWindow(popup: Window) {
  popup.opener = null;
  const doc = popup.document;
  const referrer=doc.createElement('meta');referrer.name='referrer';referrer.content='no-referrer';doc.head.append(referrer);
  const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";doc.head.append(policy);
  doc.documentElement.lang = 'en';
  if (doc.querySelector('.oxygen-print-brand')) return;
  const style = doc.createElement('style');
  style.textContent = `
    @page { size: A4 portrait; margin: 12mm; }
    * { box-sizing:border-box; }
    body { width:100%; max-width:186mm; margin:20px auto; padding:0; font:11px/1.3 'Courier New',Courier,monospace; color:#111; background:white; }
    body header,body footer,body table,body th,body td,body dl,body dt,body dd,body .card,body .line,body .signature,body .oxygen-print-brand { border:0!important; box-shadow:none!important; background:transparent!important; }
    .oxygen-print-brand { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-bottom:8px; margin-bottom:10px; }
    .oxygen-print-brand img { width:165px; height:auto; }
    .oxygen-print-brand span { font-size:11px; text-align:right; white-space:pre-line; }
    .oxygen-print-tools { display:flex; gap:10px; margin-bottom:18px; }
    .oxygen-print-tools button { padding:10px 16px; border:1px solid #277b91; border-radius:6px; color:#173f4a; background:white; cursor:pointer; }
    h1 { font-size:18px; margin:8px 0; } h2 { font-size:14px; margin:8px 0; } p,td,dd { overflow-wrap:anywhere; white-space:pre-wrap; } img { max-width:100%; } h1,h2,h3,dt { break-after:avoid; }
    table { width:100%; border-collapse:collapse; table-layout:fixed; }
    th { color:#111; } th,td { padding:4px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
    thead { display:table-header-group; } tr,.card,.signature,.sig>div { break-inside:avoid; }
    dl { display:grid; grid-template-columns:38mm minmax(0,1fr); gap:0; margin:8px 0; }
    dt { padding:4px; font-weight:bold; } dd { margin:0; padding:4px; min-height:0; }
    footer.oxygen-print-footer { margin-top:12px; padding-top:6px; font-size:9px; }
    @media print { body { max-width:none; margin:0; padding:0; } button,.no-print,.oxygen-print-tools { display:none!important; } .oxygen-print-brand { break-inside:avoid; } }
  `;
  doc.head.append(style);
  // Replace old print controls with one toolbar shared by every form.
  doc.querySelectorAll('button').forEach(button => button.remove());
  const brand = doc.createElement('div'); brand.className = 'oxygen-print-brand';
  const logo = doc.createElement('img'); logo.alt = 'Oxygen Care — support for life';
  // Embed the logo so the print document is self-contained, including Save PDF.
  const logoReady = fetch('/oxygen-care-logo-sidebar.png').then(response => {
    if (!response.ok) throw new Error('Logo could not be loaded.');
    return response.blob();
  }).then(blob => new Promise<string>((resolve,reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob);
  })).then(source => { logo.src = source; return logo.decode(); });
  const date = doc.createElement('span'); date.textContent = 'Oxygen Care Reports\nPrepared: ' + new Date().toLocaleDateString('en-IE');
  brand.append(logo,date); doc.body.prepend(brand);
  const toolbar = doc.createElement('div'); toolbar.className = 'oxygen-print-tools';
  const print = doc.createElement('button'); print.textContent = 'Print / Save PDF';
  print.disabled = true;
  void logoReady.then(() => { print.disabled = false; }).catch(() => { print.textContent = 'Logo unavailable — reopen preview'; });
  print.onclick = async () => { await logoReady; await Promise.all(Array.from(doc.images).map(img => img.decode().catch(() => undefined))); popup.focus(); popup.print(); };
  const close = doc.createElement('button'); close.textContent = 'Close'; close.onclick = () => popup.close();
  toolbar.append(print,close); brand.before(toolbar);
  const footer = doc.createElement('footer'); footer.className = 'oxygen-print-footer'; footer.textContent = 'Oxygen Care · ' + doc.title;
  doc.body.append(footer);
}
