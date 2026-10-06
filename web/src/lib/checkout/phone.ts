// Input normalization only: NANP syntax cannot establish U.S. residency or ownership.
export const PHONE_HELP = 'Enter a 10-digit U.S. phone number.';
export function normalizeUSPhone(value: string): string {
  const input = value.trim();
  if (input.startsWith('+') && !input.startsWith('+1'))
    throw new Error(
      'Only U.S. phone numbers with country code +1 are supported.',
    );
  if (!/^[0-9()+.\s-]+$/.test(input) || /\+/.test(input.slice(1)))
    throw new Error(PHONE_HELP);
  const digits = input.replace(/\D/g, '');
  const national = input.startsWith('+1') ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) throw new Error(PHONE_HELP);
  return `+1${national}`;
}

// Partial digits support ordinary editing. Formatted/autofilled values must be
// complete and valid before replacing the visible national number. Never truncate.
export function phoneEntry(value: string): string {
  if (/^\d{0,10}$/.test(value)) return value;
  return normalizeUSPhone(value).slice(2);
}
