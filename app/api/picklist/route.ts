import { NextRequest, NextResponse } from "next/server";
import { fetchBinsForSkus, type BinRow } from "@/lib/shiphero";
import { compareBins, compareStrings } from "@/lib/sort";

// Allow up to 60s for big orders; Shiphero rate-limits and we run sequentially-ish.
export const maxDuration = 60;
export const runtime = "nodejs";

type IncomingLine = {
  sku: string;
  qty: number;
  orderNumber: string | null;
};

export type PicklistRow = BinRow & {
  needed: number;
};

type OrderResult = {
  orderNumber: string;
  rows: PicklistRow[];
  missing: Array<{ sku: string; needed: number; reason: string }>;
  totals: { uniqueSkus: number; totalQty: number };
};

type ApiResponse = {
  orders: OrderResult[];
  globalTotals: {
    orders: number;
    lines: number;
    uniqueSkus: number;
    totalQty: number;
  };
};

const NO_ORDER_KEY = "(no order #)";

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

  // Group lines by order. Within an order, sum quantities of duplicate SKUs.
  const ordersMap = new Map<string, Map<string, number>>();
  for (const line of lines) {
    if (!line.sku) continue;
    const qty = Number(line.qty) || 0;
    if (qty <= 0) continue;
    const orderKey = (line.orderNumber || "").trim() || NO_ORDER_KEY;
    const sku = line.sku.trim();
    if (!ordersMap.has(orderKey)) ordersMap.set(orderKey, new Map());
    const skuMap = ordersMap.get(orderKey)!;
    skuMap.set(sku, (skuMap.get(sku) || 0) + qty);
  }

  // Collect all unique SKUs across every order — we only call Shiphero once per
  // SKU regardless of how many orders need it.
  const allSkus = new Set<string>();
  for (const skuMap of ordersMap.values()) {
    for (const sku of skuMap.keys()) allSkus.add(sku);
  }

  const fetched = await fetchBinsForSkus([...allSkus], customerAccountId, 4);

  // Build per-order results.
  const orders: OrderResult[] = [];
  for (const [orderNumber, skuMap] of ordersMap.entries()) {
    const rows: PicklistRow[] = [];
    const missing: OrderResult["missing"] = [];

    for (const [sku, needed] of skuMap.entries()) {
      const r = fetched[sku];
      if (!r || r.error) {
        missing.push({
          sku,
          needed,
          reason: r?.error ?? "SKU not found in Shiphero",
        });
        continue;
      }
      if (r.rows.length === 0) {
        missing.push({
          sku,
          needed,
          reason: "No bins with on-hand quantity > 0 found for this client",
        });
        continue;
      }
      for (const bin of r.rows) {
        rows.push({ ...bin, needed });
      }
    }

    // Sort within the order: warehouse, then bin alphanumerically, then SKU.
    rows.sort((a, b) => {
      const w = compareStrings(a.warehouseIdentifier, b.warehouseIdentifier);
      if (w !== 0) return w;
      const bin = compareBins(a.bin, b.bin);
      if (bin !== 0) return bin;
      return compareStrings(a.sku, b.sku);
    });

    orders.push({
      orderNumber,
      rows,
      missing,
      totals: {
        uniqueSkus: skuMap.size,
        totalQty: [...skuMap.values()].reduce((a, b) => a + b, 0),
      },
    });
  }

  // Sort orders by their number (natural sort: Order 2 before Order 10).
  orders.sort((a, b) =>
    a.orderNumber.localeCompare(b.orderNumber, undefined, { numeric: true, sensitivity: "base" })
  );

  return NextResponse.json<ApiResponse>({
    orders,
    globalTotals: {
      orders: orders.length,
      lines: orders.reduce((acc, o) => acc + o.rows.length, 0),
      uniqueSkus: allSkus.size,
      totalQty: orders.reduce((acc, o) => acc + o.totals.totalQty, 0),
    },
  });
}
