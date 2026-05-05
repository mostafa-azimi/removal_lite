# Shiphero Pick List

A small Next.js app that takes a Shiphero order-upload CSV, calls the Shiphero
GraphQL API to look up every bin location for every SKU on the order, and
prints a clean, paper-friendly pick list sorted by warehouse → bin
(alphanumerically) so you minimise your walking path.

## What it does

1. Lists your 3PL clients in a dropdown — pulled live from Shiphero.
2. You upload an order CSV (the standard Shiphero order-upload template).
3. For each SKU on the order, the app asks Shiphero for every bin location
   that has on-hand inventory **greater than zero** for the selected client.
4. It groups the result by warehouse, then sorts by bin location using a
   natural alphanumeric sort (so `A-1-2` comes before `A-1-10`).
5. The result is rendered as a print-optimised page — letter (8.5" × 11"),
   half-inch margins, big checkboxes next to every line, page-break-aware.
   Hit **Print** (or ⌘P / Ctrl-P) and you've got your paper pick list.

## Output columns

| ☐ | Bin | SKU | Product | On hand | Pick qty |
|---|-----|-----|---------|---------|----------|

The on-hand column is informational so the picker can see if a bin is close
to being emptied. The pick-qty column is the total number of units needed
across every order in the uploaded CSV (SKUs are aggregated across orders).

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
4. Click **Generate pick list**.
5. Click **Print**.

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

## CSV format

The app expects the standard Shiphero order-upload template. Specifically,
it reads these columns:

- `Product Sku (Required)` — the SKU
- `Quantity` — units needed
- `Order Number (Required)` — used in the printed header (optional)
- `Warehouse` — informational; actual warehouse filtering comes from
  Shiphero's response

Other columns are ignored.

## Troubleshooting

**"Couldn't load clients"** — `SHIPHERO_REFRESH_TOKEN` isn't set, or the
token has expired. Regenerate in Shiphero and update the Vercel env var.

**"No bins with on-hand quantity > 0"** — the SKU exists for that client
but every bin holding it is empty. Confirm the SKU is set up for the
selected client (3PLs sometimes have the same SKU under multiple clients).

**Some SKUs missing from the printed list** — they'll appear in the
"Could not locate" section at the bottom of the printout, with the reason.

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
    picklist/route.ts     # POST /api/picklist — generate pick list
lib/
  shiphero.ts             # Token refresh + GraphQL queries
  sort.ts                 # Natural alphanumeric sort for bin codes
.env.example              # SHIPHERO_REFRESH_TOKEN
package.json
next.config.js
tsconfig.json
```
