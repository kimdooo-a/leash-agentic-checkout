// All money inside Leash is integer cents. Strings only at the PayPal boundary.

export function toCents(value) {
  if (typeof value === 'number') return Math.round(value * 100);
  const s = String(value).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`not a money value: ${value}`);
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return s.startsWith('-') ? -cents : cents;
}

export function toPayPalValue(cents) {
  if (!Number.isInteger(cents)) throw new Error(`cents must be an integer: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function fmt(cents, currency = 'USD') {
  return `${currency === 'USD' ? '$' : currency + ' '}${toPayPalValue(cents)}`;
}
