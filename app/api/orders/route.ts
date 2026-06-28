import { NextRequest, NextResponse } from "next/server";
import {
  createShipHeroOrder,
  fetchBinsForSkus,
  fetchOrderForPickList,
  type BinRow,
  type CreateOrderAddressInput,
  type CreateOrderInput,
  type ShipHeroAuthOverride,
  type ShipHeroOrderForPickList,
} from "@/lib/shiphero";
import { validateOrderDraft, type OrderDraft } from "@/lib/order-import";

export const maxDuration = 60;
export const runtime = "nodejs";

type ImportDefaults = {
  shopName?: string | null;
  fulfillmentStatus?: string | null;
  currency?: string | null;
  tags?: string | null;
  skipAddressValidation?: boolean;
  ignoreAddressValidationErrors?: boolean;
  allowPartial?: boolean;
  allowSplit?: boolean;
};

type OrderImportResult = {
  orderNumber: string;
  status: "ready" | "created" | "invalid" | "failed";
  lineItems: number;
  units: number;
  orderId?: string | null;
  legacyId?: number | string | null;
  requestId?: string | null;
  complexity?: number | null;
  pickListStatus?: "ready" | "failed";
  pickLines?: number;
  message?: string;
};

type PicklistRow = BinRow & { needed: number };

type PicklistOrder = {
  orderNumber: string;
  sourceOrderId?: string | null;
  rows: PicklistRow[];
  missing: Array<{ sku: string; needed: number; reason: string }>;
  totals: { uniqueSkus: number; totalQty: number };
};

