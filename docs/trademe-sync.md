# Trade Me sync: local app ↔ Pack Check

The local Trade Me ops app decides what is ready to pack (payment, shipping,
holds, and so on). It pushes those jobs here, Pack Check shows them, and the
local app reads back what has been packed.

```
local Trade Me app ──POST /api/trademe-sync──▶ bulk-photo-match2 ──▶ Pack Check
        ▲                                                              │
        └────────────GET /api/trademe-sync (packed items)◀─────────────┘
```

## One-time setup

```bash
fly secrets set TRADEME_SYNC_SECRET=<secret> -a bulk-photo-match2
```

Give the local app the same secret. Never commit it.

All requests carry `Authorization: Bearer <secret>`.

## 1. Push ready-to-pack jobs (`POST /api/trademe-sync`)

Every push is a **full snapshot**: send every job that is ready to pack right
now. Jobs and items left out are removed, so holds, refunds, cancellations
and dispatches drop out of Pack Check on the next push.

```json
{
  "jobs": [
    {
      "groupKey": "buyer-123456",          // required, stable per parcel
      "fulfilmentChannel": "trademe",      // required: "trademe" | "mixed"
      "buyerUsername": "kiwicollector",
      "buyerMemberId": "123456",
      "buyerName": "Jo Bloggs",
      "buyerEmail": "jo@example.com",
      "deliveryAddress": "Jo Bloggs\n1 Example St\nWellington 6011",
      "readiness": "Paid, shipping chosen",
      "kanbanCol": "ready",
      "totalSale": 42.5,
      "shippingPaid": 6.5,
      "paidTotal": 49.0,
      "items": [
        {
          "purchaseId": "987654321",       // required, unique per sale
          "listingId": "4567890123",
          "sku": "AB-012",
          "title": "Card title",
          "quantity": 1,
          "salePrice": 42.5,               // total for this line, not per unit
          "shippingPrice": 6.5,
          "soldDate": "2026-11-07T21:14:00Z",
          "saleChannel": "auction",
          "imageUrl": "https://trademe.tmcdn.co.nz/photoserver/full/123.jpg"
        }
      ]
    }
  ]
}
```

`imageUrl` is optional: older clients can leave it out, or send `""` when
there's no photo. Only http(s) URLs on Trade Me photo hosts (`trademe.co.nz`,
`tmcdn.co.nz` and their subdomains) are kept, and http is upgraded to https.
Anything else is stored as no photo; the sync itself never fails because of
it. Each push replaces the stored URL, so clearing or changing it takes
effect on the next sync. This server never downloads the image; the packer's
browser loads it directly.

An empty `jobs` list is refused, because it would remove every job and is
usually a bug. When nothing really is ready to pack, send
`{ "jobs": [], "allowEmpty": true }`.

## 2. Read back packing events (`GET /api/trademe-sync?after=<cursor>&limit=<n>`)

Packing in Pack Check is physical work only. It never fulfils, dispatches,
confirms payment or clears a hold. Each completed package produces events,
and the local app reads them with a cursor.

```json
{
  "events": [
    { "eventId": "41", "type": "packed", "kind": "trademe_purchase", "packageId": "pkg_…",
      "occurredAt": "2026-11-13T05:00:00.000Z",
      "purchaseId": "987654321", "groupKey": "job-123", "quantity": 1 },
    { "eventId": "42", "type": "packed", "kind": "shopify_order", "packageId": "pkg_…",
      "occurredAt": "2026-11-13T05:00:00.000Z",
      "orderId": "gid://shopify/Order/123", "orderName": "SO4392",
      "tradeMeSalesRecordId": "P252876776",
      "orderLineCount": 1,
      "buyerEmail": "buyer@example.com",
      "lineItems": [ { "lineItemId": "gid://shopify/LineItem/9", "sku": "SVI080", "quantity": 1,
                       "tradeMePurchaseId": "252876776" } ] }
  ],
  "cursor": "v1.42",
  "hasMore": false,
  "tradeMeChannelConfigured": true,
  "packed": [ … ],
  "packedShopifyOrders": [ … ]
}
```

**Paging and cursor**
- `after`: omit it to start from the very first event. Otherwise send back
  the last `cursor` you received, **exactly as received**. The cursor is
  opaque: don't build, parse or compare it. A malformed cursor gets a 400.
