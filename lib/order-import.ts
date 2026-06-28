export type OrderAddressDraft = {
  first_name?: string;
  last_name?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  email?: string;
  phone?: string;
};

export type OrderLineDraft = {
  sku: string;
  quantity: number;
  price: string;
  partnerLineItemId: string;
  productName?: string;
  warehouseId?: string;
  sourceRow: number;
};

export type OrderDraft = {
  orderNumber: string;
  partnerOrderId?: string;
  shopName?: string;
  fulfillmentStatus?: string;
  orderDate?: string;
  currency?: string;
  email?: string;
  giftNote?: string;
  packingNote?: string;
  tags: string[];
  shippingAddress: OrderAddressDraft;
  billingAddress?: OrderAddressDraft;
  shippingLines?: {
    title: string;
    price: string;
    carrier?: string;
    method?: string;
  };
  lineItems: OrderLineDraft[];
  sourceRows: number[];
  warnings: string[];
};

export type OrderImportParseResult = {
  orders: OrderDraft[];
  skippedRows: Array<{ row: number; reason: string }>;
  warnings: string[];
  headers: string[];
};

export const ORDER_CREATE_REQUIRED_COLUMNS = [
  "Order Number (Required)",
  "Product Sku (Required)",
  "Quantity",
  "Shipping Address 1 / Address 1",
  "Shipping City / City",
  "Shipping State / State",
  "Shipping Zip / Zip",
  "Shipping Country / Country",
];

type CsvRow = Record<string, string | undefined>;

const aliases = {
  orderNumber: [
    "Order Number (Required)",
    "Order Number",
    "Order #",
    "Order",
    "order_number",
  ],
  partnerOrderId: ["Partner Order ID", "Partner Order Id", "partner_order_id"],
  shopName: ["Shop Name", "Store", "Store Name", "shop_name"],
  fulfillmentStatus: ["Fulfillment Status", "fulfillment_status", "Status"],
  orderDate: ["Order Date", "order_date", "Date"],
  currency: ["Currency"],
  email: ["Email", "Customer Email", "Order Email"],
  giftNote: ["Gift Note", "gift_note"],
  packingNote: ["Packing Note", "packing_note", "Notes", "Note"],
  tags: ["Tags", "Tag"],
  sku: [
    "Product Sku (Required)",
    "Product SKU (Required)",
    "Product SKU",
    "Product Sku",
    "SKU",
    "Sku",
    "Line Item SKU",
  ],
  quantity: ["Quantity", "Qty", "Line Item Quantity"],
  price: ["Price", "Item Price", "Line Item Price", "Unit Price"],
  productName: ["Product Name", "Product", "Item Name", "Line Item Name"],
  partnerLineItemId: [
    "Partner Line Item ID",
    "Partner Line Item Id",
    "Line Item ID",
    "Line Item Id",
    "partner_line_item_id",
  ],
  warehouseId: ["Warehouse ID", "Warehouse Id", "warehouse_id"],
  shipFirstName: ["Shipping First Name", "Ship First Name", "First Name"],
  shipLastName: ["Shipping Last Name", "Ship Last Name", "Last Name"],
  shipName: ["Shipping Name", "Ship Name", "Name", "Customer Name"],
  shipCompany: ["Shipping Company", "Ship Company", "Company"],
  shipAddress1: [
    "Shipping Address 1",
    "Ship Address 1",
    "Address 1",
    "Address1",
    "Address",
    "Street 1",
  ],
  shipAddress2: [
    "Shipping Address 2",
    "Ship Address 2",
    "Address 2",
    "Address2",
    "Street 2",
  ],
  shipCity: ["Shipping City", "Ship City", "City"],
  shipState: ["Shipping State", "Ship State", "State", "Province"],
  shipZip: ["Shipping Zip", "Ship Zip", "Zip", "Postal Code", "Postcode"],
  shipCountry: ["Shipping Country", "Ship Country", "Country"],
  shipPhone: ["Shipping Phone", "Ship Phone", "Phone"],
  shipEmail: ["Shipping Email", "Ship Email"],
  billFirstName: ["Billing First Name", "Bill First Name"],
  billLastName: ["Billing Last Name", "Bill Last Name"],
  billCompany: ["Billing Company", "Bill Company"],
  billAddress1: ["Billing Address 1", "Bill Address 1"],
  billAddress2: ["Billing Address 2", "Bill Address 2"],
  billCity: ["Billing City", "Bill City"],
  billState: ["Billing State", "Bill State"],
  billZip: ["Billing Zip", "Bill Zip"],
  billCountry: ["Billing Country", "Bill Country"],
  billPhone: ["Billing Phone", "Bill Phone"],
  billEmail: ["Billing Email", "Bill Email"],
  shippingTitle: ["Shipping Title", "Shipping Name", "Shipping Line Title"],
  shippingPrice: ["Shipping Price", "Shipping Cost", "Shipping Amount"],
  shippingCarrier: ["Shipping Carrier", "Carrier"],
  shippingMethod: ["Shipping Method", "Method"],
};

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactObject<T extends Record<string, string | undefined>>(obj: T): T {
  const next = { ...obj };
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (typeof next[key] === "string") {
      const trimmed = next[key]?.trim();
      next[key] = (trimmed || undefined) as T[keyof T];
    }
  }
  return next;
}

