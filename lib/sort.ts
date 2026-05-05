/**
 * Natural alphanumeric sort.
 *
 * Bin codes like "A-1-2" should come before "A-1-10". A plain string compare
 * gets that backwards. Intl.Collator with numeric:true does the right thing.
 */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareBins(a: string, b: string): number {
  return collator.compare(a, b);
}

export function compareStrings(a: string | null | undefined, b: string | null | undefined): number {
  return collator.compare(a ?? "", b ?? "");
}
