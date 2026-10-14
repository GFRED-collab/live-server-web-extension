export const standardProperties: Record<string, string> = Object.assign(Object.create(null), {
  'Device/Machine Name': 'deviceName',
  'Serial Number': 'serialNumber',
  'Lot Number': 'lotNumber',
  'Asset Number': 'assetNumber',
  'Amount in Hours': 'hoursIn',
  'Amount out of Hours': 'hoursOut',
  Comments: 'comments'
});
export function secureReportRow(row: Record<string, unknown>, allowed: Set<string>) {
  const output = { ...row, values: {} } as Record<string, unknown>;
  for (const [source, key] of Object.entries(standardProperties))
    if (!allowed.has(source)) output[key] = '';
  const values = (row.values && typeof row.values === 'object' ? row.values : {}) as Record<
    string,
    unknown
  >;
  output.values = Object.fromEntries(
    Object.entries(values).filter(([source]) => allowed.has(source))
  );
  return output;
}
