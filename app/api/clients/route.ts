import { NextResponse } from "next/server";
import { fetchCustomerAccounts } from "@/lib/shiphero";
import clientsConfig from "@/data/clients.json";

export const runtime = "nodejs";
export const maxDuration = 30;
// Cache the client list for 5 min — it almost never changes.
export const revalidate = 300;

type ConfigClient = { id: string; name: string };

export async function GET() {
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
    const accounts = config
      .map((c) => ({ id: c.id, companyName: c.name, email: null }))
      .sort((a, b) =>
        a.companyName.localeCompare(b.companyName, undefined, { sensitivity: "base" })
      );
    return NextResponse.json({ accounts, source: "config" });
  }

  // Fallback: try Shiphero auto-discovery (best-effort).
  try {
    const accounts = await fetchCustomerAccounts();
    return NextResponse.json({ accounts, source: "shiphero" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
