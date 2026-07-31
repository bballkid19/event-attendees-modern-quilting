// app/routes/print.attendees.tsx
//
// Returns a print-optimised HTML sign-in sheet for one event product.
// The print action extension points its `src` at /print/attendees?product=<gid>.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

function esc(s: string) {
  return String(s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string),
  );
}

function fieldMap(node: any): Record<string, string> {
  const out: Record<string, string> = {};
  (node.fields || []).forEach((f: any) => (out[f.key] = f.value));
  return out;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, cors } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productGid = url.searchParams.get("product") || "";

  // Store name + the product's own title, so the sheet is self-labeled.
  let shopName = "";
  let productTitle = "";
  try {
    const res = await admin.graphql(
      `#graphql
      query($id: ID!) {
        shop { name }
        product(id: $id) { title }
      }`,
      { variables: { id: productGid } },
    );
    const body = await res.json();
    shopName = body?.data?.shop?.name || "";
    productTitle = body?.data?.product?.title || "";
  } catch {
    // Non-fatal — the sheet still works without these.
  }

  // Pull registrations, filter to this product, group by date.
  const rows: Record<string, string>[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const res = await admin.graphql(
      `#graphql
      query($after: String) {
        metaobjects(type: "event_registration", first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { fields { key value } }
        }
      }`,
      { variables: { after } },
    );
    const body = await res.json();
    const conn = body?.data?.metaobjects;
    if (!conn) break;
    conn.nodes.forEach((n: any) => {
      const m = fieldMap(n);
      if (m.event_product === productGid) rows.push(m);
    });
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages += 1;
  } while (after && pages < 20);

  const byDate: Record<string, Record<string, string>[]> = {};
  rows.forEach((r) => {
    const d = r.event_date || "Event";
    (byDate[d] || (byDate[d] = [])).push(r);
  });

  const sections = Object.keys(byDate)
    .sort()
    .map((date, i) => {
      const people = byDate[date].sort((a, b) =>
        (a.attendee_name || "").localeCompare(b.attendee_name || ""),
      );
      const count = people.reduce((n, p) => n + (parseInt(p.quantity, 10) || 1), 0);
      const trs = people
        .map(
          (p, idx) => `
          <tr>
            <td class="row-num">${idx + 1}</td>
            <td>${esc(p.attendee_name)}</td>
            <td class="muted">${esc(p.attendee_email)}</td>
            <td class="qty">${esc(p.quantity || "1")}</td>
            <td class="sign-cell"></td>
          </tr>`,
        )
        .join("");
      return `
        <section class="date-block"${i > 0 ? ' style="page-break-before: auto;"' : ""}>
          <div class="date-head">
            <h2>${esc(date)}</h2>
            <span class="count-pill">${count} ${count === 1 ? "attendee" : "attendees"}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th class="row-num">#</th>
                <th>Name</th>
                <th>Email</th>
                <th class="qty">Qty</th>
                <th class="sign-cell">Signature</th>
              </tr>
            </thead>
            <tbody>${trs || `<tr><td colspan="5" class="empty">No attendees registered yet</td></tr>`}</tbody>
          </table>
        </section>`;
    })
    .join("");

  const today = new Date().toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const html = `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>${esc(productTitle) || "Attendee"} Sign-in Sheet</title>
    <style>
      :root {
        --ink: #514b43;
        --muted: #8a8177;
        --cream: #f5f1eb;
        --teal: #3e9891;
        --teal-soft: #e8f6f4;
        --clay: #d9784f;
        --rule: rgba(81, 75, 67, 0.16);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        padding: 40px 48px;
        background: #ffffff;
        color: var(--ink);
        font-family: -apple-system, "Segoe UI", Arial, sans-serif;
        font-size: 13px;
        line-height: 1.5;
      }

      .sheet-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 24px;
        padding-bottom: 18px;
        margin-bottom: 28px;
        border-bottom: 3px solid var(--ink);
      }

      .sheet-head h1 {
        margin: 0 0 4px;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--ink);
      }

      .sheet-head .shop-name {
        margin: 0;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--teal);
      }

      .sheet-head .printed-on {
        text-align: right;
        font-size: 11px;
        color: var(--muted);
        white-space: nowrap;
      }

      .date-block {
        margin-bottom: 34px;
      }

      .date-head {
        display: flex;
        align-items: baseline;
        gap: 14px;
        margin-bottom: 10px;
        padding-bottom: 8px;
        border-bottom: 2px dashed var(--rule);
      }

      .date-head h2 {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 17px;
        font-weight: 700;
        color: var(--ink);
      }

      .count-pill {
        display: inline-block;
        padding: 3px 10px;
        border-radius: 999px;
        background: var(--teal-soft);
        color: var(--teal);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      thead th {
        text-align: left;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted);
        padding: 7px 10px;
        border-bottom: 1px solid var(--rule);
      }

      tbody td {
        padding: 10px;
        border-bottom: 1px solid var(--rule);
        vertical-align: middle;
      }

      tbody tr:nth-child(even) {
        background: var(--cream);
      }

      .row-num {
        width: 28px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }

      .qty {
        width: 48px;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }

      .muted {
        color: var(--muted);
      }

      .sign-cell {
        width: 200px;
        border-bottom: 1px solid var(--ink) !important;
      }

      thead .sign-cell {
        border-bottom: 1px solid var(--rule) !important;
      }

      .empty {
        text-align: center;
        padding: 22px 10px;
        color: var(--muted);
        font-style: italic;
      }

      @media print {
        body { padding: 0.4in 0.5in; }
        .date-block { page-break-inside: avoid; }
      }
    </style>
  </head>
  <body>
    <div class="sheet-head">
      <div>
        ${shopName ? `<p class="shop-name">${esc(shopName)}</p>` : ""}
        <h1>${esc(productTitle) || "Attendee Sign-in Sheet"}</h1>
      </div>
      <div class="printed-on">Printed ${esc(today)}</div>
    </div>
    ${sections || `<p class="empty">No registrations found for this event yet.</p>`}
  </body>
  </html>`;

  return cors(new Response(html, { headers: { "Content-Type": "text/html" } }));
};
