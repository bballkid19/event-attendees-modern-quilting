// app/routes/app.export-attendees.tsx
//
// A page inside the embedded app (reached at /app/export-attendees) that
// lets you search for an event and download its full attendee list as a
// CSV file. Built as its own normal app page — not inside the Print
// preview pane — because preview panes commonly block link clicks and
// file downloads from working at all.
//
// The CSV is built by this page's own logged-in request and then saved by the
// browser. A plain <a href> download link can't work here: it makes a request
// with no Shopify login attached, so the app answers with an empty
// login-redirect page and the browser saves THAT as a blank .html file.

import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";

type EventProduct = { id: string; title: string };

async function searchProducts(admin: any, term: string): Promise<EventProduct[]> {
  const cleanTerm = term.trim();
  if (!cleanTerm) return [];
  const res = await admin.graphql(
    `#graphql
    query($query: String!) {
      products(first: 20, query: $query) {
        nodes { id title }
      }
    }`,
    { variables: { query: `title:*${cleanTerm}*` } },
  );
  const body = await res.json();
  const nodes = body?.data?.products?.nodes || [];
  return nodes.map((n: any) => ({ id: n.id, title: n.title }));
}

function csvEscape(s: string) {
  const v = String(s ?? "");
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// Sort key so dates list in real calendar order (also across years).
function dateKey(label: string): number {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?/.exec(label || "");
  if (!m) return Number.MAX_SAFE_INTEGER;
  let hour = m[4] ? parseInt(m[4], 10) % 12 : 0;
  if (m[6] && m[6].toLowerCase() === "pm") hour += 12;
  return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10), hour, m[5] ? parseInt(m[5], 10) : 0).getTime();
}

async function buildCsv(admin: any, productId: string): Promise<{ csv: string; filename: string; count: number }> {
  let productTitle = "";
  try {
    const res = await admin.graphql(
      `#graphql
      query($id: ID!) { product(id: $id) { title } }`,
      { variables: { id: productId } },
    );
    const body = await res.json();
    productTitle = body?.data?.product?.title || "";
  } catch {
    // Non-fatal — the file just gets a generic name.
  }

  const rows: Record<string, string>[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const res: any = await admin.graphql(
      `#graphql
      query($after: String) {
        metaobjects(type: "event_registration", first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { fields { key value } }
        }
      }`,
      { variables: { after } },
    );
    const body: any = await res.json();
    const conn = body?.data?.metaobjects;
    if (!conn) break;
    conn.nodes.forEach((n: any) => {
      const m: Record<string, string> = {};
      (n.fields || []).forEach((f: any) => (m[f.key] = f.value));
      if (m.event_product === productId) rows.push(m);
    });
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages += 1;
  } while (after && pages < 40);

  rows.sort((a, b) => {
    const d = dateKey(a.event_date) - dateKey(b.event_date);
    if (d !== 0) return d;
    const byDateText = (a.event_date || "").localeCompare(b.event_date || "");
    if (byDateText !== 0) return byDateText;
    return (a.attendee_name || "").localeCompare(b.attendee_name || "");
  });

  const header = ["Date", "Name", "Email", "Quantity", "Order", "Registered On"];
  const lines = [header.map(csvEscape).join(",")];
  rows.forEach((p) => {
    lines.push(
      [p.event_date || "Event", p.attendee_name || "", p.attendee_email || "", p.quantity || "1", p.order_name || "", p.ordered_at || ""]
        .map(csvEscape)
        .join(","),
    );
  });

  const safe = (productTitle || "attendees").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  // The leading BOM makes Excel read accented characters correctly.
  return { csv: "\uFEFF" + lines.join("\r\n"), filename: `${safe || "attendees"}-attendees.csv`, count: rows.length };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "search");

  if (intent === "csv") {
    const productId = String(formData.get("productId") || "");
    const result = await buildCsv(admin, productId);
    return { intent: "csv" as const, ...result };
  }

  const term = String(formData.get("term") || "");
  const products = await searchProducts(admin, term);
  return { intent: "search" as const, products };
};

