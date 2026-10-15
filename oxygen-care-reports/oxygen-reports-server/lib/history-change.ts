type Item = Record<string, unknown>;
const text = (value: unknown) =>
  value === null || value === undefined || value === ''
    ? 'Not set'
    : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : 'Recorded value';
export function historyChange(item: Item) {
  const detail =
    item.detail && typeof item.detail === 'object' && !Array.isArray(item.detail)
      ? (item.detail as Item)
      : {};
  const labels: Record<string, string> = {
    report_row: 'Device report',
    device: 'Device',
    service_visit: 'Service visit',
    service_visit_device: 'Device service record',
    repair_entry: 'Repair entry',
    service_signature: 'Service signature',
    fitted_part: 'Fitted part',
    docket: 'Completion docket'
  };
  const label = Object.hasOwn(labels, String(item.entityType))
    ? labels[String(item.entityType)]
    : 'Record';
  const actions: Record<string, string> = {
    updated: 'updated',
    created: 'created',
    deleted: 'deleted',
    uploaded: 'uploaded',
    fitted: 'fitted',
    assigned: 'assigned'
  };
  const action = Object.hasOwn(actions, String(item.kind)) ? actions[String(item.kind)] : 'changed';
  const changes = Array.isArray(detail.changes)
    ? detail.changes.filter(
        (entry): entry is Item =>
          !!entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          typeof entry.field === 'string'
      )
    : [];
  const fields = Array.isArray(detail.fields)
    ? detail.fields.filter((field): field is string => typeof field === 'string')
    : [];
  const lines = changes.length
    ? changes.map(change => `${change.field}: ${text(change.from)} → ${text(change.to)}`)
    : fields.length
      ? [
          `Fields updated: ${fields.join(', ')}. Previous and new values were not recorded for this older event.`
        ]
      : ['Change recorded. Detailed value changes are not available for this event.'];
  return { title: label + ' ' + action, actor: text(item.actor), lines };
}
