# Shiphero Pick List + Order Import

A small Next.js app that takes a Shiphero order-upload CSV, calls the Shiphero
GraphQL API to look up every bin location for every SKU on the order, and
prints a clean, paper-friendly pick list with sortable bin-level pick
quantities so you can validate and pick from the same upload.

It can also parse a CSV into ShipHero `order_create` payloads, run a dry-run
validation, create live ShipHero orders after an explicit confirmation, then
build the printable pick list from the created ShipHero order line items.

## What it does

1. Lists your 3PL clients in a dropdown — pulled live from Shiphero.
2. You upload an order CSV (the standard Shiphero order-upload template).
3. For each SKU on the order, the app asks Shiphero for every bin location
   that has on-hand inventory **greater than zero** for the selected client.
4. It allocates the needed quantity across the available bins for each SKU.
5. It can sort the printed pick list by location route, SKU, product, pick
   quantity, or low on-hand quantity.
6. The result is rendered as a print-optimised page — letter (8.5" × 11"),
   half-inch margins, big checkboxes next to every line, page-break-aware.
   Hit **Print** (or ⌘P / Ctrl-P) and you've got your paper pick list.
7. Optionally dry-run the parsed orders, then create them in ShipHero with the
   selected customer account.
8. After live creation, it fetches each created order's line items from
   ShipHero and prepares pick lists from those order records.
9. Optional location prefixes split the printed pick list by bin prefix, such
   as `A`, `B`, or `A-1`.

## Output columns

| ☐ | Bin | SKU | Product | On hand | Needed | Pick |
|---|-----|-----|---------|---------|--------|------|

The on-hand column is informational so the picker can see if a bin is close
to being emptied. The needed column is the order quantity for that SKU. The
pick column is the amount to pull from that specific bin. If the selected
bins do not cover the full need, the remaining shortage appears in the
**Could not locate** section.

## Deploying to Vercel

### 1. Get a Shiphero refresh token

In Shiphero: **My Account → Settings → 3rd Party Auth**. Generate a
refresh token. (See [Shiphero's getting-started
guide](https://developer.shiphero.com/getting-started/) for the latest
instructions.)

### 2. Push this folder to a Git repo

```bash
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

### 3. Import into Vercel

- Go to [vercel.com/new](https://vercel.com/new) and import the repo.
- Vercel auto-detects Next.js — accept the defaults.
- Under **Environment Variables**, add:
  - `SHIPHERO_REFRESH_TOKEN` = the refresh token from step 1
- Click **Deploy**.

### 4. Use it

1. Open the deployed URL.
2. Pick the client from the dropdown.
3. Upload the order CSV.
4. Choose the pick-list sort and any location prefixes.
5. Click **Generate pick lists**, or use **Dry run** in the order creation
   section to validate the upload.
6. To create live orders, uncheck **Dry run**, confirm, and click **Create orders**.
7. The app will fetch the created ShipHero order lines and prepare pick lists.
8. Click **Print**.

## Local development

```bash
npm install
cp .env.example .env.local
# edit .env.local and paste your refresh token
npm run dev
# open http://localhost:3000
```

## How the auth works

The app stores only the long-lived **refresh token** as an environment
variable. On each cold start, the server calls
`https://public-api.shiphero.com/auth/refresh` to exchange it for a
short-lived access token, which it caches in memory until it expires.

No user-facing login. Anyone who can hit the deployed URL can use your
Shiphero account, so make sure the URL is private (Vercel's free password
protection or a basic auth middleware are easy adds if you need them).

## CSV format for pick lists

The app expects the standard Shiphero order-upload template. Specifically,
it reads these columns:

- `Product Sku (Required)` — the SKU
- `Quantity` — units needed
- `Order Number (Required)` — used in the printed header (optional)
- `Warehouse` — informational; actual warehouse filtering comes from
  Shiphero's response

Other columns are ignored.

## Pick-list sorting

Use **Sort pick list** before printing. Options include location route, SKU,
product name, pick quantity high-to-low, pick quantity low-to-high, and low
on-hand quantity. Changing the sort does not call ShipHero again; it reorders
the currently generated pick list.

## CSV format for order creation

Order creation requires enough data to build ShipHero's `CreateOrderInput`.
The parser accepts common variants of these headers:

- `Order Number (Required)`
- `Product Sku (Required)`
- `Quantity`
- `Shipping Address 1` or `Address 1`
- `Shipping City` or `City`
- `Shipping State` or `State`
- `Shipping Zip` or `Zip`
- `Shipping Country` or `Country`

Optional fields include customer name, email, phone, product name, price, shop
name, order date, fulfillment status, tags, shipping carrier/method/price, and
billing address fields. If line item price is missing, the app sends `0.00`.
If country is missing, it defaults to `US`. ShipHero requires a unique
`partner_line_item_id`; when the CSV does not provide one, the app derives one
from the order number and row order.

## Testing order creation

Dry-run mode never calls ShipHero's mutation. It validates the parsed payloads
and reports which orders are ready or invalid.

For live creation, use either:

- `SHIPHERO_REFRESH_TOKEN` in `.env.local` / Vercel environment variables, or
- a refresh token or access token entered in the page for one test run.

ShipHero's public API does not use an API key for this flow. It uses bearer
access tokens, usually refreshed from a long-lived refresh token.

## Location prefix breakdown

Use the **Location prefixes** field before printing to split the pick list by
bin prefix. Enter one or more comma-separated prefixes:

```text
A, B, A-1
```

Each value is treated as a literal prefix. A one-character value like `A`
matches bins that start with `A`; a longer value like `A-1` matches bins that
start with `A-1`. If prefixes overlap, the longer prefix is matched first so
the more specific group wins. Unmatched bins appear under **Other locations**.

## Troubleshooting

**"Couldn't load clients"** — `SHIPHERO_REFRESH_TOKEN` isn't set, or the
token has expired. Regenerate in Shiphero and update the Vercel env var.

**"No bins with on-hand quantity > 0"** — the SKU exists for that client
but every bin holding it is empty. Confirm the SKU is set up for the
selected client (3PLs sometimes have the same SKU under multiple clients).

**Some SKUs missing from the printed list** — they'll appear in the
"Could not locate" section at the bottom of the printout, with the reason.

**Live order created but no pick list appeared** — the order was created, but
the follow-up order or bin lookup failed. Check the message in the import
results; it will include the ShipHero/API error.

**Order is huge and the request times out** — Vercel's serverless function
timeout for hobby plans is 10s, pro is 60s (which the route is configured
for). For thousand-line orders consider upgrading or switching to Vercel's
Edge runtime.

## File map

```
app/
  page.tsx                # Upload UI + printable pick list
  layout.tsx              # Root layout
  globals.css             # Screen + print CSS (8.5×11)
  api/
    clients/route.ts      # GET /api/clients — list 3PL clients
    orders/route.ts       # POST /api/orders — dry-run or create ShipHero orders
    picklist/route.ts     # POST /api/picklist — generate pick list
lib/
  order-import.ts         # CSV parsing + order import validation
  picklist.ts             # Pick quantity allocation + sort modes
  shiphero.ts             # Token refresh + GraphQL queries
  sort.ts                 # Natural alphanumeric sort for bin codes
.env.example              # SHIPHERO_REFRESH_TOKEN
package.json
next.config.js
tsconfig.json
```
