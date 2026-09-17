// app/routes/app.import-attendees.tsx
//
// A page inside the embedded app (reached at /app/import-attendees) that lets
// you paste or upload a CSV of attendees and create one saved
// "event_registration" per row — the same kind of record the live webhook
// creates for real orders.
//
// Date handling follows the store's Event Registration Mode:
//
//   - registration_mode == "separate_registration": the product's real
//     variants ARE its dates — show the variant list, require one choice.
//
//   - registration_mode == "single_registration" with only the Default
//     Title variant: this is ONE registration covering every meeting in
//     the series (e.g. "Beginning Quilting with Nancy at Night" — six
//     dates, one purchase). No date selector is shown; the complete,
//     unmodified Event Dates metafield value is stored as the attendee's
//     event_date, exactly as written (including its [bracket] grouping).
//
//   - registration_mode == "single_registration" with real Session/Class
//     Package variants: show the package list (each variant is a whole
//     package), never split a package into its individual meeting dates.
//
//   - No registration_mode set at all (older/simpler products): falls
//     back to the original behavior — use real variants if present,
//     otherwise parse individual dates out of the Event Dates metafield
//     text. This keeps older products (like "Test Quilting Class") working
//     exactly as before.
//
// Two CSV shapes are understood automatically: a simple sheet with
// Product, Date, Name, Email, Quantity, Order columns, or a direct RainPOS
// class export (Transaction ID, Last Name, First Name, Attendees, Email,
// Phone, Cell, Seats, Price…), where "Attendees" like "Jane Doe; Sue Doe;"
// becomes two separate registrations.

import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useFetcher, useNavigation, Form } from "react-router";
import { authenticate } from "../shopify.server";

type EventProduct = { id: string; title: string };
type DateOption = { id: string; title: string };

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

// Parses individual dates out of a metafield text blob by scanning for
// MM/DD/YYYY (with optional time) patterns. Only used as a last-resort
// fallback for older products with no registration_mode set at all.
function parseIndividualDates(raw: string): string[] {
  if (!raw) return [];
  const matches = raw.match(/\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*[AaPp][Mm])?/g);
  if (matches && matches.length) return matches.map((m) => m.trim());
  return [raw.trim()];
}

// Figures out what date options (if any) to present for a product,
// following the store's Event Registration Mode rules. Returns:
//   - options: the list of choosable dates/packages (empty if none needed)
//   - autoDate: a date to use automatically with no selector shown
//     (the whole-series case), or null if a choice is required/available
async function getDateOptions(
  admin: any,
  productId: string,
): Promise<{ options: DateOption[]; autoDate: string | null }> {
  const res = await admin.graphql(
    `#graphql
    query($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          nodes { id title }
        }
        registrationMode: metafield(namespace: "custom", key: "event_registration_mode") { value }
        eventDates: metafield(namespace: "custom", key: "event_dates") { value }
      }
    }`,
    { variables: { id: productId } },
  );
  const body = await res.json();
  const product = body?.data?.product;
  const variantNodes = product?.variants?.nodes || [];
  const realVariants = variantNodes.filter((v: any) => v.title && v.title !== "Default Title");
  const mode = (product?.registrationMode?.value || "").toLowerCase();
  const rawDates = product?.eventDates?.value || "";

  if (mode === "single_registration") {
    if (realVariants.length) {
      // Multiple whole packages — show them as options, never split.
      return {
        options: realVariants.map((v: any) => ({ id: v.id, title: v.title })),
        autoDate: null,
      };
    }
    // One registration covers the entire series. No choice to make —
    // preserve the complete Event Dates value exactly as written.
    return { options: [], autoDate: rawDates || null };
  }

  if (mode === "separate_registration") {
    return {
      options: realVariants.map((v: any) => ({ id: v.id, title: v.title })),
      autoDate: null,
    };
  }

  // No registration_mode set — fall back to the original behavior for
  // older/simpler products: real variants if present, else split the
  // metafield text into individual selectable dates.
  if (realVariants.length) {
    return {
      options: realVariants.map((v: any) => ({ id: v.id, title: v.title })),
      autoDate: null,
    };
  }
  const parsed = parseIndividualDates(rawDates);
  return {
    options: parsed.map((title, i) => ({ id: `metafield-${i}`, title })),
    autoDate: null,
  };
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

async function loadExistingKeys(admin: any, productId: string): Promise<Set<string>> {
  const keys = new Set<string>();
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
      const m: Record<string, string> = {};
      (n.fields || []).forEach((f: any) => (m[f.key] = f.value));
      if (m.event_product === productId) {
        keys.add(`${m.event_date}|||${(m.attendee_name || "").toLowerCase()}`);
      }
    });
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages += 1;
  } while (after && pages < 30);
  return keys;
}

