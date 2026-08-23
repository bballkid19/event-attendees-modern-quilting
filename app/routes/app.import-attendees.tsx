// app/routes/app.import-attendees.tsx
//
// A page inside the embedded app (reached at /app/import-attendees) that lets
// you paste or upload a CSV of attendees and create one saved
// "event_registration" per row — the same kind of record the live webhook
// creates for real orders. Useful for backfilling attendees from before the
// app went live, or adding walk-in / manually-taken registrations.
//
// CSV columns (header row required, case-insensitive):
//   Product   — optional. Exact product title. If left blank, the row uses
//               whichever event you pick from the "Default event" dropdown.
//   Date      — required. The event date/session, e.g. "Aug 15 2026 10:00 AM".
//   Name      — required. Attendee's name.
//   Email     — optional.
//   Quantity  — optional, defaults to 1.
//   Order     — optional label (e.g. an order number), defaults to "Manual import".

import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, Form } from "react-router";
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

// ---------- Shared helpers ----------
async function getEventProducts(admin: any): Promise<EventProduct[]> {
  const products: EventProduct[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const res = await admin.graphql(
      `#graphql
      query($after: String) {
        products(first: 100, after: $after, query: "metafield_key:custom.event_dates") {
          pageInfo { hasNextPage endCursor }
          nodes { id title }
        }
      }`,
      { variables: { after } },
    );
    const body = await res.json();
    const conn = body?.data?.products;
    if (!conn) break;
    conn.nodes.forEach((n: any) => products.push({ id: n.id, title: n.title }));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages += 1;
  } while (after && pages < 10);
  return products;
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

// ---------- Loader: list of event products for the dropdown ----------
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const products = await getEventProducts(admin);
  return { products };
};

// ---------- Action: parse the CSV and create registrations ----------
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const csvText = String(formData.get("csvText") || "");
  const defaultProductId = String(formData.get("defaultProductId") || "");

  const products = await getEventProducts(admin);
  const byTitle = new Map(products.map((p) => [p.title.toLowerCase(), p.id]));

  const rows = parseCsv(csvText);
  let created = 0;
  const skipped: { row: number; reason: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = r.name || "";
    const productTitle = r.product || "";
    const productId = productTitle ? byTitle.get(productTitle.toLowerCase()) : defaultProductId;

    if (!productId) {
      skipped.push({ row: i + 2, reason: productTitle ? `Unknown product "${productTitle}"` : "No product selected" });
      continue;
    }
    if (!name) {
      skipped.push({ row: i + 2, reason: "Missing name" });
      continue;
    }
    if (!r.date) {
      skipped.push({ row: i + 2, reason: "Missing date" });
      continue;
    }

    const err = await saveRegistration(admin, {
      event_product: productId,
      event_date: r.date,
      attendee_name: name,
      attendee_email: r.email || "",
      quantity: r.quantity || "1",
      order_name: r.order || "Manual import",
      ordered_at: new Date().toISOString(),
    });

    if (err) {
      skipped.push({ row: i + 2, reason: err });
    } else {
      created += 1;
    }
  }

  return { created, skipped, total: rows.length };
};

// ---------- Page ----------
export default function ImportAttendees() {
  const { products } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [csvText, setCsvText] = useState("");
  const isSubmitting = navigation.state === "submitting";

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ""));
    reader.readAsText(file);
  }

  return (
    <s-page heading="Import Attendees">
      <s-section heading="1. Choose a default event">
        <s-paragraph>
          Used for any CSV row that doesn't include a "Product" column.
        </s-paragraph>
        <select
          form="import-form"
          name="defaultProductId"
          style={{ padding: "8px", borderRadius: "6px", width: "100%", maxWidth: "420px" }}
        >
          <option value="">— Select an event product —</option>
          {products.map((p: EventProduct) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </s-section>

      <s-section heading="2. Upload or paste your CSV">
        <s-paragraph>
          Columns (header row required): <strong>Product, Date, Name, Email, Quantity, Order</strong>.
          Product and Order are optional. Name and Date are required per row.
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
        <Form method="post" id="import-form">
          <input type="hidden" name="csvText" value={csvText} />
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

      {actionData ? (
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
