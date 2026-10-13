// app/routes/app.manage-attendees.tsx
//
// A normal, full-length app page (no height limit, unlike the product-page
// panel, which Shopify caps and truncates for long lists). Search for an
// event, then see and manage every date and every attendee — Remove, Move,
// and Add all work here too, the same as the panel.
//
// Because this is a plain app page (not a sandboxed admin extension
// iframe), native browser confirm dialogs and <select> dropdowns work
// completely normally here — the workarounds needed in the panel don't
// apply in this context.

import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";

type EventProduct = { id: string; title: string };
type Person = {
  id: string;
  event_product: string;
  event_date: string;
  attendee_name: string;
  attendee_email: string;
  quantity: string;
};
type DateGroup = { date: string; count: number; people: Person[] };
type DateInfo = {
  title: string;
  tracked: boolean;
  inventoryQuantity: number | null;
  inventoryItemId: string | null;
  locationId: string | null;
};

function shortDateLabel(title: string) {
  if (!title.includes("|")) return title;
  const parts = title.split("|").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return title;
  return `${parts[0]} (+${parts.length - 1} more, ${parts.length} sessions)`;
}

function fieldMap(node: any): Person {
  const m: any = { id: node.id };
  (node.fields || []).forEach((f: any) => (m[f.key] = f.value));
  return m;
}

function parseMetafieldDates(raw: string): string[] {
  if (!raw) return [];
  const matches = raw.match(/\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*[AaPp][Mm])?/g);
  if (matches && matches.length) return matches.map((m) => m.trim());
  return [raw.trim()];
}

async function loadEventDates(admin: any, productId: string): Promise<Record<string, DateInfo>> {
  const res = await admin.graphql(
    `#graphql
    query($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          nodes {
            id
            title
            inventoryQuantity
            inventoryItem {
              id
              tracked
              inventoryLevels(first: 1) { nodes { location { id } } }
            }
          }
        }
        metafield(namespace: "custom", key: "event_dates") { value }
      }
    }`,
    { variables: { id: productId } },
  );
  const body = await res.json();
  const product = body?.data?.product;
  const variantNodes = product?.variants?.nodes || [];
  const realVariants = variantNodes.filter((v: any) => v.title && v.title !== "Default Title");

  const map: Record<string, DateInfo> = {};
  if (realVariants.length) {
    realVariants.forEach((v: any) => {
      const tracked = !!v.inventoryItem?.tracked;
      map[v.title.toLowerCase()] = {
        title: v.title,
        tracked,
        inventoryQuantity: v.inventoryQuantity,
        inventoryItemId: tracked ? v.inventoryItem?.id : null,
        locationId: tracked ? v.inventoryItem?.inventoryLevels?.nodes?.[0]?.location?.id || null : null,
      };
    });
    return map;
  }
  const raw = product?.metafield?.value || "";
  parseMetafieldDates(raw).forEach((title) => {
    map[title.toLowerCase()] = { title, tracked: false, inventoryQuantity: null, inventoryItemId: null, locationId: null };
  });
  return map;
}

