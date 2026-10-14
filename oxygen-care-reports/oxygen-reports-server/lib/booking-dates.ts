export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function coversDate(booking: { appointmentDate: string; endDate?: string }, date: string) {
  return booking.appointmentDate <= date && (booking.endDate || booking.appointmentDate) >= date;
}
