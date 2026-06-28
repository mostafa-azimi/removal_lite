"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import {
  ORDER_CREATE_REQUIRED_COLUMNS,
  parseOrderCsvRows,
  validateOrderDraft,
  type OrderImportParseResult,
} from "@/lib/order-import";

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
  sourceOrderId?: string | null;
  rows: PicklistRow[];
  missing: Array<{ sku: string; needed: number; reason: string }>;
  totals: { uniqueSkus: number; totalQty: number };
};

type CreateOrdersApiResponse = {
  summary: {
    dryRun: boolean;
    total: number;
    ready: number;
    created: number;
    invalid: number;
    failed: number;
  };
  results: Array<{
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
  }>;
  pickOrders?: OrderResult[];
};

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
  const [orderImport, setOrderImport] = useState<OrderImportParseResult | null>(null);
  const [tokenKind, setTokenKind] = useState<"env" | "refresh" | "access">("env");
  const [tokenValue, setTokenValue] = useState("");
  const [orderDryRun, setOrderDryRun] = useState(true);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<CreateOrdersApiResponse | null>(null);
  const [defaultShopName, setDefaultShopName] = useState("Manual Order");
  const [defaultStatus, setDefaultStatus] = useState("pending");
  const [defaultCurrency, setDefaultCurrency] = useState("USD");
  const [defaultTags, setDefaultTags] = useState("csv-import");
  const [skipAddressValidation, setSkipAddressValidation] = useState(false);
  const [ignoreAddressValidationErrors, setIgnoreAddressValidationErrors] = useState(false);
  const [locationPrefixInput, setLocationPrefixInput] = useState("");
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
    setOrderImport(null);
    setCreateError(null);
    setCreateResult(null);
    setConfirmCreate(false);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        const importResult = parseOrderCsvRows(parsed.data);
        setOrderImport(importResult);
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

  async function submitOrderCreate() {
    if (!orderImport || orderImport.orders.length === 0) return;
    setCreateLoading(true);
    setCreateError(null);
    setCreateResult(null);
    if (!orderDryRun) {
      setOrders(null);
      setGeneratedAt("");
    }

    const auth =
      tokenKind === "env"
        ? null
        : tokenKind === "refresh"
          ? { refreshToken: tokenValue.trim() }
          : { accessToken: tokenValue.trim() };

    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orders: orderImport.orders,
          customerAccountId: selectedClient || null,
          auth,
          dryRun: orderDryRun,
          confirmed: !orderDryRun && confirmCreate,
          defaults: {
            shopName: defaultShopName,
            fulfillmentStatus: defaultStatus,
            currency: defaultCurrency,
            tags: defaultTags,
            skipAddressValidation,
            ignoreAddressValidationErrors,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Order import failed (${res.status})`);
      }
      setCreateResult(json);
      if (!json.summary?.dryRun && Array.isArray(json.pickOrders) && json.pickOrders.length > 0) {
        setOrders(json.pickOrders);
        setGeneratedAt(new Date().toLocaleString());
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateLoading(false);
    }
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

  // Debug helper
  const [debugSku, setDebugSku] = useState("");
  const [debugResult, setDebugResult] = useState<string | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugCopied, setDebugCopied] = useState(false);

  async function runDebug() {
    if (!debugSku.trim()) return;
    setDebugLoading(true);
    setDebugResult(null);
    setDebugCopied(false);
    try {
      const res = await fetch(`/api/debug/sku?sku=${encodeURIComponent(debugSku.trim())}`);
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        setDebugResult(JSON.stringify(json, null, 2));
      } catch {
        setDebugResult(text);
      }
    } catch (err) {
      setDebugResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDebugLoading(false);
    }
  }

  async function copyDebug() {
    if (!debugResult) return;
    try {
      await navigator.clipboard.writeText(debugResult);
      setDebugCopied(true);
      setTimeout(() => setDebugCopied(false), 2000);
    } catch {}
  }

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

  const importStats = useMemo(() => {
    if (!orderImport) return null;
    let valid = 0;
    let invalid = 0;
    let units = 0;
    let lineItems = 0;
    for (const order of orderImport.orders) {
      const errors = validateOrderDraft(order);
      if (errors.length > 0) invalid += 1;
      else valid += 1;
      lineItems += order.lineItems.length;
      units += order.lineItems.reduce((sum, line) => sum + line.quantity, 0);
    }
    return {
      orders: orderImport.orders.length,
      valid,
      invalid,
      lineItems,
      units,
    };
  }, [orderImport]);

  const invalidPreview = useMemo(() => {
    if (!orderImport) return [];
    return orderImport.orders
      .map((order) => ({
        orderNumber: order.orderNumber,
        errors: validateOrderDraft(order),
      }))
      .filter((order) => order.errors.length > 0)
      .slice(0, 5);
  }, [orderImport]);

  const locationPrefixes = useMemo(
    () => parseLocationPrefixes(locationPrefixInput),
    [locationPrefixInput]
  );

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
          <div className="field-grid compact">
            <label className="wide">
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

        <div className="card">
          <h2>4. Create ShipHero orders</h2>

          {importStats ? (
            <div className="banner info">
              {importStats.orders} order{importStats.orders === 1 ? "" : "s"} parsed ·{" "}
              {importStats.valid} ready · {importStats.invalid} need attention ·{" "}
              {importStats.lineItems} line item{importStats.lineItems === 1 ? "" : "s"} ·{" "}
              {importStats.units} units
            </div>
          ) : (
            <div className="banner warn">Upload a CSV before creating orders.</div>
          )}

          {orderImport?.skippedRows.length ? (
            <div className="banner warn">
              {orderImport.skippedRows.length} row
              {orderImport.skippedRows.length === 1 ? "" : "s"} skipped. First issue: row{" "}
              {orderImport.skippedRows[0].row} — {orderImport.skippedRows[0].reason}.
            </div>
          ) : null}

          {invalidPreview.length > 0 && (
            <div className="banner warn">
              {invalidPreview.map((order) => (
                <div key={order.orderNumber}>
                  <strong>{order.orderNumber}</strong>: {order.errors.join("; ")}
                </div>
              ))}
            </div>
          )}

          <details className="csv-columns">
            <summary>CSV columns used for order creation</summary>
            <div className="columns-list">
              {ORDER_CREATE_REQUIRED_COLUMNS.map((column) => (
                <code key={column}>{column}</code>
              ))}
            </div>
          </details>

          <div className="field-grid">
            <label>
              Token
              <select value={tokenKind} onChange={(e) => setTokenKind(e.target.value as typeof tokenKind)}>
                <option value="env">Use server token</option>
                <option value="refresh">Refresh token</option>
                <option value="access">Access token</option>
              </select>
            </label>

            {tokenKind !== "env" && (
              <label className="wide">
                ShipHero token
                <input
                  type="password"
                  value={tokenValue}
                  onChange={(e) => setTokenValue(e.target.value)}
                  placeholder={tokenKind === "refresh" ? "Refresh token" : "Access token"}
                />
              </label>
            )}

            <label>
              Shop name
              <input
                type="text"
                value={defaultShopName}
                onChange={(e) => setDefaultShopName(e.target.value)}
              />
            </label>

            <label>
              Status
              <input
                type="text"
                value={defaultStatus}
                onChange={(e) => setDefaultStatus(e.target.value)}
              />
            </label>

            <label>
              Currency
              <input
                type="text"
                value={defaultCurrency}
                onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())}
              />
            </label>

            <label>
              Tags
              <input
                type="text"
                value={defaultTags}
                onChange={(e) => setDefaultTags(e.target.value)}
              />
            </label>
          </div>

          <div className="check-row">
            <label>
              <input
                type="checkbox"
                checked={orderDryRun}
                onChange={(e) => {
                  setOrderDryRun(e.target.checked);
                  setConfirmCreate(false);
                }}
              />
              Dry run
            </label>
            <label>
              <input
                type="checkbox"
                checked={skipAddressValidation}
                onChange={(e) => setSkipAddressValidation(e.target.checked)}
              />
              Skip address validation
            </label>
            <label>
              <input
                type="checkbox"
                checked={ignoreAddressValidationErrors}
                onChange={(e) => setIgnoreAddressValidationErrors(e.target.checked)}
              />
              Ignore address validation errors
            </label>
          </div>

          {!orderDryRun && (
            <label className="confirm-row">
              <input
                type="checkbox"
                checked={confirmCreate}
                onChange={(e) => setConfirmCreate(e.target.checked)}
              />
              I understand this will create live orders in ShipHero.
            </label>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="primary"
              onClick={submitOrderCreate}
              disabled={
                createLoading ||
                !orderImport ||
                orderImport.orders.length === 0 ||
                (tokenKind !== "env" && !tokenValue.trim()) ||
                (!orderDryRun && !confirmCreate)
              }
            >
              {createLoading
                ? orderDryRun
                  ? "Checking orders…"
                  : "Creating orders…"
                : orderDryRun
                  ? "Dry run"
                  : "Create orders"}
            </button>
          </div>

          {createError && (
            <div className="banner error" style={{ marginTop: 12 }}>
              {createError}
            </div>
          )}

          {createResult && (
            <div className="import-results">
              <div className="banner info">
                {createResult.summary.dryRun ? "Dry run complete" : "Import complete"} ·{" "}
                {createResult.summary.created} created · {createResult.summary.ready} ready ·{" "}
                {createResult.summary.invalid} invalid · {createResult.summary.failed} failed
                {createResult.pickOrders?.length
                  ? ` · ${createResult.pickOrders.length} pick list${createResult.pickOrders.length === 1 ? "" : "s"} ready`
                  : ""}
              </div>
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Status</th>
                    <th>Lines</th>
                    <th>Units</th>
                    <th>Pick list</th>
                    <th>ShipHero ID / Message</th>
                  </tr>
                </thead>
                <tbody>
                  {createResult.results.map((result) => (
                    <tr key={`${result.orderNumber}-${result.status}-${result.orderId ?? ""}`}>
                      <td className="sku">{result.orderNumber}</td>
                      <td>
                        <span className={`status-pill ${result.status}`}>{result.status}</span>
                      </td>
                      <td className="qty">{result.lineItems}</td>
                      <td className="qty">{result.units}</td>
                      <td>
                        {result.pickListStatus ? (
                          <span className={`status-pill ${result.pickListStatus}`}>
                            {result.pickListStatus}
                            {result.pickLines != null ? ` (${result.pickLines})` : ""}
                          </span>
                        ) : (
                          ""
                        )}
                      </td>
                      <td>
                        {result.orderId || result.legacyId
                          ? `${result.orderId ?? ""}${result.legacyId ? ` (${result.legacyId})` : ""}`
                          : result.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card no-print">
        <h2>Debug: inspect a single SKU</h2>
        <p style={{ color: "#777", fontSize: 13, margin: "0 0 12px" }}>
          Paste a SKU you know is in stock in Shiphero. Click Inspect to see exactly
          what Shiphero returns. Then click Copy and share the result.
        </p>
        <div className="row">
          <input
            type="text"
            value={debugSku}
            onChange={(e) => setDebugSku(e.target.value)}
            placeholder="e.g. SP25-ALLSTAR-MENS-SHORTS-STAR-M"
            style={{
              flex: 1,
              minWidth: 280,
              padding: "8px 10px",
              border: "1px solid #ccc",
              borderRadius: 6,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          />
          <button
            className="primary"
            onClick={runDebug}
            disabled={!debugSku.trim() || debugLoading}
          >
            {debugLoading ? "Inspecting…" : "Inspect"}
          </button>
          {debugResult && (
            <button className="secondary" onClick={copyDebug}>
              {debugCopied ? "Copied!" : "Copy"}
            </button>
          )}
        </div>
        {debugResult && (
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              background: "#0e1116",
              color: "#e6edf3",
              borderRadius: 6,
              fontSize: 12,
              maxHeight: 400,
              overflow: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {debugResult}
          </pre>
        )}
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
}: {
  order: OrderResult;
  isFirst: boolean;
  clientName: string;
  generatedAt: string;
  locationPrefixes: string[];
}) {
  const grouped = useMemo(() => {
    const prefixGroups = new Map<string, PicklistRow[]>();
    const prefixes = [...locationPrefixes].sort((a, b) => b.length - a.length);

    if (prefixes.length === 0) {
      prefixGroups.set("", order.rows);
    } else {
      for (const prefix of prefixes) prefixGroups.set(prefix, []);
      prefixGroups.set("Other locations", []);

      for (const row of order.rows) {
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
        const warehouses = new Map<string, PicklistRow[]>();
        for (const row of rows) {
          const key = row.warehouseIdentifier || row.warehouseId || "Warehouse";
          const arr = warehouses.get(key) ?? [];
          arr.push(row);
          warehouses.set(key, arr);
        }
        return {
          prefix,
          warehouses: [...warehouses.entries()].sort(([a], [b]) =>
            a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
          ),
        };
      });
  }, [order.rows, locationPrefixes]);

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
          {group.warehouses.map(([warehouse, rows]) => (
            <div key={`${group.prefix}-${warehouse}`} className="warehouse-section">
              <h4>Warehouse: {warehouse}</h4>
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
