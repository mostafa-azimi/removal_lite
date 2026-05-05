import { NextResponse } from "next/server";

/**
 * Debug endpoint: introspects Shiphero's GraphQL schema and returns the
 * fields available on a few key types. Hit this in your browser at
 *   /api/debug/schema
 * to see what the API actually exposes for your account.
 *
 * This is safe to leave deployed (it only returns schema metadata, not data),
 * but you can delete this file once you're done debugging.
 */

const GRAPHQL_URL = "https://public-api.shiphero.com/graphql";
const REFRESH_URL = "https://public-api.shiphero.com/auth/refresh";

async function getAccessToken(): Promise<string> {
  const refreshToken = process.env.SHIPHERO_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("Missing SHIPHERO_REFRESH_TOKEN");
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

const INTROSPECTION_QUERY = /* GraphQL */ `
  query IntrospectKey {
    Account: __type(name: "Account") {
      name
      fields { name type { name kind ofType { name kind } } }
    }
    Product: __type(name: "Product") {
      name
      fields { name type { name kind ofType { name kind } } }
    }
    Query: __type(name: "Query") {
      name
      fields(includeDeprecated: false) {
        name
        args { name type { name kind ofType { name kind } } }
        type { name kind ofType { name kind } }
      }
    }
    WarehouseProduct: __type(name: "WarehouseProduct") {
      name
      fields { name type { name kind ofType { name kind } } }
    }
  }
`;

export const runtime = "nodejs";

export async function GET() {
  try {
    const token = await getAccessToken();
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    });
    const json = await res.json();
    return NextResponse.json(json, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
