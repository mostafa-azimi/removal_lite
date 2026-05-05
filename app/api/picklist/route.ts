import { NextRequest, NextResponse } from "next/server";
import { fetchBinsForSkus, type BinRow } from "@/lib/shiphero";
import { compareBins, compareStrings } from "@/lib/sort";

// Allow up to 60s for big orders; Shiphero rate-limits and we run sequentially-ish.
export const maxDuration = 60;
export const runtime = "nodejs";

type IncomingLine = {
  sku: string;
  qty: number;
  warehouse?: string | null;
  orderNumber?: string | null;
};

export type PicklistRow = BinRow & {
  needed: number;
  orderNumbers: string[];
};

type ApiResponse = {
  rows: PicklistRow[];
  missing: Array<{ sku: string; needed: number; reason: string }>;
  totals: { lines: number; uniqueSkus: number; totalQty: number };
};

export async function POST(req: NextRequest) {
  let body: { lines: IncomingLine[]; customerAccountId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (lines.length === 0) {
    return NextResponse.json({ error: "No lines provided" }, { status: 400 });
  }
  const customerAccountId = body.customerAccountId?.trim() || null;

  // Aggregate by SKU so we only call Shiphero once per SKU.
  const aggregated = new Map<
    string,
    { needed: number; orderNumbers: Set<string>; warehouseHint: string | null }
  >();
  for (const line of lines) {
    if (!line.sku) continue;
    const qty = Number(line.qty) || 0;
    if (qty <= 0) continue;
    const key = line.sku.trim();
    const entry = aggregated.get(key) ?? {
      needed: 0,
      orderNumbers: new Set<string>(),
      warehouseHint: null,
    };
    entry.needed += qty;
    if (line.orderNumber) entry.orderNumbers.add(String(line.orderNumber));
    if (!entry.warehouseHint && line.warehouse) entry.warehouseHint = String(line.warehouse);
    aggregated.set(key, entry);
  }

  const skus = [...aggregated.keys()];
  const fetched = await fetchBinsForSkus(skus, customerAccountId, 4);

  const rows: PicklistRow[] = [];
  const missing: ApiResponse["missing"] = [];

  for (const [sku, agg] of aggregated.entries()) {
    const r = fetched[sku];
    if (!r || r.error) {
      missing.push({
        sku,
        needed: agg.needed,
        reason: r?.error ?? "SKU not found in Shiphero",
      });
      continue;
    }
    if (r.rows.length === 0) {
      missing.push({
        sku,
        needed: agg.needed,
        reason: "No bins with on-hand quantity > 0 found for this client",
      });
      continue;
    }
    for (const bin of r.rows) {
      rows.push({
        ...bin,
        needed: agg.needed,
        orderNumbers: [...agg.orderNumbers].sort(),
      });
    }
  }

  // Sort: warehouse identifier (alpha), then bin (natural alphanumeric), then SKU.
  rows.sort((a, b) => {
    const w = compareStrings(a.warehouseIdentifier, b.warehouseIdentifier);
    if (w !== 0) return w;
    const bin = compareBins(a.bin, b.bin);
    if (bin !== 0) return bin;
    return compareStrings(a.sku, b.sku);
  });

  const totals = {
    lines: rows.length,
    uniqueSkus: aggregated.size,
    totalQty: [...aggregated.values()].reduce((acc, x) => acc + x.needed, 0),
  };

  return NextResponse.json<ApiResponse>({ rows, missing, totals });
}
