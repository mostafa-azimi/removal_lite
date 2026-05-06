import { NextRequest, NextResponse } from "next/server";

/**
 * Debug endpoint: takes ?sku=<sku> and returns the raw Shiphero GraphQL
 * response so we can see exactly what's coming back. This is the ground truth
 * when the bins query is returning empty results.
 *
 * Usage: GET /api/debug/sku?sku=SP25-ALLSTAR-MENS-SHORTS-STAR-M
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
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Failed to refresh token");
  return data.access_token;
}

const QUERY = /* GraphQL */ `
  query DebugSku($sku: String!) {
    products(sku: $sku) {
      request_id
      complexity
      data(first: 10) {
        edges {
          node {
            id
            sku
            name
            account_id
            warehouse_products {
              warehouse_id
              on_hand
              inventory_bin
              warehouse {
                identifier
              }
              locations {
                edges {
                  node {
                    quantity
                    location {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sku = req.nextUrl.searchParams.get("sku");
  if (!sku) {
    return NextResponse.json(
      { error: "Pass ?sku=<sku> in the URL" },
      { status: 400 }
    );
  }
  try {
    const token = await getAccessToken();
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: QUERY, variables: { sku } }),
    });
    const json = await res.json();
    // Build a small summary so we can see at a glance what's in the response.
    const edges = json?.data?.products?.data?.edges ?? [];
    const summary = {
      productsReturned: edges.length,
      products: edges.map((e: any) => {
        const node = e.node;
        const wps = node.warehouse_products ?? [];
        return {
          id: node.id,
          sku: node.sku,
          name: node.name,
          account_id: node.account_id,
          warehouseProductsCount: wps.length,
          warehouses: wps.map((wp: any) => ({
            warehouse_id: wp.warehouse_id,
            warehouse_identifier: wp.warehouse?.identifier,
            on_hand: wp.on_hand,
            inventory_bin: wp.inventory_bin,
            locationsCount: wp.locations?.edges?.length ?? 0,
            locations: (wp.locations?.edges ?? []).map((le: any) => ({
              bin: le.node?.location?.name,
              quantity: le.node?.quantity,
            })),
          })),
        };
      }),
    };
    return NextResponse.json(
      { sku, summary, raw: json },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
