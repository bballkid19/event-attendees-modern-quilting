// extensions/event-attendees/src/BlockExtension.jsx
//
// Shows on the product details page. Reads saved "event_registration"
// metaobjects (NOT orders) and lists attendees grouped by date.

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export default async () => {
  render(<Attendees />, document.body);
};

const QUERY = `
  query($after: String) {
    metaobjects(type: "event_registration", first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { fields { key value } }
    }
  }
`;

function toMap(node) {
  const m = {};
  (node.fields || []).forEach((f) => { m[f.key] = f.value; });
  return m;
}

function Attendees() {
  const { data } = shopify;
  const productId = data?.selected?.[0]?.id;
  const [state, setState] = useState({ loading: true, error: '', groups: [] });

  useEffect(() => {
    if (!productId) return;
    let cancelled = false;

    (async () => {
      try {
        const rows = [];
        let after = null;
        let pages = 0;
        do {
          const res = await shopify.query(QUERY, { variables: { after } });
          const conn = res?.data?.metaobjects;
          if (!conn) break;
          conn.nodes.forEach((n) => {
            const m = toMap(n);
            if (m.event_product === productId) rows.push(m);
          });
          after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
          pages += 1;
        } while (after && pages < 20);

        const byDate = {};
        rows.forEach((r) => {
          const d = r.event_date || 'Event';
          (byDate[d] || (byDate[d] = [])).push(r);
        });

        const groups = Object.keys(byDate).sort().map((date) => {
          const people = byDate[date].sort((a, b) =>
            (a.attendee_name || '').localeCompare(b.attendee_name || ''));
          const count = people.reduce((n, p) => n + (parseInt(p.quantity, 10) || 1), 0);
          return { date, count, people };
        });

        if (!cancelled) setState({ loading: false, error: '', groups });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: String((e && e.message) || e), groups: [] });
      }
    })();

    return () => { cancelled = true; };
  }, [productId]);

  if (state.loading) {
    return (
      <s-admin-block heading="Event Attendees">
        <s-text tone="subdued">Loading attendees…</s-text>
      </s-admin-block>
    );
  }
  if (state.error) {
    return (
      <s-admin-block heading="Event Attendees">
        <s-text tone="critical">Couldn't load attendees: {state.error}</s-text>
      </s-admin-block>
    );
  }
  if (!state.groups.length) {
    return (
      <s-admin-block heading="Event Attendees">
        <s-text tone="subdued">No attendees saved yet. New orders will appear here automatically.</s-text>
      </s-admin-block>
    );
  }

  const totalDates = state.groups.length;
  const totalAttendees = state.groups.reduce((n, g) => n + g.count, 0);

  return (
    <s-admin-block heading="Event Attendees">
      <s-stack direction="block" gap="loose">
        <s-stack direction="inline" gap="base" inlineAlignment="space-between">
          <s-text tone="subdued">
            {totalDates} {totalDates === 1 ? 'date' : 'dates'} · {totalAttendees} total {totalAttendees === 1 ? 'attendee' : 'attendees'}
          </s-text>
        </s-stack>

        <s-divider />

        {state.groups.map((g, gi) => (
          <s-stack direction="block" gap="tight" key={g.date}>
            <s-stack direction="inline" gap="base" inlineAlignment="space-between" blockAlignment="center">
              <s-text fontWeight="bold">{g.date}</s-text>
              <s-badge tone="success">{g.count} attending</s-badge>
            </s-stack>

            <s-stack direction="block" gap="extra-tight">
              {g.people.map((p, i) => (
                <s-text key={i}>
                  {i + 1}. {p.attendee_name}
                  {p.attendee_email ? ` · ${p.attendee_email}` : ''}
                  {parseInt(p.quantity, 10) > 1 ? ` · ×${p.quantity}` : ''}
                </s-text>
              ))}
            </s-stack>

            {gi < state.groups.length - 1 ? <s-divider /> : null}
          </s-stack>
        ))}
      </s-stack>
    </s-admin-block>
  );
}
