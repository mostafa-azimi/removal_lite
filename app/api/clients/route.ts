import { NextRequest, NextResponse } from "next/server";
import {
  fetchCustomerAccounts,
  verifyShipHeroConnection,
  type ShipHeroAuthOverride,
} from "@/lib/shiphero";
import clientsConfig from "@/data/clients.json";

export const runtime = "nodejs";
export const maxDuration = 30;
// Cache the client list for 5 min — it almost never changes.
export const revalidate = 300;

type ConfigClient = { id: string; name: string };
type ConnectionStatus =
  | { status: "verified"; accountId: string | null }
  | { status: "failed"; message: string };

function configuredAccounts() {
  // Primary path: read the hardcoded list from data/clients.json.
  // This is the fast, reliable way for 3PLs — edit the file with your real
  // customer_account_ids + names and push. The dropdown reflects exactly
  // what you put there.
  const config = (clientsConfig as ConfigClient[]).filter(
    (c) =>
      c &&
      typeof c.id === "string" &&
      c.id &&
      !c.id.startsWith("REPLACE_WITH_") &&
      typeof c.name === "string"
  );
  if (config.length > 0) {
    return config
      .map((c) => ({ id: c.id, companyName: c.name, email: null }))
      .sort((a, b) =>
        a.companyName.localeCompare(b.companyName, undefined, { sensitivity: "base" })
      );
  }
  return null;
}

function cleanAuth(auth: ShipHeroAuthOverride | null | undefined) {
  const accessToken = typeof auth?.accessToken === "string" ? auth.accessToken.trim() : "";
  const refreshToken = typeof auth?.refreshToken === "string" ? auth.refreshToken.trim() : "";
  if (!accessToken && !refreshToken) return undefined;
  return { accessToken: accessToken || undefined, refreshToken: refreshToken || undefined };
}

function cleanConnectionError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Missing SHIPHERO_REFRESH_TOKEN")) {
    return "No saved ShipHero token is configured for this app.";
  }
  if (message.toLowerCase().includes("token refresh failed")) {
    return "The saved ShipHero token could not be refreshed.";
  }
  if (message.includes("401")) {
    return "ShipHero rejected the token.";
  }
  return "ShipHero connection check failed.";
}

async function checkConnection(auth?: ShipHeroAuthOverride): Promise<ConnectionStatus> {
  try {
    const verified = await verifyShipHeroConnection(auth);
    return { status: "verified", accountId: verified.accountId };
  } catch (err) {
    return { status: "failed", message: cleanConnectionError(err) };
  }
}

export async function GET() {
  const config = configuredAccounts();
  if (config) {
    const connection = await checkConnection();
    return NextResponse.json({ accounts: config, source: "config", connection });
  }

  // Fallback: try Shiphero auto-discovery (best-effort).
  try {
    const accounts = await fetchCustomerAccounts();
    const connection: ConnectionStatus = { status: "verified", accountId: null };
    return NextResponse.json({ accounts, source: "shiphero", connection });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { auth?: ShipHeroAuthOverride | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const auth = cleanAuth(body.auth);
  const config = configuredAccounts();
  if (config) {
    const connection = await checkConnection(auth);
    return NextResponse.json({ accounts: config, source: "config", connection });
  }

  try {
    const accounts = await fetchCustomerAccounts(auth);
    const connection: ConnectionStatus = { status: "verified", accountId: null };
    return NextResponse.json({ accounts, source: "shiphero", connection });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
