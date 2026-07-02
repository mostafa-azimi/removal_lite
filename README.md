# Shiphero Pick List

A small Next.js app that takes a ShipHero order-upload CSV, calls the ShipHero
GraphQL API to look up bin/location data for every SKU, and prints a clean
pick list with sortable bin-level pick quantities.

This app is read-only against ShipHero. It does not create, update, or cancel
orders.

## What it does

1. Connects to ShipHero with the existing server refresh token, or a token
   pasted into the page for a one-off override.
2. Lists 3PL clients in a dropdown.
3. Reads the standard ShipHero order-upload CSV.
4. Uses `Product Sku (Required)` and `Quantity` as the pick-list driver.
5. Looks up product name, bin/location, warehouse, and on-hand quantity.
6. Allocates the needed quantity across available bins for each SKU.
7. Sorts by location route, SKU, product, pick quantity, or low on-hand quantity.
8. Prints a paper-friendly pick list with checkboxes and page breaks.

## Output Columns

| Check | Bin | SKU | Product | On hand | Needed | Pick |
|---|---|---|---|---|---|---|

The **Pick** column is the amount to pull from that specific bin. If available
bins do not cover the full need, the remaining shortage appears in the
**Could not locate** section.

## Token Setup

The app defaults to the Vercel environment variable:

```text
SHIPHERO_REFRESH_TOKEN
```

In the page, leave **Token source** as **Use server token** to keep using that
stored token. To test or recover from an expired token, choose **Refresh token**
or **Access token**, paste the value, and click **Load clients**.

The pasted token is only used for ShipHero lookups in that browser session:
client list, SKU, product, bin/location, and on-hand quantity.

## Usage

1. Open the app.
2. Choose **Use server token**, or paste an override token.
3. Click **Load clients**.
4. Pick a client, or leave **All clients** if you do not want a client filter.
5. Upload the ShipHero order CSV.
6. Choose sort and optional location prefixes.
7. Click **Generate pick lists**.
8. Click **Print**.

## CSV Format

The app expects the standard ShipHero order-upload template and reads:

- `Order Number (Required)` - used to group printed pages.
- `Product Sku (Required)` - SKU to look up.
- `Quantity` - units needed.

Address and shipping fields are ignored.

## Location Prefix Breakdown

Use **Location prefixes** before printing to split the pick list by bin prefix.
Enter comma-separated prefixes:

```text
A, B, A-1
```

A one-character value like `A` matches bins that start with `A`. A longer value
like `A-1` matches bins that start with `A-1`. If prefixes overlap, the longer
prefix is matched first. Unmatched bins appear under **Other locations**.

## Local Development

```bash
npm install
cp .env.example .env.local
# edit .env.local and paste your refresh token
npm run dev
```

## File Map

```text
app/
  page.tsx                # Upload UI + printable pick list
  globals.css             # Screen + print CSS
  api/
    bins/route.ts         # POST /api/bins - SKU bin/location lookup
    clients/route.ts      # GET/POST /api/clients - client list
    picklist/route.ts     # POST /api/picklist - pick-list generation
lib/
  picklist.ts             # Pick quantity allocation + sort modes
  shiphero.ts             # Token refresh + read-only GraphQL queries
  sort.ts                 # Natural alphanumeric sort helpers
```
