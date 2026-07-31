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
    .map((date) => {
      const people = byDate[date].sort((a, b) =>
        (a.attendee_name || "").localeCompare(b.attendee_name || ""),
      );
      const count = people.reduce((n, p) => n + (parseInt(p.quantity, 10) || 1), 0);
      const trs = people
        .map(
          (p) => `
          <tr>
            <td>${esc(p.attendee_name)}</td>
            <td>${esc(p.attendee_email)}</td>
            <td style="text-align:center">${esc(p.quantity || "1")}</td>
            <td></td>
          </tr>`,
        )
        .join("");
      return `
        <h2>${esc(date)} <span class="count">${count} attending</span></h2>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Qty</th><th>Signature</th></tr></thead>
          <tbody>${trs || `<tr><td colspan="4" class="empty">No attendees yet</td></tr>`}</tbody>
        </table>`;
    })
    .join("");

  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><title>Attendee Sign-in Sheet</title>
  <style>
    body { font-family: -apple-system, Arial, sans-serif; color:#111; margin:24px; }
    h1 { font-size:20px; margin:0 0 4px; }
    h2 { font-size:15px; margin:22px 0 6px; border-bottom:2px solid #111; padding-bottom:4px; }
    .count { float:right; font-weight:normal; color:#555; }
    table { width:100%; border-collapse:collapse; margin-bottom:8px; }
    th, td { border:1px solid #999; padding:7px 9px; font-size:12px; text-align:left; }
    th { background:#f2f2f2; }
    .empty { color:#888; text-align:center; }
    @media print { body { margin:0; } h2 { page-break-after:avoid; } }
  </style></head>
  <body>
    <h1>Attendee Sign-in Sheet</h1>
    ${sections || "<p>No registrations found.</p>"}
  </body></html>`;

  return cors(new Response(html, { headers: { "Content-Type": "text/html" } }));
};