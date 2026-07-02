import { NextRequest, NextResponse } from "next/server";
import { fetchCustomerAccounts, type ShipHeroAuthOverride } from "@/lib/shiphero";
import clientsConfig from "@/data/clients.json";

export const runtime = "nodejs";
export const maxDuration = 30;
// Cache the client list for 5 min — it almost never changes.
export const revalidate = 300;

type ConfigClient = { id: string; name: string };

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

export async function GET() {
  const config = configuredAccounts();
  if (config) return NextResponse.json({ accounts: config, source: "config" });

  // Fallback: try Shiphero auto-discovery (best-effort).
  try {
    const accounts = await fetchCustomerAccounts();
    return NextResponse.json({ accounts, source: "shiphero" });
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

  const config = configuredAccounts();
  if (config) return NextResponse.json({ accounts: config, source: "config" });

  try {
    const accounts = await fetchCustomerAccounts(cleanAuth(body.auth));
    return NextResponse.json({ accounts, source: "shiphero" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
