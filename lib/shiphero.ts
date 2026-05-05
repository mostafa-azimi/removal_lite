/**
 * Minimal Shiphero GraphQL client.
 *
 * Auth flow:
 *   1. We hold a long-lived refresh_token in env.
 *   2. We POST it to /auth/refresh to get a short-lived access_token (~28 days).
 *   3. We cache that access_token in module memory until it expires.
 *
 * GraphQL endpoint: https://public-api.shiphero.com/graphql
 * Refresh endpoint: https://public-api.shiphero.com/auth/refresh
 *
 * Docs: https://developer.shiphero.com/
 */

const GRAPHQL_URL = "https://public-api.shiphero.com/graphql";
const REFRESH_URL = "https://public-api.shiphero.com/auth/refresh";

type CachedToken = { token: string; expiresAt: number };
let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.token;
  }
  const refreshToken = process.env.SHIPHERO_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      "Missing SHIPHERO_REFRESH_TOKEN environment variable. Set it in Vercel project settings."
    );
  }

  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shiphero token refresh failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Shiphero refresh response missing access_token");
  }
  // Default ~28 days; play it safe with 6h if the API doesn't report.
  const ttlMs = (data.expires_in ?? 6 * 3600) * 1000;
  cachedToken = { token: data.access_token, expiresAt: now + ttlMs };
  return cachedToken.token;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shiphero GraphQL HTTP ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length) {
    throw new Error(`Shiphero GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) {
    throw new Error("Shiphero GraphQL response missing data");
  }
  return json.data;
}

/**
 * Returned bin row, one per (warehouse, bin) for a SKU.
 * If a SKU has no per-bin breakdown we fall back to a single row with the
 * warehouse-level inventory_bin and on_hand quantity.
 */
export type BinRow = {
  sku: string;
  productName: string | null;
  warehouseId: string | null;
  warehouseIdentifier: string | null;
  bin: string;
  onHand: number;
};

type ProductsResponse = {
  products: {
    data: {
      edges: Array<{
        node: {
          sku: string;
          name: string | null;
          warehouse_products: Array<{
            warehouse_id: string | null;
            on_hand: number | null;
            inventory_bin: string | null;
            warehouse: { identifier: string | null } | null;
            locations?: {
              edges: Array<{
                node: {
                  location_name: string | null;
                  inventory_bin?: string | null;
                  on_hand: number | null;
                };
              }>;
            };
          }>;
        };
      }>;
    };
  };
};

/**
 * Note for 3PLs: Shiphero scopes products to a client (customer_account) using the
 * `customer_account_id` argument on the `products` query. Pass it through and Shiphero
 * will only return SKUs belonging to that client.
 */
const PRODUCT_BINS_QUERY = /* GraphQL */ `
  query GetSkuLocations($sku: String!, $customerAccountId: String) {
    products(sku: $sku, customer_account_id: $customerAccountId) {
      data(first: 1) {
        edges {
          node {
            sku
            name
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
                    location_name
                    on_hand
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

/**
 * Fallback query without the nested locations connection — some Shiphero accounts
 * don't expose `locations` on warehouse_products, in which case we use the single
 * `inventory_bin` field per warehouse.
 */
const PRODUCT_BINS_QUERY_FALLBACK = /* GraphQL */ `
  query GetSkuLocations($sku: String!, $customerAccountId: String) {
    products(sku: $sku, customer_account_id: $customerAccountId) {
      data(first: 1) {
        edges {
          node {
            sku
            name
            warehouse_products {
              warehouse_id
              on_hand
              inventory_bin
              warehouse {
                identifier
              }
            }
          }
        }
      }
    }
  }
`;

export async function fetchBinsForSku(
  sku: string,
  customerAccountId?: string | null
): Promise<BinRow[]> {
  const variables = { sku, customerAccountId: customerAccountId || null };
  let data: ProductsResponse;
  try {
    data = await gql<ProductsResponse>(PRODUCT_BINS_QUERY, variables);
  } catch (err) {
    // If the locations connection isn't available, fall back to bin-only.
    data = await gql<ProductsResponse>(PRODUCT_BINS_QUERY_FALLBACK, variables);
  }

  const edges = data.products?.data?.edges ?? [];
  if (edges.length === 0) return [];
  const node = edges[0].node;
  const rows: BinRow[] = [];

  for (const wp of node.warehouse_products ?? []) {
    const warehouseId = wp.warehouse_id ?? null;
    const warehouseIdentifier = wp.warehouse?.identifier ?? null;
    const locEdges = wp.locations?.edges ?? [];

    if (locEdges.length > 0) {
      for (const le of locEdges) {
        const bin = le.node.location_name?.trim();
        if (!bin) continue;
        const onHand = le.node.on_hand ?? 0;
        // Filter out empty bins — we don't want to walk to them.
        if (onHand <= 0) continue;
        rows.push({
          sku: node.sku,
          productName: node.name,
          warehouseId,
          warehouseIdentifier,
          bin,
          onHand,
        });
      }
    } else {
      // Fallback: a single row per warehouse using inventory_bin.
      const onHand = wp.on_hand ?? 0;
      if (onHand <= 0) continue;
      const bin = wp.inventory_bin?.trim() || "(no bin)";
      rows.push({
        sku: node.sku,
        productName: node.name,
        warehouseId,
        warehouseIdentifier,
        bin,
        onHand,
      });
    }
  }
  return rows;
}

/**
 * Fetch bins for many SKUs in parallel, with a small concurrency cap so we don't
 * blow Shiphero's GraphQL complexity budget.
 */
export async function fetchBinsForSkus(
  skus: string[],
  customerAccountId?: string | null,
  concurrency = 4
): Promise<Record<string, { rows: BinRow[]; error?: string }>> {
  const result: Record<string, { rows: BinRow[]; error?: string }> = {};
  const queue = [...new Set(skus)];

  async function worker() {
    while (queue.length) {
      const sku = queue.shift();
      if (!sku) return;
      try {
        const rows = await fetchBinsForSku(sku, customerAccountId);
        result[sku] = { rows };
      } catch (err) {
        result[sku] = {
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}

/**
 * Return the list of customer (client) accounts visible to the connected token.
 *
 * Shiphero's GraphQL schema doesn't expose a direct "list customer accounts"
 * query — but every Product carries a `customer_account_id`, so we can
 * enumerate distinct clients by paginating through the products list.
 *
 * For each distinct customer_account_id we keep one product name as a hint
 * so the dropdown shows something more useful than a bare UUID.
 */
export type CustomerAccount = {
  id: string;
  companyName: string;
  email: string | null;
};

const CLIENTS_FROM_PRODUCTS_QUERY = /* GraphQL */ `
  query DiscoverCustomerAccounts($cursor: String) {
    products {
      data(first: 100, after: $cursor) {
        edges {
          cursor
          node {
            account_id
            name
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

type ClientsFromProductsResponse = {
  products: {
    data: {
      edges: Array<{
        cursor: string;
        node: {
          account_id: string | null;
          name: string | null;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
};

export async function fetchCustomerAccounts(): Promise<CustomerAccount[]> {
  const seen = new Map<string, { sampleProductName: string | null }>();
  let cursor: string | null = null;

  // Paginate through products. We cap at 50 pages (5,000 products) so very
  // large catalogs don't make the dropdown take forever to load. If you have
  // more than 5,000 SKUs, raise this — or switch to a dedicated client list.
  for (let i = 0; i < 50; i++) {
    const data: ClientsFromProductsResponse = await gql<ClientsFromProductsResponse>(
      CLIENTS_FROM_PRODUCTS_QUERY,
      { cursor }
    );
    const conn = data.products?.data;
    const edges = conn?.edges ?? [];
    for (const edge of edges) {
      const id = edge.node.account_id;
      if (!id) continue;
      if (!seen.has(id)) {
        seen.set(id, { sampleProductName: edge.node.name ?? null });
      }
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (!cursor) break;
  }

  const accounts: CustomerAccount[] = [...seen.entries()].map(([id, info]) => ({
    id,
    // No company name available from products query; show the ID with a
    // sample product name as a hint so the user can tell which client is which.
    companyName: info.sampleProductName
      ? `${id} — e.g. ${info.sampleProductName}`
      : id,
    email: null,
  }));

  // Sort alphabetically for the dropdown.
  accounts.sort((a, b) =>
    a.companyName.localeCompare(b.companyName, undefined, { sensitivity: "base" })
  );
  return accounts;
}