export default function ExportAttendees() {
  const searchFetcher = useFetcher<typeof action>();
  const csvFetcher = useFetcher<typeof action>();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<EventProduct | null>(null);
  const [lastDownload, setLastDownload] = useState<{ filename: string; count: number } | null>(null);
  const handledCsv = useRef<unknown>(null);

  const searchData = searchFetcher.data;
  const searchResults: EventProduct[] = searchData && "products" in searchData ? searchData.products : [];
  const downloading = csvFetcher.state !== "idle";

  // When the logged-in request returns the CSV text, hand it to the browser
  // as a file download.
  useEffect(() => {
    const data = csvFetcher.data;
    if (!data || !("csv" in data) || handledCsv.current === data) return;
    handledCsv.current = data;
    const blob = new Blob([data.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setLastDownload({ filename: data.filename, count: data.count });
  }, [csvFetcher.data]);

  function downloadCsv() {
    if (!selectedProduct) return;
    setLastDownload(null);
    const fd = new FormData();
    fd.set("intent", "csv");
    fd.set("productId", selectedProduct.id);
    csvFetcher.submit(fd, { method: "post" });
  }

  function runSearch(term: string) {
    setSearchTerm(term);
    setSelectedProduct(null);
    if (term.trim().length < 2) return;
    const fd = new FormData();
    fd.set("intent", "search");
    fd.set("term", term);
    searchFetcher.submit(fd, { method: "post" });
  }

  return (
    <s-page heading="Export Attendees">
      <s-section heading="1. Find the event">
        <s-paragraph>Search by product name to find its full attendee list.</s-paragraph>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => runSearch(e.target.value)}
          placeholder="Start typing a product name…"
          style={{ padding: "8px", borderRadius: "6px", width: "100%", maxWidth: "420px" }}
        />

        {selectedProduct ? (
          <p style={{ marginTop: "10px" }}>
            Selected: <strong>{selectedProduct.title}</strong>{" "}
            <button type="button" onClick={() => { setSelectedProduct(null); setSearchTerm(""); }}>
              Change
            </button>
          </p>
        ) : searchResults.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, marginTop: "10px", maxWidth: "420px" }}>
            {searchResults.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => { setSelectedProduct(p); setSearchTerm(p.title); }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 10px",
                    border: "1px solid #ddd",
                    borderRadius: "6px",
                    marginBottom: "4px",
                    background: "#fff",
                    cursor: "pointer",
                  }}
                >
                  {p.title}
                </button>
              </li>
            ))}
          </ul>
        ) : searchTerm.trim().length >= 2 && searchFetcher.state === "idle" ? (
          <p style={{ marginTop: "10px", color: "#666" }}>No matching products found.</p>
        ) : null}
      </s-section>

      {selectedProduct ? (
        <s-section heading="2. Download">
          <s-paragraph>
            Includes every date and every attendee saved for this event — name, email, quantity, order, and
            registration date.
          </s-paragraph>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={downloading}
            style={{
              display: "inline-block",
              padding: "10px 20px",
              borderRadius: "8px",
              border: "none",
              background: "#3e9891",
              color: "#fff",
              fontWeight: 700,
              cursor: downloading ? "default" : "pointer",
              opacity: downloading ? 0.7 : 1,
            }}
          >
            {downloading ? "Preparing…" : "⬇ Download CSV"}
          </button>
          {lastDownload ? (
            <p style={{ marginTop: "10px", color: "#3e9891" }}>
              {lastDownload.count === 0
                ? "No attendees are saved for this event yet, so the file only has the column headings."
                : `Downloaded ${lastDownload.filename} (${lastDownload.count} ${lastDownload.count === 1 ? "row" : "rows"}). Check your Downloads folder.`}
            </p>
          ) : null}
        </s-section>
      ) : null}
    </s-page>
  );
}
