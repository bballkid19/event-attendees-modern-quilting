// app/routes/app.import-attendees.tsx
//
// A page inside the embedded app (reached at /app/import-attendees) that lets
// you paste or upload a CSV of attendees and create one saved
// "event_registration" per row — the same kind of record the live webhook
// creates for real orders. Useful for backfilling attendees from before the
// app went live, from a RainPOS export, or adding walk-in registrations.
//
// Product selection is a type-to-search box (like searching products
// anywhere else in Shopify admin) rather than a dropdown, since a full
// product list is unusable on stores with thousands of products.
//
// Two CSV shapes are understood automatically:
//
// 1) Simple format — header row (case-insensitive):
//      Product, Date, Name, Email, Quantity, Order
//    Product and Order are optional per row. Date falls back to the
//    "Default date" field below if a row doesn't have one.
//
// 2) RainPOS export — header row exactly:
//      Transaction ID, Last Name, First Name, Attendees, Email, Phone,
//      Cell, Seats, Price, Transaction Notes, Materials
//    Detected automatically. "Attendees" (e.g. "Nancy Miller; Sue Miller; ")
//    is split on ";" into one registration per named attendee. If it's
//    blank, First + Last Name is used instead. Every row uses the "Default
//    event" and "Default date" fields below, since RainPOS exports don't
//    include a product or date column — the whole file is one class session.

import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useFetcher, useNavigation, Form } from "react-router";
import { authenticate } from "../shopify.server";

type EventProduct = { id: string; title: string };

// ---------- CSV parsing (no external library — handles quoted commas) ----------
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || "").trim();
    });
    return row;
  });
}

// A single CSV row can represent more than one attendee (RainPOS's
// "Attendees" column lists everyone on a multi-seat booking, separated by
// semicolons). This returns the list of names to create registrations for.
function resolveNames(row: Record<string, string>): string[] {
  if (row.attendees) {
    const names = row.attendees
      .split(";")
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length) return names;
  }
  if (row.name) return [row.name];
  const combined = [row["first name"], row["last name"]].filter(Boolean).join(" ").trim();
  if (combined) return [combined];
  return [];
}

// ---------- Shared helpers ----------

// Search products by title. No tag/metafield filtering — works for any
// store regardless of how many products it has.
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

// Look up a single product's GID by exact title match — used when a CSV
// row specifies its own "Product" column.
async function findProductByTitle(admin: any, title: string): Promise<string | null> {
  const res = await admin.graphql(
    `#graphql
    query($query: String!) {
      products(first: 5, query: $query) {
        nodes { id title }
      }
    }`,
    { variables: { query: `title:'${title.replace(/'/g, "\\'")}'` } },
  );
  const body = await res.json();
  const nodes = body?.data?.products?.nodes || [];
  const exact = nodes.find((n: any) => n.title.toLowerCase() === title.toLowerCase());
  return (exact || nodes[0])?.id || null;
}

async function saveRegistration(admin: any, fields: Record<string, string>) {
  const res = await admin.graphql(
    `#graphql
    mutation Create($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        metaobject: {
          type: "event_registration",
          fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
        },
      },
    },
  );
  const body = await res.json();
  const errs = body?.data?.metaobjectCreate?.userErrors;
  return errs && errs.length ? errs[0].message : null;
}

// ---------- Loader ----------
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

// ---------- Combined action: handles both product search and CSV import ----------
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  // --- Product search (called live as the person types) ---
  if (intent === "search") {
    const term = String(formData.get("term") || "");
    const products = await searchProducts(admin, term);
    return { intent: "search", products };
  }

  // --- CSV import ---
  const csvText = String(formData.get("csvText") || "");
  const defaultProductId = String(formData.get("defaultProductId") || "");
  const defaultDate = String(formData.get("defaultDate") || "");

  const rows = parseCsv(csvText);
  let created = 0;
  const skipped: { row: number; reason: string }[] = [];
  const titleCache = new Map<string, string | null>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    // Resolve the product for this row.
    let productId: string | null = defaultProductId || null;
    const productTitle = r.product || "";
    if (productTitle) {
      const key = productTitle.toLowerCase();
      if (!titleCache.has(key)) {
        titleCache.set(key, await findProductByTitle(admin, productTitle));
      }
      productId = titleCache.get(key) || null;
    }

    if (!productId) {
      skipped.push({
        row: i + 2,
        reason: productTitle ? `Couldn't find product "${productTitle}"` : "No event selected",
      });
      continue;
    }

    const date = r.date || defaultDate;
    if (!date) {
      skipped.push({ row: i + 2, reason: "Missing date" });
      continue;
    }

    const names = resolveNames(r);
    if (!names.length) {
      skipped.push({ row: i + 2, reason: "Missing name" });
      continue;
    }

    const email = r.email || "";
    const order = r["transaction id"] || r.order || "Manual import";
    // If the row lists multiple named attendees (RainPOS's "Attendees"
    // column), each is its own registration of quantity 1. Otherwise use
    // the row's own quantity/seats value for a single combined name.
    const perNameQuantity = names.length > 1 ? "1" : r.quantity || r.seats || "1";

    for (const name of names) {
      const err = await saveRegistration(admin, {
        event_product: productId,
        event_date: date,
        attendee_name: name,
        attendee_email: email,
        quantity: perNameQuantity,
        order_name: order,
        ordered_at: new Date().toISOString(),
      });

      if (err) {
        skipped.push({ row: i + 2, reason: err });
      } else {
        created += 1;
      }
    }
  }

  return { intent: "import", created, skipped, total: rows.length };
};

