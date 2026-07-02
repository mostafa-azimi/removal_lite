import type { BinRow } from "./shiphero";

export type PickSortMode =
  | "location"
  | "sku"
  | "product"
  | "pickQtyDesc"
  | "pickQtyAsc"
  | "onHandAsc";

export const PICK_SORT_OPTIONS: Array<{ value: PickSortMode; label: string }> = [
  { value: "location", label: "Location route" },
  { value: "sku", label: "SKU" },
  { value: "product", label: "Product name" },
  { value: "pickQtyDesc", label: "Pick qty high to low" },
  { value: "pickQtyAsc", label: "Pick qty low to high" },
  { value: "onHandAsc", label: "On hand low to high" },
];

export type PicklistRow = BinRow & {
  needed: number;
  pickQty: number;
  rowType: "pick" | "alternate";
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareText(a: string | null | undefined, b: string | null | undefined) {
  return collator.compare(a ?? "", b ?? "");
}

function compareLocation(a: PicklistRow, b: PicklistRow) {
  const warehouse = compareText(a.warehouseIdentifier, b.warehouseIdentifier);
  if (warehouse !== 0) return warehouse;
  const bin = compareText(a.bin, b.bin);
  if (bin !== 0) return bin;
  return compareText(a.sku, b.sku);
}

export function comparePickRows(
  a: PicklistRow,
  b: PicklistRow,
  mode: PickSortMode = "location"
) {
  if (mode === "sku") {
    const sku = compareText(a.sku, b.sku);
    if (sku !== 0) return sku;
    return compareLocation(a, b);
  }

  if (mode === "product") {
    const product = compareText(a.productName, b.productName);
    if (product !== 0) return product;
    const sku = compareText(a.sku, b.sku);
    if (sku !== 0) return sku;
    return compareLocation(a, b);
  }

  if (mode === "pickQtyDesc") {
    const qty = b.pickQty - a.pickQty;
    if (qty !== 0) return qty;
    return compareLocation(a, b);
  }

  if (mode === "pickQtyAsc") {
    const qty = a.pickQty - b.pickQty;
    if (qty !== 0) return qty;
    return compareLocation(a, b);
  }

  if (mode === "onHandAsc") {
    const onHand = a.onHand - b.onHand;
    if (onHand !== 0) return onHand;
    return compareLocation(a, b);
  }

  return compareLocation(a, b);
}

export function sortPickRows(rows: PicklistRow[], mode: PickSortMode = "location") {
  return [...rows].sort((a, b) => comparePickRows(a, b, mode));
}

export function allocatePickRows(bins: BinRow[], needed: number) {
  let remaining = Math.max(0, Math.trunc(needed));
  const rows: PicklistRow[] = [];
  const sortedBins = [...bins].sort((a, b) => {
    const warehouse = compareText(a.warehouseIdentifier, b.warehouseIdentifier);
    if (warehouse !== 0) return warehouse;
    const bin = compareText(a.bin, b.bin);
    if (bin !== 0) return bin;
    return compareText(a.sku, b.sku);
  });

  for (const bin of sortedBins) {
    const onHand = Math.max(0, bin.onHand);
    if (onHand <= 0) continue;

    const pickQty = remaining > 0 ? Math.min(onHand, remaining) : 0;
    rows.push({
      ...bin,
      needed,
      pickQty,
      rowType: pickQty > 0 ? "pick" : "alternate",
    });
    remaining -= pickQty;
  }

  return {
    rows,
    shortage: remaining,
    available: needed - remaining,
  };
}
