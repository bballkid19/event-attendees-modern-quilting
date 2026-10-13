// app/routes/app.export-attendees.tsx
//
// A page inside the embedded app (reached at /app/export-attendees) that
// lets you search for an event and download its full attendee list as a
// CSV file. Built as its own normal app page — not inside the Print
// preview pane — because preview panes commonly block link clicks and
// file downloads from working at all.

import { useState } from "react";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const term = String(formData.get("term") || "");
  const products = await searchProducts(admin, term);
  return { products };
};

export default function ExportAttendees() {
  const searchFetcher = useFetcher<typeof action>();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<EventProduct | null>(null);

  const searchResults: EventProduct[] = searchFetcher.data?.products || [];

  function runSearch(term: string) {
    setSearchTerm(term);
    setSelectedProduct(null);
    if (term.trim().length < 2) return;
    const fd = new FormData();
    fd.set("term", term);
    searchFetcher.submit(fd, { method: "post" });
  }

  const csvUrl = selectedProduct
    ? `/print/attendees?product=${encodeURIComponent(selectedProduct.id)}&format=csv`
    : "";

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
          <a
            href={csvUrl}
            download
            style={{
              display: "inline-block",
              padding: "10px 20px",
              borderRadius: "8px",
              background: "#3e9891",
              color: "#fff",
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            ⬇ Download CSV
          </a>
        </s-section>
      ) : null}
    </s-page>
  );
}