- `limit`: 1–500, default 200.
- Events come in a strict order (no timestamp ties). `cursor` is the
  position of the last event in this response; if there were none, it's the
  cursor you sent. Save it only after you've durably processed the page.
  Keep requesting while `hasMore` is true.
- Re-reading from an older cursor, or from the start, returns the same
  events again. Events are never deleted, so a full replay is always
  possible. Apply them idempotently, keyed by `eventId`.

**Event types**
- `type`: `"packed"`, or `"unpacked"` when someone undoes a mistaken pack
  from Pack Check's Packed view. An `unpacked` event repeats the fields of
  the `packed` event it reverses. Undo writes one `unpacked` for every
  purchase or order in the package whose latest event is `packed`, whichever
  package it was originally tagged with. That includes events back-filled
  from before the stream existed, which have `packageId: null`. Pack Check is
  the source of packing status; the local app mirrors it.
- If an earlier undo missed some `unpacked` events (fixed 13 Nov 2026), the
  next read writes them automatically. That covers any purchase whose latest
  event is `packed` but which Pack Check no longer holds as packed.
- `kind: "trademe_purchase"`: one Trade Me purchase, matched by
  `purchaseId`. `groupKey` is the parcel it was packed in. `quantity` is the
  quantity scanned; it's `null` on events back-filled from before quantities
  were recorded.
- `kind: "shopify_order"`: one Shopify order packed in full. `lineItems`
  lists every line that still had something to send, with that quantity.
  Shopify order events are only produced for orders from the confirmed
  Trade Me sales channel (see below), so website orders never appear.
- `tradeMeSalesRecordId` is the raw "Trade Me sales record ID" attribute
  that Omnivore puts on the order, or `null` if it's absent or blank. It's
  passed through unchanged:
  - `P<digits>`: a single Trade Me purchase (purchase ID = digits);
  - `C<digits>`: a Trade Me cart with several purchases (Trade Me OrderId =
    digits), e.g. SO4447 → `C6668449`.
- `orderLineCount`: every line on the Shopify order, including lines
  refunded or removed to zero; `null` if Shopify had more lines than Pack
  Check fetched. `lineItems` lists only lines still to send, so a smaller
  `lineItems` means something was removed.
- `buyerEmail`: the Shopify order's email, trimmed and lower-cased, or `null`.
  It's for verifying the buyer when matching a cart.
- `orderLineCount` and `buyerEmail` were added on 13 Nov 2026. Older events,
  including SO4447's, don't have them, and they're never rewritten.
- `tradeMePurchaseId` is filled only for an **unambiguous single-purchase
  order**: the order has exactly one line in total (lines refunded or removed
  to zero still count, so an order that started with several lines stays
  ambiguous) and the sales record ID is `P` + digits. It's then the digits,
  e.g. `P252876776` → `252876776`. That format was confirmed against 4,547
  local purchases. In every other case it's `null`. Multi-line orders such as
  SO4447 are always `null`, because Omnivore stores one reference per order,
  not per line. The local app resolves those through the `C…` cart ID: it
  checks the buyer, the purchase count and the quantities against its own
  purchases for that Trade Me OrderId.
- A Shopify order event whose `tradeMePurchaseId` is `null` must leave local
  packed statuses unchanged.

**Before a package is recorded**, Pack Check checks it against the latest
data:
- every Trade Me purchase must still be in the latest sync, in the same
  parcel (`groupKey`), with the same quantity, and not already packed;
- no new pickable item may have joined that parcel since the page loaded;
- every Shopify order must still be open, uncancelled and unfulfilled, with
  the same lines and quantities.

Otherwise nothing is recorded, and the packer is told to Refresh. Each
refusal carries a `code`:
- `already_packed`: Pack Check has already recorded it as packed. This is
  checked first, so an item that was packed and then dropped from the next
  sync isn't reported as a problem. If that's the only reason, Pack Check
  refreshes itself (keeping scans) and says so, so the packer doesn't have
  to.
- `not_in_latest_sync`: missing from the latest sync. Central doesn't know
  why (it may have been packed in the local app, or no longer be ready), so
  it doesn't guess.
- `moved_parcel`, `quantity_changed`, `new_item`: the parcel changed.
- `not_found`, `cancelled`, `fulfilled`, `order_changed`: the Shopify order
  changed.

