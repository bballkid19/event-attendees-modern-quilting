// app/routes/webhooks.orders.create.tsx
//
// Runs on your app's backend every time an order is placed.
// For each line item that belongs to an event product, it saves ONE
// "event_registration" metaobject entry per student registered on that
// line item. Because we save at order time, we never read old orders —
// the 60-day order limit never applies and read_all_orders is NOT needed.

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Turn a numeric REST id from the webhook payload into a GraphQL GID.
function productGid(id: number | string) {
  return `gid://shopify/Product/${id}`;
}

// Given the product ids on the order, ask Shopify which ones are events.
// We treat a product as an event if it has the custom.event_dates metafield
// (the same field your calendar section uses).
async function findEventProductIds(admin: any, productIds: string[]) {
  if (!productIds.length) return new Set<string>();
  const gids = productIds.map(productGid);
  const res = await admin.graphql(
    `#graphql
    query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          metafield(namespace: "custom", key: "event_dates") { id }
        }
      }
    }`,
    { variables: { ids: gids } },
  );
  const body = await res.json();
  const events = new Set<string>();
  (body?.data?.nodes || []).forEach((n: any) => {
    if (n && n.metafield) events.add(n.id);
  });
  return events;
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
  if (errs && errs.length) console.error("metaobjectCreate errors:", errs);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, admin, payload } = await authenticate.webhook(request);

  // admin is undefined if the app was uninstalled — nothing to do.
  if (topic !== "ORDERS_CREATE" || !admin) return new Response();

  const order: any = payload;
  const lineItems: any[] = order.line_items || [];

  const productIds = lineItems
    .map((li) => li.product_id)
    .filter(Boolean)
    .map(String);

  const eventProductGids = await findEventProductIds(admin, [...new Set(productIds)]);
  if (!eventProductGids.size) return new Response();

  const buyerName = [order.customer?.first_name, order.customer?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const buyerEmail = order.customer?.email || order.email || "";

  for (const li of lineItems) {
    const gid = li.product_id ? productGid(li.product_id) : "";
    if (!eventProductGids.has(gid)) continue;

    const props: any[] = li.properties || [];

    // Your product page's registration form sends "Student 1 Name",
    // "Student 1 Email", "Student 2 Name", etc. — one set per student,
    // added automatically as quantity increases. Find every student
    // index present on this line item.
    const studentIndexes = new Set<number>();
    props.forEach((p) => {
      const m = String(p.name || "").match(/^Student (\d+) Name$/i);
      if (m) studentIndexes.add(parseInt(m[1], 10));
    });

    if (studentIndexes.size > 0) {
      // Multi-student registration form — save ONE row per student,
      // so a quantity-3 order creates 3 separate attendee entries.
      for (const idx of Array.from(studentIndexes).sort((a, b) => a - b)) {
        const nameProp = props.find((p) => p.name === `Student ${idx} Name`);
        const emailProp = props.find((p) => p.name === `Student ${idx} Email`);
        const dateProp = props.find((p) => p.name === "Class Date");

        await saveRegistration(admin, {
          event_product: gid,
          // "Class Date" is the hidden field your theme sets to the
          // selected variant's date — more reliable than the variant
          // title alone since it's exactly what the form submitted.
          event_date: (dateProp?.value || li.variant_title || li.title || "Event").toString(),
          attendee_name: (nameProp?.value || "Unknown").toString(),
          attendee_email: (emailProp?.value || "").toString(),
          quantity: "1",
          order_name: order.name || "",
          ordered_at: order.created_at || new Date().toISOString(),
        });
      }
    } else {
      // Fallback for products without the per-student form (or if it
      // wasn't filled in) — save one row using the buyer as attendee.
      await saveRegistration(admin, {
        event_product: gid,
        event_date: li.variant_title || li.title || "Event",
        attendee_name: buyerName || "Unknown",
        attendee_email: buyerEmail || "",
        quantity: String(li.quantity || 1),
        order_name: order.name || "",
        ordered_at: order.created_at || new Date().toISOString(),
      });
    }
  }

  return new Response();
};