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

## 2. Read back packed items (`GET /api/trademe-sync?since=<ISO date>`)

```json
{ "packed": [ { "purchaseId": "987654321", "groupKey": "buyer-123456", "packedAt": "2026-11-08T03:12:00.000Z" } ] }
```

Mark those purchases packed or dispatched in the local app, then stop
including them in pushes. Pass the newest `packedAt` you've seen as `since`
next time. Records are kept for 30 days.

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
Packing a Trade Me job records its items as packed. It never touches Shopify.

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
- Finishing the package fulfils the Shopify orders as before, and marks packed
  only the Trade Me purchase IDs that were shown in the package.

Items with a blank SKU or a `TV|…` reference are not shown as pickable cards.

### Proposed, not yet implemented: `shippingStatus`

An optional job field, `"shippingStatus": "paid" | "manually_approved" |
"unpaid"`. When it's `manually_approved`, Pack Check would show "Shipping
approved manually" in place of the $0 warning, without inventing an amount.
Agree it here before either app sends or reads it.
