// Normalizes Nigerian phone numbers to E.164 (+234XXXXXXXXXX) so invite
// phone numbers and User.phone can always be compared exactly.
export function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;

  if (digits.startsWith('+234')) return digits;
  if (digits.startsWith('234')) return `+${digits}`;
  if (digits.startsWith('0')) return `+234${digits.slice(1)}`;
  if (digits.length === 10) return `+234${digits}`; // e.g. 8031234567, no leading 0
  return digits.startsWith('+') ? digits : `+${digits}`;
}