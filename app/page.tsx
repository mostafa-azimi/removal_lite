"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import {
  PICK_SORT_OPTIONS,
  allocatePickRows,
  comparePickRows,
  sortPickRows,
  type PickSortMode,
  type PicklistRow,
} from "@/lib/picklist";

type ClientAccount = { id: string; companyName: string; email: string | null };

type CsvLine = {
  sku: string;
  qty: number;
  orderNumber: string | null;
};

type BinRow = {
  sku: string;
  productName: string | null;
  warehouseId: string | null;
  warehouseIdentifier: string | null;
  bin: string;
  onHand: number;
};

type OrderResult = {
  orderNumber: string;
  sourceOrderId?: string | null;
  rows: PicklistRow[];
  missing: Array<{ sku: string; needed: number; reason: string }>;
  totals: { uniqueSkus: number; totalQty: number };
};

type TokenKind = "env" | "refresh" | "access";

// Only three columns matter from the CSV.
const SKU_HEADER = "Product Sku (Required)";
const QTY_HEADER = "Quantity";
const ORDER_HEADER = "Order Number (Required)";

const NO_ORDER_KEY = "(no order #)";
const BATCH_SIZE = 40;

// Natural alphanumeric collator for bin sorting.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function parseLocationPrefixes(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[,\n]/)
    .map((prefix) => prefix.trim())
    .filter(Boolean)
    .filter((prefix) => {
      const key = prefix.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildAuthPayload(tokenKind: TokenKind, tokenValue: string) {
  const token = tokenValue.trim();
  if (tokenKind === "env") return null;
  if (!token) return null;
  return tokenKind === "refresh" ? { refreshToken: token } : { accessToken: token };
}

export default function Home() {
  const [clients, setClients] = useState<ClientAccount[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [csvLines, setCsvLines] = useState<CsvLine[] | null>(null);
  const [csvFileName, setCsvFileName] = useState<string>("");
  const [csvWarning, setCsvWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderResult[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string>("");
  const [tokenKind, setTokenKind] = useState<TokenKind>("env");
  const [tokenValue, setTokenValue] = useState("");
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsSource, setClientsSource] = useState<string | null>(null);
  const [locationPrefixInput, setLocationPrefixInput] = useState("");
  const [pickSortMode, setPickSortMode] = useState<PickSortMode>("location");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadClients(kind: TokenKind = tokenKind, value: string = tokenValue) {
    setClientsLoading(true);
    setClientsError(null);
    try {
      const auth = buildAuthPayload(kind, value);
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auth }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Failed to load clients (${res.status})`);
      }
      setClients(json.accounts || []);
      setClientsSource(json.source || null);
    } catch (err) {
      setClients([]);
      setClientsError(err instanceof Error ? err.message : String(err));
    } finally {
      setClientsLoading(false);
    }
  }

  useEffect(() => {
    loadClients("env", "");
  }, []);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvFileName(file.name);
    setCsvWarning(null);
    setSubmitError(null);
    setOrders(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        const headers = parsed.meta.fields || [];
        const hasSku = headers.includes(SKU_HEADER);
        const hasQty = headers.includes(QTY_HEADER);
        const hasOrder = headers.includes(ORDER_HEADER);
        if (!hasSku || !hasQty || !hasOrder) {
          setCsvWarning(
            `Couldn't find required columns. Expected '${ORDER_HEADER}', '${SKU_HEADER}', and '${QTY_HEADER}'.`
          );
          setCsvLines(null);
          return;
        }
        const lines: CsvLine[] = [];
        let missingOrder = 0;
        for (const row of parsed.data) {
          const sku = (row[SKU_HEADER] || "").trim();
          const qtyRaw = (row[QTY_HEADER] || "").trim();
          if (!sku || !qtyRaw) continue;
          const qty = Number(qtyRaw);
          if (!Number.isFinite(qty) || qty <= 0) continue;
          const orderNumber = (row[ORDER_HEADER] || "").trim() || null;
          if (!orderNumber) missingOrder += 1;
          lines.push({ sku, qty, orderNumber });
        }
        if (lines.length === 0) {
          setCsvWarning("File parsed, but no usable SKU/Quantity rows were found.");
        } else if (missingOrder > 0) {
          setCsvWarning(
            `${missingOrder} of ${lines.length} rows are missing an order number — they'll be grouped under "(no order #)".`
          );
        }
        setCsvLines(lines);
      },
      error: (err) => {
        setCsvWarning(`Parse error: ${err.message}`);
        setCsvLines(null);
      },
    });
  }

  async function generate() {
    if (!csvLines || csvLines.length === 0) return;
    const auth = buildAuthPayload(tokenKind, tokenValue);
    if (tokenKind !== "env" && !auth) {
      setSubmitError("Enter a ShipHero token before generating the pick list.");
      return;
    }
    setLoading(true);
    setSubmitError(null);
    setOrders(null);

    try {
      // Group lines by order, summing duplicate SKUs within an order.
      const ordersMap = new Map<string, Map<string, number>>();
      for (const line of csvLines) {
        const orderKey = (line.orderNumber || "").trim() || NO_ORDER_KEY;
        if (!ordersMap.has(orderKey)) ordersMap.set(orderKey, new Map());
        const skuMap = ordersMap.get(orderKey)!;
        skuMap.set(line.sku, (skuMap.get(line.sku) || 0) + line.qty);
      }

      // Collect all unique SKUs across every order (one Shiphero call per SKU).
      const allSkus = new Set<string>();
      for (const skuMap of ordersMap.values()) {
        for (const sku of skuMap.keys()) allSkus.add(sku);
      }
      const skuList = [...allSkus];
      setProgress({ done: 0, total: skuList.length });

      // Batch through Shiphero in chunks. Each batch is its own server call
      // so no individual request hits the timeout.
      const allBins: Record<string, BinRow[]> = {};
      const allErrors: Record<string, string> = {};
      for (let i = 0; i < skuList.length; i += BATCH_SIZE) {
        const batch = skuList.slice(i, i + BATCH_SIZE);
        const res = await fetch("/api/bins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skus: batch,
            customerAccountId: selectedClient || null,
            auth,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          let msg = text;
          try {
            msg = JSON.parse(text).error || text;
          } catch {}
          throw new Error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${msg}`);
        }
        const json = (await res.json()) as {
          bins: Record<string, BinRow[]>;
          errors: Record<string, string>;
        };
        Object.assign(allBins, json.bins);
        Object.assign(allErrors, json.errors);
        setProgress({ done: Math.min(i + BATCH_SIZE, skuList.length), total: skuList.length });
      }

      // Build per-order results from the aggregated bins map.
      const builtOrders: OrderResult[] = [];
      for (const [orderNumber, skuMap] of ordersMap.entries()) {
        const rows: PicklistRow[] = [];
        const missing: OrderResult["missing"] = [];
        for (const [sku, needed] of skuMap.entries()) {
          if (allErrors[sku]) {
            missing.push({ sku, needed, reason: allErrors[sku] });
            continue;
          }
          const bins = allBins[sku];
          if (!bins || bins.length === 0) {
            missing.push({
              sku,
              needed,
              reason: "No bins with on-hand quantity > 0 found for this client",
            });
            continue;
          }
          const allocated = allocatePickRows(bins, needed);
          rows.push(...allocated.rows);
          if (allocated.shortage > 0) {
            missing.push({
              sku,
              needed: allocated.shortage,
              reason: `Only ${allocated.available} pickable units found across bins; ${allocated.shortage} still needed`,
            });
          }
        }
        rows.sort((a, b) => comparePickRows(a, b, pickSortMode));
        builtOrders.push({
          orderNumber,
          rows,
          missing,
          totals: {
            uniqueSkus: skuMap.size,
            totalQty: [...skuMap.values()].reduce((a, b) => a + b, 0),
          },
        });
      }
      builtOrders.sort((a, b) =>
        collator.compare(a.orderNumber, b.orderNumber)
      );
      setOrders(builtOrders);
      setGeneratedAt(new Date().toLocaleString());
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  const selectedClientName = useMemo(() => {
    if (!selectedClient || !clients) return "All clients";
    return clients.find((c) => c.id === selectedClient)?.companyName ?? selectedClient;
  }, [selectedClient, clients]);

  const globalTotals = useMemo(() => {
    if (!orders) return null;
    const uniqueSkus = new Set<string>();
    let totalQty = 0;
    for (const o of orders) {
      for (const r of o.rows) uniqueSkus.add(r.sku);
      for (const m of o.missing) uniqueSkus.add(m.sku);
      totalQty += o.totals.totalQty;
    }
    return { orders: orders.length, uniqueSkus: uniqueSkus.size, totalQty };
  }, [orders]);

  const locationPrefixes = useMemo(
    () => parseLocationPrefixes(locationPrefixInput),
    [locationPrefixInput]
  );

  return (
    <main className="screen">
      <div className="no-print">
        <h1>Shiphero Pick List</h1>
        <p className="subtitle">
          Add a ShipHero token, upload one ShipHero order CSV, and print a pick list from the
          SKU and quantity rows.
        </p>

        {clientsError && (
          <div className="banner error">
            Couldn&apos;t connect to ShipHero: {clientsError}
          </div>
        )}

        <div className="card">
          <h2>1. Connect to ShipHero</h2>
          <div className="field-grid compact">
            <label>
              Token source
              <select
                value={tokenKind}
                onChange={(e) => {
                  const nextKind = e.target.value as TokenKind;
                  setTokenKind(nextKind);
                  setSelectedClient("");
                  setOrders(null);
                }}
              >
                <option value="env">Use server token</option>
                <option value="refresh">Refresh token</option>
                <option value="access">Access token</option>
              </select>
            </label>

            {tokenKind !== "env" && (
              <label>
                ShipHero token
                <input
                  type="password"
                  value={tokenValue}
                  onChange={(e) => {
                    setTokenValue(e.target.value);
                    setOrders(null);
                  }}
                  placeholder={tokenKind === "refresh" ? "Paste refresh token" : "Paste access token"}
                />
              </label>
            )}
          </div>
          <p style={{ color: "#777", fontSize: 12, margin: "8px 0 12px" }}>
            The token is only used for ShipHero lookups: client list, SKU, bin, location, and
            on-hand quantity. This app does not create ShipHero orders.
          </p>
          <div className="row">
            <button
              className="secondary"
              onClick={() => loadClients()}
              disabled={clientsLoading || (tokenKind !== "env" && !tokenValue.trim())}
            >
              {clientsLoading ? "Connecting..." : "Load clients"}
            </button>
            <label htmlFor="client">Client</label>
            <select
              id="client"
              value={selectedClient}
              onChange={(e) => {
                setSelectedClient(e.target.value);
                setOrders(null);
              }}
              disabled={clientsLoading || !clients}
            >
              <option value="">{clients ? "All clients (no filter)" : "Load clients first"}</option>
              {clients?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
            </select>
            <span style={{ color: "#777", fontSize: 12 }}>
              {clients ? `${clients.length} clients${clientsSource ? ` (${clientsSource})` : ""}` : ""}
            </span>
          </div>
        </div>

        <div className="card">
          <h2>2. Upload the Shiphero order CSV</h2>
          <div className="row">
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFile} />
            {csvFileName && (
              <span style={{ color: "#555" }}>
                {csvFileName}
                {csvLines && ` — ${csvLines.length} line${csvLines.length === 1 ? "" : "s"}`}
              </span>
            )}
          </div>
          {csvWarning && (
            <div className="banner warn" style={{ marginTop: 12 }}>
              {csvWarning}
            </div>
          )}
          <p style={{ color: "#777", fontSize: 12, margin: "8px 0 0" }}>
            Picking is driven by <code>{ORDER_HEADER}</code>, <code>{SKU_HEADER}</code>, and{" "}
            <code>{QTY_HEADER}</code>. Address fields in the CSV are ignored.
          </p>
        </div>

        <div className="card">
          <h2>3. Pick list</h2>
          <div className="field-grid compact">
            <label>
              Sort pick list
              <select
                value={pickSortMode}
                onChange={(e) => setPickSortMode(e.target.value as PickSortMode)}
              >
                {PICK_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Location prefixes
              <input
                type="text"
                value={locationPrefixInput}
                onChange={(e) => setLocationPrefixInput(e.target.value)}
                placeholder="A, B, A-1"
              />
            </label>
          </div>
          <p style={{ color: "#777", fontSize: 12, margin: "8px 0 12px" }}>
            Optional. Prefixes split the printed list by bin start, so <code>A</code> matches aisle A and{" "}
            <code>A-1</code> matches the longer prefix.
          </p>
          <div className="row">
            <button
              className="primary"
              onClick={generate}
              disabled={!csvLines || csvLines.length === 0 || loading}
            >
              {loading
                ? progress
                  ? `Looking up bins… ${progress.done} of ${progress.total} SKUs`
                  : "Looking up bin locations…"
                : "Generate pick lists"}
            </button>
            {orders && (
              <button className="secondary" onClick={() => window.print()}>
                Print
              </button>
            )}
          </div>
          {progress && progress.total > 0 && (
            <div className="progress-track" style={{ marginTop: 12 }}>
              <div
                className="progress-fill"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
          )}
          {submitError && (
            <div className="banner error" style={{ marginTop: 12 }}>
              {submitError}
            </div>
          )}
          {orders && globalTotals && (
            <div className="banner info" style={{ marginTop: 12 }}>
              {globalTotals.orders} order{globalTotals.orders === 1 ? "" : "s"} · {globalTotals.uniqueSkus}{" "}
              unique SKUs · {globalTotals.totalQty} units
            </div>
          )}
        </div>

      </div>

      {orders &&
        orders.map((order, idx) => (
          <OrderSection
            key={order.orderNumber}
            order={order}
            isFirst={idx === 0}
            clientName={selectedClientName}
            generatedAt={generatedAt}
            locationPrefixes={locationPrefixes}
            pickSortMode={pickSortMode}
          />
        ))}
    </main>
  );
}

function OrderSection({
  order,
  isFirst,
  clientName,
  generatedAt,
  locationPrefixes,
  pickSortMode,
}: {
  order: OrderResult;
  isFirst: boolean;
  clientName: string;
  generatedAt: string;
  locationPrefixes: string[];
  pickSortMode: PickSortMode;
}) {
  const sortedRows = useMemo(
    () => sortPickRows(order.rows, pickSortMode),
    [order.rows, pickSortMode]
  );
  const sortLabel =
    PICK_SORT_OPTIONS.find((option) => option.value === pickSortMode)?.label ?? "Location route";
  const groupByWarehouse = pickSortMode === "location";

  const grouped = useMemo(() => {
    const prefixGroups = new Map<string, PicklistRow[]>();
    const prefixes = [...locationPrefixes].sort((a, b) => b.length - a.length);

    if (prefixes.length === 0) {
      prefixGroups.set("", sortedRows);
    } else {
      for (const prefix of prefixes) prefixGroups.set(prefix, []);
      prefixGroups.set("Other locations", []);

      for (const row of sortedRows) {
        const matched = prefixes.find((prefix) =>
          row.bin.toLowerCase().startsWith(prefix.toLowerCase())
        );
        const key = matched ?? "Other locations";
        prefixGroups.get(key)!.push(row);
      }
    }

    return [...prefixGroups.entries()]
      .filter(([, rows]) => rows.length > 0)
      .map(([prefix, rows]) => {
        if (!groupByWarehouse) {
          return {
            prefix,
            rows,
            warehouses: [],
          };
        }

        const warehouses = new Map<string, PicklistRow[]>();
        for (const row of rows) {
          const key = row.warehouseIdentifier || row.warehouseId || "Warehouse";
          const arr = warehouses.get(key) ?? [];
          arr.push(row);
          warehouses.set(key, arr);
        }
        return {
          prefix,
          rows: [],
          warehouses: [...warehouses.entries()].sort(([a], [b]) =>
            a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
          ),
        };
      });
  }, [sortedRows, locationPrefixes, groupByWarehouse]);
  const pickLineCount = order.rows.filter((row) => row.pickQty > 0).length;
  const alternateBinCount = order.rows.filter((row) => row.pickQty <= 0).length;

  return (
    <section className={`picklist order-page${isFirst ? "" : " page-break"}`}>
      <div className="order-header">
        <h2>Order #{order.orderNumber}</h2>
      </div>
      <div className="meta">
        <div>
          <span className="label">Client</span>
          {clientName}
        </div>
        <div>
          <span className="label">Generated</span>
          {generatedAt}
        </div>
        <div>
          <span className="label">Unique SKUs</span>
          {order.totals.uniqueSkus}
        </div>
        <div>
          <span className="label">Total units</span>
          {order.totals.totalQty}
        </div>
        <div>
          <span className="label">Pick lines</span>
          {pickLineCount}
        </div>
        <div>
          <span className="label">Alternate bins</span>
          {alternateBinCount}
        </div>
        <div>
          <span className="label">Sorted by</span>
          {sortLabel}
        </div>
        {locationPrefixes.length > 0 && (
          <div>
            <span className="label">Location prefixes</span>
            {locationPrefixes.join(", ")}
          </div>
        )}
      </div>

      {grouped.length === 0 && (
        <div className="banner warn">
          No pickable bins were found for this order. See &quot;Could not locate&quot; below.
        </div>
      )}

      {grouped.map((group) => (
        <div key={group.prefix || "all"} className="prefix-section">
          {group.prefix && <h3>Location prefix: {group.prefix}</h3>}
          {group.rows.length > 0 ? (
            <PickRowsTable rows={group.rows} showWarehouse />
          ) : (
            group.warehouses.map(([warehouse, rows]) => (
              <div key={`${group.prefix}-${warehouse}`} className="warehouse-section">
                <h4>Warehouse: {warehouse}</h4>
                <PickRowsTable rows={rows} showWarehouse={false} />
              </div>
            ))
          )}
        </div>
      ))}

      {order.missing.length > 0 && (
        <div className="missing">
          <h4>Could not locate ({order.missing.length})</h4>
          <table className="pick">
            <thead>
              <tr>
                <th>SKU</th>
                <th style={{ textAlign: "right", width: "12%" }}>Missing</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {order.missing.map((m) => (
                <tr key={m.sku}>
                  <td className="sku">{m.sku}</td>
                  <td className="qty">{m.needed}</td>
                  <td>{m.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PickRowsTable({
  rows,
  showWarehouse,
}: {
  rows: PicklistRow[];
  showWarehouse: boolean;
}) {
  return (
    <table className="pick">
      <thead>
        <tr>
          <th style={{ width: 32 }}>✓</th>
          <th style={{ width: "9%" }}>Use</th>
          {showWarehouse && <th style={{ width: "11%" }}>Warehouse</th>}
          <th style={{ width: showWarehouse ? "15%" : "18%" }}>Bin</th>
          <th style={{ width: showWarehouse ? "21%" : "23%" }}>SKU</th>
          <th>Product</th>
          <th style={{ width: "9%", textAlign: "right" }}>On hand</th>
          <th style={{ width: "9%", textAlign: "right" }}>Needed</th>
          <th style={{ width: "9%", textAlign: "right" }}>Pick</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const isAlternate = r.rowType === "alternate" || r.pickQty <= 0;
          return (
            <tr className={isAlternate ? "alternate-row" : ""} key={`${r.bin}-${r.sku}-${i}`}>
              <td className="checkbox">
                {isAlternate ? <span className="alt-dash">-</span> : <span className="box" />}
              </td>
              <td>
                <span className={`row-type ${isAlternate ? "alternate" : "pick"}`}>
                  {isAlternate ? "Alternate" : "Pick"}
                </span>
              </td>
              {showWarehouse && (
                <td className="warehouse">{r.warehouseIdentifier || r.warehouseId || ""}</td>
              )}
              <td className="bin">{r.bin}</td>
              <td className="sku">{r.sku}</td>
              <td className="product">{r.productName || ""}</td>
              <td className="qty muted">{r.onHand}</td>
              <td className="qty muted">{r.needed}</td>
              <td className="qty pick-qty">{r.pickQty}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