function getValue(row: CsvRow, wantedHeaders: string[]): string {
  const wanted = new Set(wantedHeaders.map(normalizeHeader));
  for (const [header, value] of Object.entries(row)) {
    if (!wanted.has(normalizeHeader(header))) continue;
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function parseQuantity(raw: string): number | null {
  const value = Number(String(raw).replace(/,/g, "").trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function parsePrice(raw: string): string {
  const stripped = String(raw || "")
    .replace(/[$,]/g, "")
    .trim();
  if (!stripped) return "0.00";
  if (!/^-?\d+(\.\d+)?$/.test(stripped)) return "0.00";
  return stripped;
}

function splitName(name: string): { first?: string; last?: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { first: parts[0] };
  return {
    first: parts.slice(0, -1).join(" "),
    last: parts[parts.length - 1],
  };
}

function splitTags(value: string): string[] {
  if (!value) return [];
  return value
    .split(/[|,;]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function hasAnyAddressValue(address: OrderAddressDraft): boolean {
  return Object.values(address).some((value) => Boolean(value));
}

function orderWarnings(order: OrderDraft): string[] {
  const warnings: string[] = [];
  if (!order.shippingAddress.address1) warnings.push("Missing shipping address 1");
  if (!order.shippingAddress.city) warnings.push("Missing shipping city");
  if (!order.shippingAddress.state) warnings.push("Missing shipping state");
  if (!order.shippingAddress.zip) warnings.push("Missing shipping zip");
  if (!order.shippingAddress.country) warnings.push("Missing shipping country");
  if (order.lineItems.length === 0) warnings.push("No line items");
  return warnings;
}

export function validateOrderDraft(order: OrderDraft): string[] {
  const errors: string[] = [];
  if (!order.orderNumber) errors.push("Missing order number");
  if (!order.shippingAddress.address1) errors.push("Missing shipping address 1");
  if (!order.shippingAddress.city) errors.push("Missing shipping city");
  if (!order.shippingAddress.state) errors.push("Missing shipping state");
  if (!order.shippingAddress.zip) errors.push("Missing shipping zip");
  if (!order.shippingAddress.country) errors.push("Missing shipping country");
  if (order.lineItems.length === 0) errors.push("No line items");
  for (const line of order.lineItems) {
    if (!line.sku) errors.push(`Row ${line.sourceRow}: missing SKU`);
    if (!line.quantity || line.quantity <= 0) {
      errors.push(`Row ${line.sourceRow}: quantity must be greater than zero`);
    }
    if (!line.partnerLineItemId) {
      errors.push(`Row ${line.sourceRow}: missing partner line item ID`);
    }
    if (!line.price) errors.push(`Row ${line.sourceRow}: missing price`);
  }
  return errors;
}

export function parseOrderCsvRows(rows: CsvRow[]): OrderImportParseResult {
  const ordersMap = new Map<string, OrderDraft>();
  const skippedRows: OrderImportParseResult["skippedRows"] = [];
  const headers = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row).filter(Boolean)))
  );

  rows.forEach((row, index) => {
    const sourceRow = index + 2;
    const orderNumber = getValue(row, aliases.orderNumber);
    const sku = getValue(row, aliases.sku);
    const quantity = parseQuantity(getValue(row, aliases.quantity));

    if (!orderNumber && !sku && !quantity) return;
    if (!orderNumber) {
      skippedRows.push({ row: sourceRow, reason: "Missing order number" });
      return;
    }
    if (!sku) {
      skippedRows.push({ row: sourceRow, reason: "Missing SKU" });
      return;
    }
    if (!quantity) {
      skippedRows.push({ row: sourceRow, reason: "Missing or invalid quantity" });
      return;
    }

    const fullShipName = getValue(row, aliases.shipName);
    const shipName = splitName(fullShipName);
    const shippingAddress = compactObject({
      first_name: getValue(row, aliases.shipFirstName) || shipName.first,
      last_name: getValue(row, aliases.shipLastName) || shipName.last,
      company: getValue(row, aliases.shipCompany),
      address1: getValue(row, aliases.shipAddress1),
      address2: getValue(row, aliases.shipAddress2),
      city: getValue(row, aliases.shipCity),
      state: getValue(row, aliases.shipState),
      zip: getValue(row, aliases.shipZip),
      country: getValue(row, aliases.shipCountry) || "US",
      email: getValue(row, aliases.shipEmail) || getValue(row, aliases.email),
      phone: getValue(row, aliases.shipPhone),
    });

    const billingAddress = compactObject({
      first_name: getValue(row, aliases.billFirstName),
      last_name: getValue(row, aliases.billLastName),
      company: getValue(row, aliases.billCompany),
      address1: getValue(row, aliases.billAddress1),
      address2: getValue(row, aliases.billAddress2),
      city: getValue(row, aliases.billCity),
      state: getValue(row, aliases.billState),
      zip: getValue(row, aliases.billZip),
      country: getValue(row, aliases.billCountry),
      email: getValue(row, aliases.billEmail),
      phone: getValue(row, aliases.billPhone),
    });

    let order = ordersMap.get(orderNumber);
    if (!order) {
      const shippingTitle = getValue(row, aliases.shippingTitle);
      const shippingCarrier = getValue(row, aliases.shippingCarrier);
      const shippingMethod = getValue(row, aliases.shippingMethod);
      const shippingPrice = getValue(row, aliases.shippingPrice);
      const shippingLines =
        shippingTitle || shippingCarrier || shippingMethod || shippingPrice
          ? {
              title: shippingTitle || shippingMethod || shippingCarrier || "Standard Shipping",
              price: parsePrice(shippingPrice),
              carrier: shippingCarrier || undefined,
              method: shippingMethod || undefined,
            }
          : undefined;

      order = {
        orderNumber,
        partnerOrderId: getValue(row, aliases.partnerOrderId) || undefined,
        shopName: getValue(row, aliases.shopName) || undefined,
        fulfillmentStatus: getValue(row, aliases.fulfillmentStatus) || undefined,
        orderDate: getValue(row, aliases.orderDate) || undefined,
        currency: getValue(row, aliases.currency) || undefined,
        email:
          getValue(row, aliases.email) ||
          shippingAddress.email ||
          billingAddress.email ||
          undefined,
        giftNote: getValue(row, aliases.giftNote) || undefined,
        packingNote: getValue(row, aliases.packingNote) || undefined,
        tags: splitTags(getValue(row, aliases.tags)),
        shippingAddress,
        billingAddress: hasAnyAddressValue(billingAddress) ? billingAddress : undefined,
        shippingLines,
        lineItems: [],
        sourceRows: [],
        warnings: [],
      };
      ordersMap.set(orderNumber, order);
    }

    order.sourceRows.push(sourceRow);
    order.lineItems.push({
      sku,
      quantity,
      price: parsePrice(getValue(row, aliases.price)),
      partnerLineItemId:
        getValue(row, aliases.partnerLineItemId) ||
        `${orderNumber}-${order.lineItems.length + 1}`,
      productName: getValue(row, aliases.productName) || undefined,
      warehouseId: getValue(row, aliases.warehouseId) || undefined,
      sourceRow,
    });
  });

  const orders = [...ordersMap.values()].map((order) => ({
    ...order,
    warnings: orderWarnings(order),
  }));

  return {
    orders,
    skippedRows,
    headers,
    warnings: skippedRows.length
      ? [`${skippedRows.length} CSV row${skippedRows.length === 1 ? "" : "s"} skipped`]
      : [],
  };
}
