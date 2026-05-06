"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

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

type PicklistRow = BinRow & { needed: number };

type OrderResult = {
  orderNumber: string;
  rows: PicklistRow[];
  missing: Array<{ sku: string; needed: number; reason: string }>;
  totals: { uniqueSkus: number; totalQty: number };
};

// Only three columns matter from the CSV.
const SKU_HEADER = "Product Sku (Required)";
const QTY_HEADER = "Quantity";
const ORDER_HEADER = "Order Number (Required)";

const NO_ORDER_KEY = "(no order #)";
const BATCH_SIZE = 40;

// Natural alphanumeric collator for bin sorting.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/clients");
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setClientsError(json.error || `Failed to load clients (${res.status})`);
          return;
        }
        setClients(json.accounts || []);
      } catch (err) {
        if (!cancelled) setClientsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
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
          for (const bin of bins) {
            rows.push({ ...bin, needed });
          }
        }
        rows.sort((a, b) => {
          const w = collator.compare(a.warehouseIdentifier ?? "", b.warehouseIdentifier ?? "");
          if (w !== 0) return w;
          const bin = collator.compare(a.bin, b.bin);
          if (bin !== 0) return bin;
          return collator.compare(a.sku, b.sku);
        });
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

  return (
    <main className="screen">
      <div className="no-print">
        <h1>Shiphero Pick List</h1>
        <p className="subtitle">
          Upload an order CSV, pick the client, and print bin-sorted pick lists — one page per order.
        </p>

        {clientsError && (
          <div className="banner error">
            Couldn&apos;t load clients: {clientsError}. Check that{" "}
            <code>SHIPHERO_REFRESH_TOKEN</code> is set in Vercel.
          </div>
        )}

        <div className="card">
          <h2>1. Pick the client</h2>
          <div className="row">
            <label htmlFor="client">Client</label>
            <select
              id="client"
              value={selectedClient}
              onChange={(e) => setSelectedClient(e.target.value)}
              disabled={!clients}
            >
              <option value="">{clients ? "All clients (no filter)" : "Loading clients…"}</option>
              {clients?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
            </select>
            <span style={{ color: "#777", fontSize: 12 }}>
              {clients ? `${clients.length} clients` : ""}
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
            Only three columns are read: <code>{ORDER_HEADER}</code>, <code>{SKU_HEADER}</code>, and{" "}
            <code>{QTY_HEADER}</code>. Everything else is ignored.
          </p>
        </div>

        <div className="card">
          <h2>3. Generate</h2>
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
}: {
  order: OrderResult;
  isFirst: boolean;
  clientName: string;
  generatedAt: string;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, PicklistRow[]>();
    for (const r of order.rows) {
      const key = r.warehouseIdentifier || r.warehouseId || "Warehouse";
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }
    return [...groups.entries()].sort(([a], [b]) =>
      a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
    );
  }, [order.rows]);

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
          {order.rows.length}
        </div>
      </div>

      {grouped.length === 0 && (
        <div className="banner warn">
          No pickable bins were found for this order. See &quot;Could not locate&quot; below.
        </div>
      )}

      {grouped.map(([warehouse, rows]) => (
        <div key={warehouse} className="warehouse-section">
          <h3>Warehouse: {warehouse}</h3>
          <table className="pick">
            <thead>
              <tr>
                <th style={{ width: 32 }}>✓</th>
                <th style={{ width: "22%" }}>Bin</th>
                <th style={{ width: "28%" }}>SKU</th>
                <th>Product</th>
                <th style={{ width: "10%", textAlign: "right" }}>On hand</th>
                <th style={{ width: "12%", textAlign: "right" }}>Pick qty</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.bin}-${r.sku}-${i}`}>
                  <td className="checkbox">
                    <span className="box" />
                  </td>
                  <td className="bin">{r.bin}</td>
                  <td className="sku">{r.sku}</td>
                  <td>{r.productName || ""}</td>
                  <td className="qty" style={{ color: "#666", fontWeight: 500 }}>
                    {r.onHand}
                  </td>
                  <td className="qty">{r.needed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {order.missing.length > 0 && (
        <div className="missing">
          <h4>Could not locate ({order.missing.length})</h4>
          <table className="pick">
            <thead>
              <tr>
                <th>SKU</th>
                <th style={{ textAlign: "right", width: "12%" }}>Needed</th>
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
