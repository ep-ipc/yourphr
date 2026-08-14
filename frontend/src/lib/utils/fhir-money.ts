/**
 * Format a FHIR Money for display.
 *
 * Shared so the card and the list agree — the same amount must not appear as "$400.00" on one
 * screen and "400 USD" on another (the lesson of #526).
 *
 * Currency comes from the resource. Nothing is assumed to be dollars: a record from outside the US
 * carries its own currency and rendering it with a dollar sign would be stating something the
 * source did not (#262).
 */
export function money(amount: any): string {
  const value = amount?.value;
  if (value === undefined || value === null || isNaN(Number(value))) {
    return '';
  }
  const currency = amount?.currency || 'USD';
  try {
    return new Intl.NumberFormat(undefined, {style: 'currency', currency}).format(Number(value));
  } catch {
    // An unknown or malformed currency code must not cost the reader the number.
    return `${value} ${currency}`;
  }
}
