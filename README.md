# Shiphero Pick List

A small Next.js app that takes the same ShipHero order-upload CSV used to
upload/create an order in ShipHero, calls the ShipHero GraphQL API to look up
bin/location data for every SKU, and prints a clean pick list with sortable
bin-level pick quantities.

This app is read-only against ShipHero. It does not create, update, or cancel
orders.

## What it does

1. Connects to ShipHero with the existing server refresh token, or a browser
   token saved on the Settings page for a one-off override.
2. Lists 3PL clients in a client filter dropdown.
3. Reads the same standard ShipHero order-upload CSV used for the ShipHero
   order import.
4. Uses `Product Sku (Required)` and `Quantity` as the pick-list driver.
5. Looks up product name, bin/location, warehouse, and on-hand quantity.
6. Allocates the needed quantity across available bins for each SKU.
7. Always shows the remaining available bins as alternate locations.
8. Sorts by location route, SKU, product, pick quantity, or low on-hand quantity.
9. Prints a paper-friendly pick list with checkboxes and page breaks.

## Output Columns

| Check | Use | Bin | SKU | Product | On hand | Needed | Pick |
|---|---|---|---|---|---|---|---|

The **Use** column marks each row as **Pick** or **Alternate**. The **Pick**
column is the amount to pull from that specific bin. Alternate rows are shown
for reference and validation, but their pick quantity is always `0`. If
available bins do not cover the full need, the remaining shortage appears in
the **Could not locate** section.

## Token Setup

The app defaults to the Vercel environment variable:

```text
SHIPHERO_REFRESH_TOKEN
```

The pick-list page uses the saved server token by default. Open **Settings** to
switch to a browser refresh token or browser access token. Browser tokens are
stored only in that browser and are used for ShipHero lookups: client list, SKU,
product, bin/location, and on-hand quantity.

When the app opens, it validates the active token and loads the client list. If
the page says the token is verified, no extra token entry is needed on the work
page.

## Usage

1. Open the app.
2. Open **Settings** only if you need to change the token source.
3. Pick a client filter, or leave **All clients** if SKUs are unique across clients.
4. Upload the exact same ShipHero order CSV used for the ShipHero order import.
5. Choose sort and optional location prefixes.
6. Click **Generate pick lists**.
7. Click **Print**.

## CSV Format

The app expects the standard ShipHero order-upload template. Use the exact same
CSV file that is uploaded into ShipHero. The app reads:

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
  settings/page.tsx       # Token source and browser token settings
  globals.css             # Screen + print CSS
  api/
    bins/route.ts         # POST /api/bins - SKU bin/location lookup
    clients/route.ts      # GET/POST /api/clients - client list
    picklist/route.ts     # POST /api/picklist - pick-list generation
lib/
  auth-settings.ts        # Browser token settings helper
  picklist.ts             # Pick quantity allocation + sort modes
  shiphero.ts             # Token refresh + read-only GraphQL queries
  sort.ts                 # Natural alphanumeric sort helpers
```