// ---------- Loader ----------
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

// ---------- Combined action: product search, date lookup, and CSV import ----------
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "search") {
    const term = String(formData.get("term") || "");
    const products = await searchProducts(admin, term);
    return { intent: "search", products };
  }

  if (intent === "dates") {
    const productId = String(formData.get("productId") || "");
    const result = productId
      ? await getDateOptions(admin, productId)
      : { options: [], autoDate: null };
    return { intent: "dates", ...result };
  }

  // --- CSV import ---
  const csvText = String(formData.get("csvText") || "");
  const defaultProductId = String(formData.get("defaultProductId") || "");
  const defaultDate = String(formData.get("defaultDate") || "");

  const rows = parseCsv(csvText);
  let created = 0;
  let duplicates = 0;
  const skipped: { row: number; reason: string }[] = [];
  const titleCache = new Map<string, string | null>();
  const existingKeysCache = new Map<string, Set<string>>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

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

    if (!existingKeysCache.has(productId)) {
      existingKeysCache.set(productId, await loadExistingKeys(admin, productId));
    }
    const existingKeys = existingKeysCache.get(productId)!;

    const email = r.email || "";
    const order = r["transaction id"] || r.order || "Manual import";
    const perNameQuantity = names.length > 1 ? "1" : r.quantity || r.seats || "1";

    for (const name of names) {
      const dupeKey = `${date}|||${name.toLowerCase()}`;
      if (existingKeys.has(dupeKey)) {
        duplicates += 1;
        continue;
      }

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
        existingKeys.add(dupeKey);
        created += 1;
      }
    }
  }

  return { intent: "import", created, duplicates, skipped, total: rows.length };
};

// ---------- Page ----------
export default function ImportAttendees() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const searchFetcher = useFetcher<typeof action>();
  const dateFetcher = useFetcher<typeof action>();

  const [csvText, setCsvText] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<EventProduct | null>(null);
  const [selectedDate, setSelectedDate] = useState("");

  const isSubmitting = navigation.state === "submitting";
  const searchResults: EventProduct[] =
    searchFetcher.data && searchFetcher.data.intent === "search" ? searchFetcher.data.products : [];

  const dateData = dateFetcher.data && dateFetcher.data.intent === "dates" ? dateFetcher.data : null;
  const dateOptions: DateOption[] = dateData?.options || [];
  const autoDate: string | null = dateData?.autoDate || null;
  const loadingDates = dateFetcher.state !== "idle";

  function runSearch(term: string) {
    setSearchTerm(term);
    setSelectedProduct(null);
    setSelectedDate("");
    if (term.trim().length < 2) return;
    const fd = new FormData();
    fd.set("intent", "search");
    fd.set("term", term);
    searchFetcher.submit(fd, { method: "post" });
  }

  function pickProduct(p: EventProduct) {
    setSelectedProduct(p);
    setSearchTerm(p.title);
    setSelectedDate("");
    const fd = new FormData();
    fd.set("intent", "dates");
    fd.set("productId", p.id);
    dateFetcher.submit(fd, { method: "post" });
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ""));
    reader.readAsText(file);
  }

  const effectiveDate = autoDate || selectedDate;

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
            <button
              type="button"
              onClick={() => {
                setSelectedProduct(null);
                setSearchTerm("");
                setSelectedDate("");
              }}
            >
              Change
            </button>
          </p>
        ) : searchResults.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, marginTop: "10px", maxWidth: "420px" }}>
            {searchResults.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => pickProduct(p)}
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
        <s-section heading="2. Date">
          {loadingDates ? (
            <p>Checking this event's registration type…</p>
          ) : autoDate ? (
            <>
              <s-paragraph>
                This is a single registration covering the whole series — no date to choose.
                Every row will be attached to:
              </s-paragraph>
              <p style={{ fontFamily: "monospace", fontSize: "13px", background: "#f5f5f5", padding: "8px", borderRadius: "6px" }}>
                {autoDate}
              </p>
            </>
          ) : dateOptions.length ? (
            <>
              <s-paragraph>
                Used for every row unless a row's CSV has its own "Date" column.
              </s-paragraph>
              <select
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{ padding: "8px", borderRadius: "6px", width: "100%", maxWidth: "420px" }}
              >
                <option value="">— Select a date —</option>
                {dateOptions.map((d) => (
                  <option key={d.id} value={d.title}>
                    {d.title}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <p style={{ color: "#666" }}>
              Couldn't find any dates for this event — check its variants or Event Dates metafield.
            </p>
          )}
        </s-section>
      ) : null}

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
          <input type="hidden" name="defaultDate" value={effectiveDate} />
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
            {actionData.duplicates > 0 ? (
              <> Skipped <strong>{actionData.duplicates}</strong> already on the list.</>
            ) : null}
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