type Body = {
  orders?: OrderDraft[];
  customerAccountId?: string | null;
  auth?: ShipHeroAuthOverride | null;
  defaults?: ImportDefaults | null;
  dryRun?: boolean;
  confirmed?: boolean;
};

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanTags(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[|,;]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function compactAddress(address: CreateOrderAddressInput): CreateOrderAddressInput {
  return Object.fromEntries(
    Object.entries(address).filter(([, value]) => Boolean(value))
  ) as CreateOrderAddressInput;
}

function units(order: OrderDraft): number {
  return order.lineItems.reduce((sum, line) => sum + line.quantity, 0);
}

function buildCreateOrderInput(
  order: OrderDraft,
  customerAccountId: string | null,
  defaults: ImportDefaults
): CreateOrderInput {
  const tags = unique([...order.tags, ...cleanTags(defaults.tags)]);
  const input: CreateOrderInput = {
    order_number: order.orderNumber,
    customer_account_id: customerAccountId || undefined,
    partner_order_id: order.partnerOrderId || undefined,
    shop_name: order.shopName || cleanString(defaults.shopName) || "Manual Order",
    fulfillment_status:
      order.fulfillmentStatus || cleanString(defaults.fulfillmentStatus) || "pending",
    order_date: order.orderDate || new Date().toISOString(),
    currency: order.currency || cleanString(defaults.currency) || "USD",
    email: order.email || order.shippingAddress.email || order.billingAddress?.email,
    tags: tags.length > 0 ? tags : undefined,
    gift_note: order.giftNote || undefined,
    packing_note: order.packingNote || undefined,
    shipping_address: compactAddress(order.shippingAddress),
    billing_address: order.billingAddress
      ? compactAddress(order.billingAddress)
      : undefined,
    shipping_lines: order.shippingLines,
    line_items: order.lineItems.map((line) => ({
      sku: line.sku,
      partner_line_item_id: line.partnerLineItemId,
      quantity: line.quantity,
      price: line.price || "0.00",
      product_name: line.productName || undefined,
      warehouse_id: line.warehouseId || undefined,
    })),
    skip_address_validation: Boolean(defaults.skipAddressValidation),
    ignore_address_validation_errors: Boolean(defaults.ignoreAddressValidationErrors),
    allow_partial: defaults.allowPartial,
    allow_split: defaults.allowSplit,
  };

  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as CreateOrderInput;
}

function authFromBody(auth: ShipHeroAuthOverride | null | undefined) {
  const accessToken = cleanString(auth?.accessToken);
  const refreshToken = cleanString(auth?.refreshToken);
  if (!accessToken && !refreshToken) return undefined;
  return { accessToken, refreshToken };
}

function sortPickRows(rows: PicklistRow[]) {
  rows.sort((a, b) => {
    const w = (a.warehouseIdentifier ?? "").localeCompare(
      b.warehouseIdentifier ?? "",
      undefined,
      { sensitivity: "base", numeric: true }
    );
    if (w !== 0) return w;
    const bin = a.bin.localeCompare(b.bin, undefined, {
      sensitivity: "base",
      numeric: true,
    });
    if (bin !== 0) return bin;
    return a.sku.localeCompare(b.sku, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });
}

async function buildPicklistFromShipHeroOrder(
  order: ShipHeroOrderForPickList,
  customerAccountId: string | null,
  auth?: ShipHeroAuthOverride
): Promise<PicklistOrder> {
  const skuMap = new Map<string, { needed: number; productName: string | null }>();
  for (const line of order.lineItems) {
    const existing = skuMap.get(line.sku);
    skuMap.set(line.sku, {
      needed: (existing?.needed ?? 0) + line.quantity,
      productName: existing?.productName ?? line.productName,
    });
  }

  const fetched = await fetchBinsForSkus([...skuMap.keys()], customerAccountId, 3, auth);
  const rows: PicklistRow[] = [];
  const missing: PicklistOrder["missing"] = [];

  for (const [sku, info] of skuMap.entries()) {
    const bins = fetched[sku];
    if (!bins || bins.error) {
      missing.push({
        sku,
        needed: info.needed,
        reason: bins?.error ?? "SKU not found in Shiphero",
      });
      continue;
    }
    if (bins.rows.length === 0) {
      missing.push({
        sku,
        needed: info.needed,
        reason: "No bins with on-hand quantity > 0 found for this client",
      });
      continue;
    }
    for (const bin of bins.rows) {
      rows.push({
        ...bin,
        productName: bin.productName || info.productName,
        needed: info.needed,
      });
    }
  }

  sortPickRows(rows);

  return {
    orderNumber: order.orderNumber,
    sourceOrderId: order.id,
    rows,
    missing,
    totals: {
      uniqueSkus: skuMap.size,
      totalQty: [...skuMap.values()].reduce((sum, item) => sum + item.needed, 0),
    },
  };
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orders = Array.isArray(body.orders) ? body.orders : [];
  if (orders.length === 0) {
    return NextResponse.json({ error: "No orders provided" }, { status: 400 });
  }

  const defaults = body.defaults ?? {};
  const customerAccountId = cleanString(body.customerAccountId) ?? null;
  const dryRun = body.dryRun !== false;
  const auth = authFromBody(body.auth);

  if (!dryRun && !body.confirmed) {
    return NextResponse.json(
      { error: "Live order creation requires confirmation" },
      { status: 400 }
    );
  }

  const results: OrderImportResult[] = [];
  const pickOrders: PicklistOrder[] = [];

  for (const order of orders) {
    const validationErrors = validateOrderDraft(order);
    if (validationErrors.length > 0) {
      results.push({
        orderNumber: order.orderNumber || "(missing order number)",
        status: "invalid",
        lineItems: order.lineItems?.length ?? 0,
        units: order.lineItems ? units(order) : 0,
        message: validationErrors.join("; "),
      });
      continue;
    }

    if (dryRun) {
      results.push({
        orderNumber: order.orderNumber,
        status: "ready",
        lineItems: order.lineItems.length,
        units: units(order),
        message: "Ready to create",
      });
      continue;
    }

    try {
      const input = buildCreateOrderInput(order, customerAccountId, defaults);
      const created = await createShipHeroOrder(input, auth);
      let pickListStatus: OrderImportResult["pickListStatus"] = undefined;
      let pickLines: number | undefined = undefined;
      let message = "Created in ShipHero";
      const orderId = created.order?.id;

      if (orderId) {
        try {
          const createdOrder = await fetchOrderForPickList(orderId, auth);
          const pickOrder = await buildPicklistFromShipHeroOrder(
            createdOrder,
            customerAccountId,
            auth
          );
          pickOrders.push(pickOrder);
          pickListStatus = "ready";
          pickLines = pickOrder.rows.length;
          message = "Created in ShipHero; pick list ready from created order";
        } catch (pickErr) {
          pickListStatus = "failed";
          message = `Created in ShipHero; pick list failed: ${
            pickErr instanceof Error ? pickErr.message : String(pickErr)
          }`;
        }
      }

      results.push({
        orderNumber: order.orderNumber,
        status: "created",
        lineItems: order.lineItems.length,
        units: units(order),
        orderId,
        legacyId: created.order?.legacy_id,
        requestId: created.request_id,
        complexity: created.complexity,
        pickListStatus,
        pickLines,
        message,
      });
    } catch (err) {
      results.push({
        orderNumber: order.orderNumber,
        status: "failed",
        lineItems: order.lineItems.length,
        units: units(order),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary = {
    dryRun,
    total: results.length,
    ready: results.filter((result) => result.status === "ready").length,
    created: results.filter((result) => result.status === "created").length,
    invalid: results.filter((result) => result.status === "invalid").length,
    failed: results.filter((result) => result.status === "failed").length,
  };

  return NextResponse.json({ summary, results, pickOrders });
}
