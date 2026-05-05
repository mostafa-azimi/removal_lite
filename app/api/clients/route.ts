import { NextResponse } from "next/server";
import { fetchCustomerAccounts } from "@/lib/shiphero";

export const runtime = "nodejs";
export const maxDuration = 30;
// Cache the client list for 5 min — it almost never changes.
export const revalidate = 300;

export async function GET() {
  try {
    const accounts = await fetchCustomerAccounts();
    return NextResponse.json({ accounts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