async function loadAttendees(admin: any, productId: string): Promise<DateGroup[]> {
  const rows: Person[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const res = await admin.graphql(
      `#graphql
      query($after: String) {
        metaobjects(type: "event_registration", first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id fields { key value } }
        }
      }`,
      { variables: { after } },
    );
    const body = await res.json();
    const conn = body?.data?.metaobjects;
    if (!conn) break;
    conn.nodes.forEach((n: any) => {
      const m = fieldMap(n);
      if (m.event_product === productId) rows.push(m);
    });
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages += 1;
  } while (after && pages < 30);

  const byDate: Record<string, Person[]> = {};
  rows.forEach((r) => {
    const d = r.event_date || "Event";
    (byDate[d] || (byDate[d] = [])).push(r);
  });
  return Object.keys(byDate)
    .sort()
    .map((date) => {
      const people = byDate[date].sort((a, b) => (a.attendee_name || "").localeCompare(b.attendee_name || ""));
      const count = people.reduce((n, p) => n + (parseInt(p.quantity, 10) || 1), 0);
      return { date, count, people };
    });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  // The panel's "View full list" link only needs to pass productId; look the
  // event name up here so the page can open straight to that event.
  const productId = new URL(request.url).searchParams.get("productId");
  let initialProduct: { id: string; title: string } | null = null;
  if (productId) {
    try {
      const res = await admin.graphql(
        `#graphql
        query($id: ID!) { product(id: $id) { id title } }`,
        { variables: { id: productId } },
      );
      const body = await res.json();
      const p = body?.data?.product;
      if (p) initialProduct = { id: p.id, title: p.title };
    } catch (e) {
      initialProduct = null;
    }
  }
  return { initialProduct };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "search") {
    const term = String(formData.get("term") || "").trim();
    if (!term) return { intent: "search", products: [] };
    const res = await admin.graphql(
      `#graphql
      query($query: String!) {
        products(first: 20, query: $query) { nodes { id title } }
      }`,
      { variables: { query: `title:*${term}*` } },
    );
    const body = await res.json();
    return { intent: "search", products: (body?.data?.products?.nodes || []) };
  }

  if (intent === "load") {
    const productId = String(formData.get("productId") || "");
    const [groups, dates] = await Promise.all([
      loadAttendees(admin, productId),
      loadEventDates(admin, productId),
    ]);
    return { intent: "load", groups, dates };
  }

  if (intent === "remove") {
    const id = String(formData.get("id") || "");
    const res = await admin.graphql(
      `#graphql
      mutation($id: ID!) {
        metaobjectDelete(id: $id) { deletedId userErrors { field message } }
      }`,
      { variables: { id } },
    );
    const body = await res.json();
    const errs = body?.data?.metaobjectDelete?.userErrors;
    return { intent: "remove", ok: !(errs && errs.length), error: errs?.[0]?.message };
  }

  if (intent === "add") {
    const productId = String(formData.get("productId") || "");
    const date = String(formData.get("date") || "");
    const name = String(formData.get("name") || "");
    const email = String(formData.get("email") || "");
    const quantity = String(formData.get("quantity") || "1");
    const res = await admin.graphql(
      `#graphql
      mutation($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject { id fields { key value } }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metaobject: {
            type: "event_registration",
            fields: [
              { key: "event_product", value: productId },
              { key: "event_date", value: date },
              { key: "attendee_name", value: name },
              { key: "attendee_email", value: email },
              { key: "quantity", value: quantity || "1" },
              { key: "order_name", value: "Added manually" },
              { key: "ordered_at", value: new Date().toISOString() },
            ],
          },
        },
      },
    );
    const body = await res.json();
    const errs = body?.data?.metaobjectCreate?.userErrors;
    return { intent: "add", ok: !(errs && errs.length), error: errs?.[0]?.message };
  }

  if (intent === "move") {
    const id = String(formData.get("id") || "");
    const target = String(formData.get("target") || "");
    const fromItemId = String(formData.get("fromItemId") || "");
    const fromLocationId = String(formData.get("fromLocationId") || "");
    const toItemId = String(formData.get("toItemId") || "");
    const toLocationId = String(formData.get("toLocationId") || "");

    if (fromItemId && fromLocationId && toItemId && toLocationId) {
      const invRes = await admin.graphql(
        `#graphql
        mutation($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) { userErrors { field message } }
        }`,
        {
          variables: {
            input: {
              reason: "correction",
              name: "available",
              changes: [
                { delta: 1, inventoryItemId: fromItemId, locationId: fromLocationId },
                { delta: -1, inventoryItemId: toItemId, locationId: toLocationId },
              ],
            },
          },
        },
      );
      const invBody = await invRes.json();
      const invErrs = invBody?.data?.inventoryAdjustQuantities?.userErrors;
      if (invErrs && invErrs.length) {
        return { intent: "move", ok: false, error: invErrs[0].message };
      }
    }

    const res = await admin.graphql(
      `#graphql
      mutation($id: ID!, $fields: [MetaobjectFieldInput!]!) {
        metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
          metaobject { id }
          userErrors { field message }
        }
      }`,
      { variables: { id, fields: [{ key: "event_date", value: target }] } },
    );
    const body = await res.json();
    const errs = body?.data?.metaobjectUpdate?.userErrors;
    return { intent: "move", ok: !(errs && errs.length), error: errs?.[0]?.message };
  }

  return { intent: "unknown" };
};

export default function ManageAttendees() {
  const searchFetcher = useFetcher<typeof action>();
  const loadFetcher = useFetcher<typeof action>();
  const actionFetcher = useFetcher<typeof action>();
  const [searchParams] = useSearchParams();
  const { initialProduct } = useLoaderData<typeof loader>();

  const [searchTerm, setSearchTerm] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<EventProduct | null>(() => {
    if (initialProduct) return initialProduct;
    const productId = searchParams.get("productId");
    const title = searchParams.get("title");
    return productId && title ? { id: productId, title } : null;
  });
  const [addingForDate, setAddingForDate] = useState<string | null>(null);
  const [movingFor, setMovingFor] = useState<Person | null>(null);

  const searchResults: EventProduct[] = searchFetcher.data?.intent === "search" ? searchFetcher.data.products : [];
  const groups: DateGroup[] = loadFetcher.data?.intent === "load" ? loadFetcher.data.groups : [];
  const dates: Record<string, DateInfo> = loadFetcher.data?.intent === "load" ? loadFetcher.data.dates : {};
  const loading = loadFetcher.state !== "idle";

  function refresh() {
    if (!selectedProduct) return;
    const fd = new FormData();
    fd.set("intent", "load");
    fd.set("productId", selectedProduct.id);
    loadFetcher.submit(fd, { method: "post" });
  }

  useEffect(() => {
    if (selectedProduct) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProduct?.id]);

  function runSearch(term: string) {
    setSearchTerm(term);
    setSelectedProduct(null);
    if (term.trim().length < 2) return;
    const fd = new FormData();
    fd.set("intent", "search");
    fd.set("term", term);
    searchFetcher.submit(fd, { method: "post" });
  }

  function handleRemove(person: Person) {
    if (!window.confirm(`Remove ${person.attendee_name} from ${person.event_date}?`)) return;
    const fd = new FormData();
    fd.set("intent", "remove");
    fd.set("id", person.id);
    actionFetcher.submit(fd, {
      method: "post",
    });
    setTimeout(refresh, 400);
  }

  function handleMove(person: Person, target: string) {
    const from = dates[(person.event_date || "").toLowerCase()];
    const to = dates[target.toLowerCase()];
    const canAdjust = from?.tracked && from.inventoryItemId && from.locationId && to?.tracked && to.inventoryItemId && to.locationId;
    const fd = new FormData();
    fd.set("intent", "move");
    fd.set("id", person.id);
    fd.set("target", target);
    if (canAdjust) {
      fd.set("fromItemId", from!.inventoryItemId!);
      fd.set("fromLocationId", from!.locationId!);
      fd.set("toItemId", to!.inventoryItemId!);
      fd.set("toLocationId", to!.locationId!);
    }
    actionFetcher.submit(fd, { method: "post" });
    setMovingFor(null);
    setTimeout(refresh, 500);
  }

  function handleAdd(date: string, name: string, email: string, quantity: string) {
    const fd = new FormData();
    fd.set("intent", "add");
    fd.set("productId", selectedProduct!.id);
    fd.set("date", date);
    fd.set("name", name);
    fd.set("email", email);
    fd.set("quantity", quantity || "1");
    actionFetcher.submit(fd, { method: "post" });
    setAddingForDate(null);
    setTimeout(refresh, 400);
  }

  const allDateOptions = Object.keys(dates).length ? Object.values(dates).map((d) => d.title) : groups.map((g) => g.date);

  return (
    <s-page heading="Manage Attendees">
      <s-section heading="Find the event">
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
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "1px solid #ddd", borderRadius: "6px", marginBottom: "4px", background: "#fff", cursor: "pointer" }}
                >
                  {p.title}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </s-section>

      {selectedProduct ? (
        <s-section heading={selectedProduct.title}>
          {loading ? (
            <p>Loading…</p>
          ) : !groups.length ? (
            <p>No attendees saved yet.</p>
          ) : (
            groups.map((g) => {
              const info = dates[g.date.toLowerCase()];
              const showCapacity = info?.tracked && info.inventoryQuantity != null;
              const total = showCapacity ? (info!.inventoryQuantity as number) + g.count : null;

              return (
                <div key={g.date} style={{ marginBottom: "26px", paddingBottom: "18px", borderBottom: "1px solid #e5e5e5" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <strong>{shortDateLabel(g.date)}</strong>
                    <span style={{ background: "#e8f6f4", color: "#3e9891", padding: "3px 10px", borderRadius: "999px", fontSize: "12px", fontWeight: 700 }}>
                      {showCapacity ? `${g.count} of ${total} spots filled` : `${g.count} attending`}
                    </span>
                  </div>

                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                    <tbody>
                      {g.people.map((p, i) => (
                        <tr key={p.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                          <td style={{ padding: "6px 4px", width: "24px", color: "#888" }}>{i + 1}</td>
                          <td style={{ padding: "6px 4px" }}>
                            {p.attendee_name}
                            {p.attendee_email ? <span style={{ color: "#888" }}> · {p.attendee_email}</span> : null}
                            {parseInt(p.quantity, 10) > 1 ? <span style={{ color: "#888" }}> · ×{p.quantity}</span> : null}
                          </td>
                          <td style={{ padding: "6px 4px", textAlign: "right", whiteSpace: "nowrap" }}>
                            {movingFor?.id === p.id ? (
                              <span>
                                <select
                                  onChange={(e) => {
                                    if (e.target.value) handleMove(p, e.target.value);
                                  }}
                                  style={{ marginRight: "8px" }}
                                >
                                  <option value="">Move to…</option>
                                  {allDateOptions
                                    .filter((d) => d.toLowerCase() !== (p.event_date || "").toLowerCase())
                                    .map((d) => (
                                      <option key={d} value={d}>{shortDateLabel(d)}</option>
                                    ))}
                                </select>
                                <button type="button" onClick={() => setMovingFor(null)}>Cancel</button>
                              </span>
                            ) : (
                              <button type="button" onClick={() => setMovingFor(p)} style={{ marginRight: "10px" }}>
                                Move
                              </button>
                            )}
                            <button type="button" onClick={() => handleRemove(p)} style={{ color: "#b4534a" }}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {addingForDate === g.date ? (
                    <InlineAddForm
                      onSave={(name, email, qty) => handleAdd(g.date, name, email, qty)}
                      onCancel={() => setAddingForDate(null)}
                    />
                  ) : (
                    <button type="button" onClick={() => setAddingForDate(g.date)} style={{ marginTop: "8px" }}>
                      + Add attendee
                    </button>
                  )}
                </div>
              );
            })
          )}
        </s-section>
      ) : null}
    </s-page>
  );
}

function InlineAddForm({
  onSave,
  onCancel,
}: {
  onSave: (name: string, email: string, quantity: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [quantity, setQuantity] = useState("1");

  return (
    <div style={{ marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ padding: "6px" }} />
      <input placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} style={{ padding: "6px" }} />
      <input placeholder="Qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={{ padding: "6px", width: "50px" }} />
      <button
        type="button"
        onClick={() => {
          if (!name.trim()) return;
          onSave(name.trim(), email.trim(), quantity || "1");
        }}
      >
        Save
      </button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}