// ---------- Page ----------
export default function ImportAttendees() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const searchFetcher = useFetcher<typeof action>();

  const [csvText, setCsvText] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<EventProduct | null>(null);
  const [defaultDate, setDefaultDate] = useState("");

  const isSubmitting = navigation.state === "submitting";
  const searchResults: EventProduct[] =
    searchFetcher.data && searchFetcher.data.intent === "search" ? searchFetcher.data.products : [];

  function runSearch(term: string) {
    setSearchTerm(term);
    setSelectedProduct(null);
    if (term.trim().length < 2) return;
    const fd = new FormData();
    fd.set("intent", "search");
    fd.set("term", term);
    searchFetcher.submit(fd, { method: "post" });
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ""));
    reader.readAsText(file);
  }

  return (
    <s-page heading="Import Attendees">
      <s-section heading="1. Find the event">
        <s-paragraph>
          Search by product name. Used for every row unless a row's CSV has its own "Product" column.
        </s-paragraph>
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
                  onClick={() => {
                    setSelectedProduct(p);
                    setSearchTerm(p.title);
                  }}
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

      <s-section heading="2. Set the date">
        <s-paragraph>
          Used for every row unless a row's CSV has its own "Date" column. Match the format your calendar
          uses for this event, e.g. <strong>Aug 15 2026 10:00 AM</strong>.
        </s-paragraph>
        <input
          type="text"
          value={defaultDate}
          onChange={(e) => setDefaultDate(e.target.value)}
          placeholder="Aug 15 2026 10:00 AM"
          style={{ padding: "8px", borderRadius: "6px", width: "100%", maxWidth: "420px" }}
        />
      </s-section>

      <s-section heading="3. Upload or paste your CSV">
        <s-paragraph>
          Two formats work automatically: a simple sheet with <strong>Product, Date, Name, Email,
          Quantity, Order</strong> columns, or a direct RainPOS class export (Transaction ID, Last Name,
          First Name, Attendees, Email, Phone, Cell, Seats, Price…). For a RainPOS export, "Attendees"
          rows like "Jane Doe; Sue Doe;" become two separate registrations.
        </s-paragraph>
        <input type="file" accept=".csv,text/csv" onChange={handleFile} />
        <div style={{ marginTop: "12px" }}>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            rows={10}
            placeholder={"Product,Date,Name,Email,Quantity,Order\nBeginner Quilting,Aug 15 2026 10:00 AM,Jane Doe,jane@example.com,1,#1042"}
            style={{ width: "100%", fontFamily: "monospace", fontSize: "13px", padding: "10px" }}
          />
        </div>
      </s-section>

      <s-section>
        <Form method="post">
          <input type="hidden" name="intent" value="import" />
          <input type="hidden" name="csvText" value={csvText} />
          <input type="hidden" name="defaultProductId" value={selectedProduct?.id || ""} />
          <input type="hidden" name="defaultDate" value={defaultDate} />
          <button
            type="submit"
            disabled={isSubmitting || !csvText.trim()}
            style={{
              padding: "10px 20px",
              borderRadius: "8px",
              background: isSubmitting ? "#aaa" : "#3e9891",
              color: "#fff",
              border: "none",
              fontWeight: 700,
              cursor: isSubmitting ? "default" : "pointer",
            }}
          >
            {isSubmitting ? "Importing…" : "Import attendees"}
          </button>
        </Form>
      </s-section>

      {actionData && actionData.intent === "import" ? (
        <s-section heading="Results">
          <s-paragraph>
            Created <strong>{actionData.created}</strong> of {actionData.total} row(s).
          </s-paragraph>
          {actionData.skipped.length > 0 ? (
            <>
              <s-paragraph>Skipped:</s-paragraph>
              <ul>
                {actionData.skipped.map((s: { row: number; reason: string }, i: number) => (
                  <li key={i}>
                    Row {s.row}: {s.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </s-section>
      ) : null}
    </s-page>
  );
}
