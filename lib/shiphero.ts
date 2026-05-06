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

type ShipheroError = {
  message: string;
  code?: number;
  time_remaining?: string;
  required_credits?: number;
  remaining_credits?: number;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  attempt = 0
): Promise<T> {
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
  const json = (await res.json()) as {
    data?: T;
    errors?: ShipheroError[];
  };

  // Handle rate-limit errors (code 30) with backoff.
  const rateLimitErr = json.errors?.find((e) => e.code === 30);
  if (rateLimitErr) {
    if (attempt >= 5) {
      throw new Error(
        `Shiphero rate-limit retry exhausted: ${rateLimitErr.message}`
      );
    }
    // Parse "X seconds" out of time_remaining; default 2s. Add jitter.
    const m = rateLimitErr.time_remaining?.match(/(\d+)/);
    const waitSecs = m ? Math.max(1, parseInt(m[1], 10)) : 2;
    const waitMs = waitSecs * 1000 + 250 + Math.random() * 250;
    await sleep(waitMs);
    return gql<T>(query, variables, attempt + 1);
  }

  if (json.errors && json.errors.length) {
    throw new Error(
      `Shiphero GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`
    );
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
          account_id?: string | null;
          warehouse_products: Array<{
            warehouse_id: string | null;
            on_hand: number | null;
            inventory_bin: string | null;
            warehouse: { identifier: string | null } | null;
            locations?: {
              edges: Array<{
                node: {
                  quantity: number | null;
                  location: { id: string | null; name: string | null } | null;
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
 * Bin lookup by SKU.
 *
 * Shiphero stores the actual bin code in the `locations` connection on each
 * warehouse_product (the `inventory_bin` field comes back as whitespace in
 * many accounts). We query locations(first: 50) — at this size and with
 * products(first: 1) the total complexity is well under the 4004-credit
 * budget, and retry-on-rate-limit handles any spikes.
 */
const PRODUCT_BINS_QUERY = /* GraphQL */ `
  query GetSkuLocations($sku: String!) {
    products(sku: $sku) {
      data(first: 1) {
        edges {
          node {
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
              locations(first: 50) {
                edges {
                  node {
                    quantity
                    location {
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

type ProductNode = {
  sku: string;
  name: string | null;
  account_id?: string | null;
  warehouse_products: Array<{
    warehouse_id: string | null;
    on_hand: number | null;
    inventory_bin: string | null;
    warehouse: { identifier: string | null } | null;
    locations?: {
      edges: Array<{
        node: {
          quantity: number | null;
          location: { id: string | null; name: string | null } | null;
        };
      }>;
    };
  }>;
};

function buildBinRowsFromProduct(node: ProductNode): BinRow[] {
  const rows: BinRow[] = [];
  for (const wp of node.warehouse_products ?? []) {
    const warehouseId = wp.warehouse_id ?? null;
    const warehouseIdentifier = wp.warehouse?.identifier ?? null;
    const locEdges = wp.locations?.edges ?? [];

    if (locEdges.length > 0) {
      for (const le of locEdges) {
        const bin = le.node.location?.name?.trim();
        if (!bin) continue;
        const onHand = le.node.quantity ?? 0;
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

export async function fetchBinsForSku(
  sku: string,
  customerAccountId?: string | null
): Promise<BinRow[]> {
  const variables = { sku };
  const data = await gql<ProductsResponse>(PRODUCT_BINS_QUERY, variables);

  const edges = data.products?.data?.edges ?? [];
  if (edges.length === 0) return [];

  // If a client was selected, prefer the product whose account_id matches.
  // If none match (e.g. account_id field doesn't represent the customer the
  // way we think), fall back to all products to avoid silently dropping bins.
  const wantedId = customerAccountId?.trim();
  let nodes = edges.map((e) => e.node as ProductNode);
  if (wantedId) {
    const filtered = nodes.filter((n) => String(n.account_id ?? "") === wantedId);
    if (filtered.length > 0) nodes = filtered;
  }

  const rows: BinRow[] = [];
  for (const node of nodes) {
    rows.push(...buildBinRowsFromProduct(node));
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
 * Strategy: Shiphero exposes a top-level `users` connection. For a 3PL
 * operator's token this returns one (or more) user records per customer
 * account. We dedupe by `account.id` to get the distinct list of clients.
 *
 * If `users` isn't available on this account's schema, we fall back to
 * paginating products and extracting unique `account_id` values.
 */
export type CustomerAccount = {
  id: string;
  companyName: string;
  email: string | null;
};

const USERS_QUERY = /* GraphQL */ `
  query ListUsers($cursor: String) {
    users {
      data(first: 100, after: $cursor) {
        edges {
          cursor
          node {
            id
            first_name
            last_name
            email
            username
            account {
              id
              email
              username
              company_name
            }
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

type UsersResponse = {
  users: {
    data: {
      edges: Array<{
        cursor: string;
        node: {
          id: string | null;
          first_name: string | null;
          last_name: string | null;
          email: string | null;
          username: string | null;
          account: {
            id: string | null;
            email: string | null;
            username: string | null;
            company_name: string | null;
          } | null;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
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

async function fetchCustomerAccountsViaUsers(): Promise<CustomerAccount[] | null> {
  const seen = new Map<string, CustomerAccount>();
  let cursor: string | null = null;

  for (let i = 0; i < 50; i++) {
    let data: UsersResponse;
    try {
      data = await gql<UsersResponse>(USERS_QUERY, { cursor });
    } catch (err) {
      // Schema doesn't have `users` — caller will fall back.
      if (i === 0) return null;
      throw err;
    }
    const conn = data.users?.data;
    const edges = conn?.edges ?? [];
    for (const edge of edges) {
      const acct = edge.node.account;
      if (!acct?.id) continue;
      if (seen.has(acct.id)) continue;
      const display =
        acct.company_name ||
        acct.username ||
        [edge.node.first_name, edge.node.last_name].filter(Boolean).join(" ").trim() ||
        acct.email ||
        edge.node.email ||
        acct.id;
      seen.set(acct.id, {
        id: acct.id,
        companyName: display,
        email: acct.email || edge.node.email,
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (!cursor) break;
  }

  return [...seen.values()];
}

async function fetchCustomerAccountsViaProducts(): Promise<CustomerAccount[]> {
  const seen = new Map<string, { sampleProductName: string | null }>();
  let cursor: string | null = null;

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

  return [...seen.entries()].map(([id, info]) => ({
    id,
    companyName: info.sampleProductName
      ? `${id} — e.g. ${info.sampleProductName}`
      : id,
    email: null,
  }));
}

export async function fetchCustomerAccounts(): Promise<CustomerAccount[]> {
  // Primary path: top-level users query (returns clients reliably for 3PLs).
  let accounts = await fetchCustomerAccountsViaUsers();

  // Fallback: derive from products if users isn't available.
  if (!accounts || accounts.length === 0) {
    accounts = await fetchCustomerAccountsViaProducts();
  }

  // Sort alphabetically for the dropdown.
  accounts.sort((a, b) =>
    a.companyName.localeCompare(b.companyName, undefined, { sensitivity: "base" })
  );
  return accounts;
}