**Trade Me sales channel.** A Shopify order counts as Trade Me only when both
of these hold:
- it was created by an app listed in `TRADEME_SHOPIFY_CHANNEL_APP_ID` on the
  Fly app (comma-separated GIDs). The order diagnostic confirmed Omnivore,
  `gid://shopify/App/1203668`;
- it has the `trademe` tag, because it isn't established that Omnivore
  handles only Trade Me.

Order names are never used. While the setting is unset,
`tradeMeChannelConfigured` is `false` and no Shopify orders are reported.

**Packed Shopify orders are never missed.** Every packed Shopify order starts
as *pending*. At the start of each read, before events are returned, Pack
Check looks up the pending orders in Shopify and reports each Trade Me one as
a `shopify_order` event, using the rules above. Website and other orders get
no event. This includes orders packed before the channel was configured: they
appear, with their original pack time in `occurredAt`, on the first read after
it's set. Each pack is reported once. Events are never rewritten; a new fact
is always a new `eventId`.

The response includes `shopifyOrdersPendingReport`: how many packed Shopify
orders are still waiting. It's non-zero while the channel is unset, or if
Shopify couldn't be reached during this read; in that case
`shopifyReportError` explains, and a later read reports them. Up to 250
pending orders are processed per read.

**Order diagnostic.** In the Shopify app, open **Order diagnostic** and
look up one order. It's read-only and admin-only. It shows the order's
creating app, sales channel, source fields, tags, note, custom attributes,
metafields and each line's custom attributes, which is where a Trade Me
purchase or listing reference could be. Customer name, email, phone and
address are never fetched, and emails and phone numbers in free text are
redacted.

**Legacy fields** (kept for existing clients; `?since=<ISO>` filters them):
- `packed`: Trade Me purchases recorded as packed.
- `packedShopifyOrders`: packed Shopify orders from the confirmed Trade Me
  channel only.

Both are now kept indefinitely; there's no 30-day expiry. New clients should
use `events` instead.

## Example client (Node 18+)

