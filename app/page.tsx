"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type ClientAccount = { id: string; companyName: string; email: string | null };

type CsvLine = {
  sku: string;
  qty: number;
  warehouse: string | null;
  orderNumber: string | null;
};

type PicklistRow = {
  sku: string;
  productName: string | null;
  warehouseId: string | null;
  warehouseIdentifier: string | null;
  bin: string;
  onHand: number;
  needed: number;
  orderNumbers: string[];
};

type ApiResponse = {
  rows: PicklistRow[];
  missing: Array<{ sku: string; needed: number; reason: string }>;
  totals: { lines: number; uniqueSkus: number; totalQty: number };
};

const SKU_HEADER = "Product Sku (Required)";
const QTY_HEADER = "Quantity";
const WAREHOUSE_HEADER = "Warehouse";
const ORDER_HEADER = "Order Number (Required)";

export default function Home() {
  const [clients, setClients] = useState<ClientAccount[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [csvLines, setCsvLines] = useState<CsvLine[] | null>(null);
  const [csvFileName, setCsvFileName] = useState<string>("");
  const [csvWarning, setCsvWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load clients on mount
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
    setResult(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        const headers = parsed.meta.fields || [];
        const hasSku = headers.includes(SKU_HEADER);
        const hasQty = headers.includes(QTY_HEADER);
        if (!hasSku || !hasQty) {
          setCsvWarning(
            `Couldn't find required columns. Expected '${SKU_HEADER}' and '${QTY_HEADER}'. Make sure you're using the official Shiphero order upload template.`
          );
          setCsvLines(null);
          return;
        }
        const lines: CsvLine[] = [];
        for (const row of parsed.data) {
          const sku = (row[SKU_HEADER] || "").trim();
          const qtyRaw = (row[QTY_HEADER] || "").trim();
          if (!sku || !qtyRaw) continue;
          const qty = Number(qtyRaw);
          if (!Number.isFinite(qty) || qty <= 0) continue;
          lines.push({
            sku,
            qty,
            warehouse: (row[WAREHOUSE_HEADER] || "").trim() || null,
            orderNumber: (row[ORDER_HEADER] || "").trim() || null,
          });
        }
        if (lines.length === 0) {
          setCsvWarning("File parsed, but no usable SKU/Quantity rows were found.");
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
    setResult(null);
    try {
      const res = await fetch("/api/picklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: csvLines,
          customerAccountId: selectedClient || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSubmitError(json.error || `Request failed (${res.status})`);
      } else {
        setResult(json);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // Group rows by warehouse for display
  const grouped = useMemo(() => {
    if (!result) return [];
    const groups = new Map<string, PicklistRow[]>();
    for (const r of result.rows) {
      const key = r.warehouseIdentifier || r.warehouseId || "Warehouse";
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }
    return [...groups.entries()].sort(([a], [b]) =>
      a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
    );
  }, [result]);

  const orderNumbers = useMemo(() => {
    if (!csvLines) return [];
    return [...new Set(csvLines.map((l) => l.orderNumber).filter(Boolean))].sort() as string[];
  }, [csvLines]);

  const selectedClientName = useMemo(() => {
    if (!selectedClient || !clients) return "All clients";
    return clients.find((c) => c.id === selectedClient)?.companyName ?? selectedClient;
  }, [selectedClient, clients]);

  return (
    <main className="screen">
      <div className="no-print">
        <h1>Shiphero Pick List</h1>
        <p className="subtitle">
          Upload an order CSV, pick the client, and print a bin-sorted pick list.
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
              <option value="">
                {clients ? "All clients (no filter)" : "Loading clients…"}
              </option>
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
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
            />
            {csvFileName && (
              <span style={{ color: "#555" }}>
                {csvFileName}
                {csvLines && ` — ${csvLines.length} line${csvLines.length === 1 ? "" : "s"}`}
              </span>
            )}
          </div>
          {csvWarning && <div className="banner warn" style={{ marginTop: 12 }}>{csvWarning}</div>}
        </div>

        <div className="card">
          <h2>3. Generate</h2>
          <div className="row">
            <button
              className="primary"
              onClick={generate}
              disabled={!csvLines || csvLines.length === 0 || loading}
            >
              {loading ? "Looking up bin locations…" : "Generate pick list"}
            </button>
            {result && (
              <button className="secondary" onClick={() => window.print()}>
                Print
              </button>
            )}
          </div>
          {submitError && <div className="banner error" style={{ marginTop: 12 }}>{submitError}</div>}
        </div>
      </div>

      {result && (
        <section className="picklist">
          <div className="meta">
            <div>
              <span className="label">Client</span>
              {selectedClientName}
            </div>
            <div>
              <span className="label">Order #</span>
              {orderNumbers.length ? orderNumbers.join(", ") : "—"}
            </div>
            <div>
              <span className="label">Generated</span>
              {new Date().toLocaleString()}
            </div>
            <div>
              <span className="label">Lines</span>
              {result.rows.length}
            </div>
            <div>
              <span className="label">Unique SKUs</span>
              {result.totals.uniqueSkus}
            </div>
            <div>
              <span className="label">Total units</span>
              {result.totals.totalQty}
            </div>
          </div>

          {grouped.length === 0 && (
            <div className="banner warn">
              No pickable bins were found. Either the SKUs aren&apos;t set up for this client,
              or all bins are empty.
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
                      <td>
                        {r.productName || ""}
                        {r.orderNumbers.length > 1 && (
                          <div className="product-name">
                            Orders: {r.orderNumbers.join(", ")}
                          </div>
                        )}
                      </td>
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

          {result.missing.length > 0 && (
            <div className="missing">
              <h4>Could not locate ({result.missing.length})</h4>
              <table className="pick">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th style={{ textAlign: "right", width: "12%" }}>Needed</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.missing.map((m) => (
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
      )}
    </main>
  );
}
