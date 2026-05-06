import { NextRequest, NextResponse } from "next/server";
import { fetchBinsForSkus } from "@/lib/shiphero";

// Smaller batches finish well under any timeout. Client batches into chunks
// of ~40 SKUs so even on a hobby plan with 10s limits we'd be fine.
export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { skus: string[]; customerAccountId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const skus = Array.isArray(body?.skus) ? body.skus.filter((s) => typeof s === "string" && s.trim()) : [];
  if (skus.length === 0) {
    return NextResponse.json({ bins: {}, errors: {} });
  }
  const customerAccountId = body.customerAccountId?.trim() || null;

  // Concurrency 8: Shiphero's complexity budget tolerates this comfortably.
  const fetched = await fetchBinsForSkus(skus, customerAccountId, 8);

  const bins: Record<string, unknown[]> = {};
  const errors: Record<string, string> = {};
  for (const [sku, r] of Object.entries(fetched)) {
    if (r.error) {
      errors[sku] = r.error;
    } else {
      bins[sku] = r.rows;
    }
  }

  return NextResponse.json({ bins, errors });
}
