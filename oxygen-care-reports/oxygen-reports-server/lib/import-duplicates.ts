export type ImportIdentity = { serialNumber?: unknown; assetNumber?: unknown };
export type ImportWarning = { row: number; identifier: string; reason: string };
export const normalizedIdentifier = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
export function reviewImport(rows: ImportIdentity[], existing: ImportIdentity[]) {
  const serials = new Set<string>(),
    assets = new Set<string>(),
    fallbackAssets = new Set<string>();
  const add = (row: ImportIdentity) => {
    const s = normalizedIdentifier(row.serialNumber),
      a = normalizedIdentifier(row.assetNumber);
    if (s) serials.add(s);
    if (a) {
      assets.add(a);
      if (!s) fallbackAssets.add(a);
    }
  };
  const contains = (row: ImportIdentity) => {
    const s = normalizedIdentifier(row.serialNumber),
      a = normalizedIdentifier(row.assetNumber);
    return s ? serials.has(s) || (!!a && fallbackAssets.has(a)) : !!a && assets.has(a);
  };
  existing.forEach(add);
  const accepted: number[] = [],
    warnings: ImportWarning[] = [];
  rows.forEach((row, index) => {
    const serial = normalizedIdentifier(row.serialNumber),
      asset = normalizedIdentifier(row.assetNumber),
      identifier = String(row.serialNumber || row.assetNumber || '').trim();
    if (!serial && !asset) {
      warnings.push({
        row: index + 2,
        identifier: '—',
        reason: 'Missing serial and asset number — cannot identify safely'
      });
      return;
    }
    if (contains(row)) {
      warnings.push({
        row: index + 2,
        identifier,
        reason: 'Duplicate in this file or already recorded for this service visit'
      });
      return;
    }
    accepted.push(index);
    add(row);
  });
  return { accepted, warnings };
}