```js
const BASE = "https://bulk-photo-match2.fly.dev";
const headers = { Authorization: `Bearer ${process.env.TRADEME_SYNC_SECRET}`, "Content-Type": "application/json" };

export async function pushJobs(jobs) {
  const body = jobs.length ? { jobs } : { jobs: [], allowEmpty: true };
  const res = await fetch(`${BASE}/api/trademe-sync`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`push failed ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchPacked(since) {
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  const res = await fetch(`${BASE}/api/trademe-sync${q}`, { headers });
  if (!res.ok) throw new Error(`read failed ${res.status}: ${await res.text()}`);
  return (await res.json()).packed;
}
```

Only call `pushJobs([])` after a successful read that really found nothing
ready. If the read fails, skip the push.

## In Pack Check

Trade Me jobs only appear when the **"Clearance week"** toggle in the top
bar is on. It's off by default, because Trade Me sales may also reach Shopify as
orders through the Trade Me sales channel and would then show twice.
A package is recorded as packed when every item is scanned and you press
**Space**, **Next Order** or the **📦 Packed — Next Order →** button. A package
that isn't fully scanned is skipped without being recorded. Recording never
touches Shopify. If recording fails, Pack Check stays on the package and shows
an error.

### Combining with Shopify orders

Shopify orders are still grouped by customer name, as before. A Trade Me job
joins a buyer's Shopify group (shown as "+ Trade Me" in the order list) only
when **all** of these hold:

- the job's `buyerEmail` matches, ignoring case and spaces, and every Shopify
  order in the group with an email has that same email;
- every Shopify order in the group with an address has the same house
  number, street name and postcode as the job's `deliveryAddress`. Formatting
  doesn't matter: case, punctuation, line breaks, "Rd"/"Road" and similar
  street-type abbreviations, "Flat 2, 12" vs "2/12", and "12A" vs "12 A";
- exactly one Shopify group matches the job, and no other job matches that group.

Otherwise the job stays a separate package. A name match alone never merges,
and a different house number, street name, street type (Road vs Street) or
postcode keeps them apart.

In a combined package:

- Shopify lines and Trade Me lines are each their own source. Identical SKUs
  from separate purchases add up in quantity; nothing is de-duplicated by SKU
  or title.
- Order value and shipping are shown per source ("Shopify orders" and "Trade
  Me package") and never added together. The $0-shipping warning only shows
  when both sources have $0 shipping.
- Finishing the package records it as packed: the Shopify orders shown in it
  and only the Trade Me purchase IDs shown in it. Nothing is fulfilled in
  Shopify.

Items with a blank SKU or a `TV|…` reference are not shown as pickable cards.

### Proposed, not yet implemented: `shippingStatus`

An optional job field, `"shippingStatus": "paid" | "manually_approved" |
"unpaid"`. When it's `manually_approved`, Pack Check would show "Shipping
approved manually" in place of the $0 warning, without inventing an amount.
Agree it here before either app sends or reads it.

## Prepacking (contract v1)

Anything won can be **packed**, paid or not. Whether a package may be
**sent** is shown separately and never changes because something was scanned.
Pack Check never fulfils, buys labels or dispatches.

**Version handshake.** `GET /api/trademe-sync` and the POST response return
`"prepackingContractVersion": 1`. Send the same field in the POST body to use
v1; any other value gets a 400. Older clients that omit it keep working:
their jobs show with clearance not reported.

**v1 job fields** (all existing fields unchanged):
- `paymentStatus`: e.g. `paid`, `partially_paid`, `not_paid`, `unknown`.
- `shippingStatus`: e.g. `correct`, `manually_approved`, `missing`,
  `underpaid`, `overpaid`, `refunded`.
- `dispatchClearance`: `"cleared"` or `"blocked"`. Absent means unknown,
  which is never treated as cleared.
- `dispatchBlockers`: blocker codes, e.g. `payment_not_confirmed`,
  `shipping_not_cleared`, `hold_or_unknown`, `cancelled_or_unknown`,
  `dispatched_or_unknown`.

These are stored and refreshed on every full snapshot. Any `kanbanCol` is
accepted. Items may be sent with `packed: true` as parcel metadata, but
`packed` is only a mirror. Pack Check's own packed records alone decide what's
packed, so stale metadata can't hide an item that was undone in Pack Check.

**Send status** shown in Pack Check, on the package being packed, in the order
list and in the Packed view:
- **Cleared after packing**: every source in the package is cleared. For
  Trade Me, `dispatchClearance` is `cleared` with no blockers. For Shopify,
  the order is paid (`PAID` or `PARTIALLY_REFUNDED`).
- **Prepack — payment outstanding**: Trade Me payment isn't confirmed, or
  the Shopify order is pending, authorised or partly paid.
- **Shipping not cleared**.
- **Do not send — blocked**: a hold, cancellation, refund, dispatch, or an
  unknown blocker code.
- **Send status unknown**: not reported, or the parcel is no longer in the
  latest sync.

The worst source wins. A paid Shopify order never clears unpaid Trade Me
items in the same package, or vice versa. When the local app reports a Trade
Me shipping status, it overrides the dollar amount in Pack Check's shipping
box: `manually_approved` with $0 shows as approved, and `missing` shows as not
cleared even if an amount was paid.

**New wins after prepacking.** Only the new items appear to scan; the banner
says how many are already packed. The Packed view shows "N new items still to
pack — don't send yet" until they're packed.

**Unpaid Shopify orders** (pending payment) now appear in To pack, marked
"💳 prepack", so they can be prepacked too.

## Adding to a bag that's already packed

Each recorded package belongs to a **bag** (`PackedPackage.bagId`, shown as
e.g. `BAG-3K2ABC`). While packing, Pack Check checks the package against the
bags packed and waiting to be sent (last 14 days):
- **Same Trade Me parcel (`groupKey`)**: "➕ Add to existing bag BAG-…",
  with the bag's packed date and contents. It's filed into that bag
  automatically.
- **Different parcel or order, same buyer** (same email or Trade Me username;
  never a name alone) **and a compatible delivery address**: "📦 This buyer
  already has a packed bag". It's only filed into it if the packer clicks
  **Add to BAG-…**; otherwise it's a separate bag.
- **Same buyer but the address differs or can't be checked**: a warning, and
  it's packed as a separate bag.
- **The matching bag is on hold, blocked, cancelled, of unknown status (e.g.
  dispatched), or there's more than one candidate**: a warning, never a
  combine suggestion.

The order list marks these packages "➕ Add to existing bag", "➕? existing
bag" or "❔ bag". The Packed view shows each bag as one card: its code,
when it was first packed and added to, every package's contents with its own
Undo, and one verdict. That verdict is "🚫 Don't send yet" until nothing is
left to pack, no same-buyer items are waiting in another parcel, and payment
and shipping are cleared. Only then does it say "✅ OK to send".
