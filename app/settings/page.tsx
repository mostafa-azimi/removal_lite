"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  DEFAULT_TOKEN_SETTINGS,
  buildAuthPayload,
  loadTokenSettings,
  normalizeTokenSettings,
  saveTokenSettings,
  tokenSourceLabel,
  type TokenSettings,
} from "@/lib/auth-settings";

type ConnectionStatus =
  | { status: "verified"; accountId: string | null }
  | { status: "failed"; message: string };

export default function SettingsPage() {
  const [draft, setDraft] = useState<TokenSettings>(DEFAULT_TOKEN_SETTINGS);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  const [clientsCount, setClientsCount] = useState<number | null>(null);
  const [clientsSource, setClientsSource] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function verify(settings: TokenSettings, shouldSave = false) {
    const clean = normalizeTokenSettings(settings);
    if (clean.tokenKind !== "env" && !clean.tokenValue) {
      setMessage("Paste a token before saving this token source.");
      setConnectionStatus(null);
      return;
    }

    setChecking(true);
    setMessage(null);
    setConnectionStatus(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auth: buildAuthPayload(clean) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Connection check failed (${res.status})`);

      if (shouldSave) {
        saveTokenSettings(clean);
        setDraft(clean);
      }
      setClientsCount(Array.isArray(json.accounts) ? json.accounts.length : null);
      setClientsSource(json.source || null);
      setConnectionStatus(json.connection || null);
      setMessage(shouldSave ? "Settings saved." : null);
    } catch (err) {
      setConnectionStatus({ status: "failed", message: err instanceof Error ? err.message : String(err) });
      setMessage(null);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    const saved = loadTokenSettings();
    setDraft(saved);
    verify(saved, false);
  }, []);

  const isOverride = draft.tokenKind !== "env";

  return (
    <main className="screen settings-screen">
      <div className="page-topbar">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">Manage the ShipHero token used for read-only bin lookups.</p>
        </div>
        <Link className="button-link secondary" href="/">
          Back to pick list
        </Link>
      </div>

      <div className="card">
        <h2>ShipHero token</h2>
        <div className="field-grid compact">
          <label>
            <span className="label-with-help">
              Token source
              <HelpTip text="Most users should use the saved server token. Add a browser token only if the saved token fails or you need to test a different ShipHero account." />
            </span>
            <select
              value={draft.tokenKind}
              onChange={(e) =>
                setDraft((prev) =>
                  normalizeTokenSettings({
                    tokenKind: e.target.value as TokenSettings["tokenKind"],
                    tokenValue: prev.tokenValue,
                  })
                )
              }
            >
              <option value="env">Use saved server token</option>
              <option value="refresh">Use browser refresh token</option>
              <option value="access">Use browser access token</option>
            </select>
          </label>

          {isOverride && (
            <label>
              ShipHero token
              <input
                type="password"
                value={draft.tokenValue}
                onChange={(e) =>
                  setDraft((prev) => normalizeTokenSettings({ ...prev, tokenValue: e.target.value }))
                }
                placeholder={
                  draft.tokenKind === "refresh" ? "Paste refresh token" : "Paste access token"
                }
              />
            </label>
          )}
        </div>

        <p style={{ color: "#777", fontSize: 12, margin: "12px 0 0" }}>
          Browser tokens are saved only in this browser. The saved server token remains the default
          for everyone else using the app.
        </p>

        <div className="settings-actions">
          <button className="primary" onClick={() => verify(draft, true)} disabled={checking}>
            {checking ? "Checking..." : "Save and verify"}
          </button>
          {isOverride && (
            <button
              className="secondary"
              onClick={() => {
                const serverSettings = DEFAULT_TOKEN_SETTINGS;
                setDraft(serverSettings);
                verify(serverSettings, true);
              }}
              disabled={checking}
            >
              Use saved server token
            </button>
          )}
        </div>

        {message && (
          <div className="banner info" style={{ marginTop: 12 }}>
            {message}
          </div>
        )}

        {connectionStatus && (
          <div
            className={`banner ${connectionStatus.status === "verified" ? "success" : "warn"}`}
            style={{ marginTop: 12 }}
          >
            {connectionStatus.status === "verified" ? (
              <>
                {tokenSourceLabel(draft)} verified. Client list has{" "}
                {clientsCount ?? "available"} clients
                {clientsSource === "config"
                  ? " from the saved app list"
                  : clientsSource === "shiphero"
                    ? " from ShipHero"
                    : ""}
                .
              </>
            ) : (
              <>ShipHero token check failed: {connectionStatus.message}</>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function HelpTip({ text }: { text: string }) {
  return (
    <span className="help-tip" tabIndex={0} aria-label={text} data-tooltip={text} title={text}>
      ?
    </span>
  );
}
