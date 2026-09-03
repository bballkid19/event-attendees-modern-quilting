// extensions/event-attendees/src/BlockExtension.jsx
//
// Shows on the product details page. Reads saved "event_registration"
// metaobjects (NOT orders) and lists attendees grouped by date. Each
// attendee has a Remove button so a cancellation can be taken off the list.

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export default async () => {
  render(<Attendees />, document.body);
};

const QUERY = `
  query($after: String) {
    metaobjects(type: "event_registration", first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        fields { key value }
      }
    }
  }
`;

const DELETE_MUTATION = `
  mutation DeleteRegistration($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message }
    }
  }
`;

function toMap(node) {
  const m = { id: node.id };
  (node.fields || []).forEach((f) => { m[f.key] = f.value; });
  return m;
}

function Attendees() {
  const { data } = shopify;
  const productId = data?.selected?.[0]?.id;
  const [state, setState] = useState({ loading: true, error: '', groups: [] });
  const [removingId, setRemovingId] = useState(null);

  async function loadAttendees() {
    setState((s) => ({ ...s, loading: true, error: '' }));
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

      setState({ loading: false, error: '', groups });
    } catch (e) {
      setState({ loading: false, error: String((e && e.message) || e), groups: [] });
    }
  }

  useEffect(() => {
    if (!productId) return;
    loadAttendees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  async function handleRemove(person) {
    const confirmed = window.confirm(`Remove ${person.attendee_name} from ${person.event_date}?`);
    if (!confirmed) return;

    setRemovingId(person.id);
    try {
      const res = await shopify.query(DELETE_MUTATION, { variables: { id: person.id } });
      const errs = res?.data?.metaobjectDelete?.userErrors;
      if (errs && errs.length) {
        window.alert(`Couldn't remove: ${errs[0].message}`);
        setRemovingId(null);
        return;
      }
      setState((s) => {
        const groups = s.groups
          .map((g) => {
            if (g.date !== person.event_date) return g;
            const people = g.people.filter((p) => p.id !== person.id);
            const count = people.reduce((n, p) => n + (parseInt(p.quantity, 10) || 1), 0);
            return { ...g, people, count };
          })
          .filter((g) => g.people.length > 0);
        return { ...s, groups };
      });
    } catch (e) {
      window.alert(`Couldn't remove: ${String((e && e.message) || e)}`);
    } finally {
      setRemovingId(null);
    }
  }

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
      <s-stack direction="block" gap="base">
        <s-text tone="subdued">
          {totalDates} {totalDates === 1 ? 'date' : 'dates'} · {totalAttendees} total {totalAttendees === 1 ? 'attendee' : 'attendees'}
        </s-text>

        <s-divider />

        {state.groups.map((g, gi) => (
          <s-stack direction="block" gap="tight" key={g.date}>
            <s-stack direction="inline" gap="base" inlineAlignment="space-between">
              <s-text fontWeight="bold">{g.date}</s-text>
              <s-badge tone="success">{g.count} attending</s-badge>
            </s-stack>

            <s-stack direction="block" gap="extra-tight">
              {g.people.map((p, i) => (
                <s-stack direction="inline" gap="base" inlineAlignment="space-between" key={p.id}>
                  <s-text>
                    {i + 1}. {p.attendee_name}
                    {p.attendee_email ? ` · ${p.attendee_email}` : ''}
                    {parseInt(p.quantity, 10) > 1 ? ` · ×${p.quantity}` : ''}
                  </s-text>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    onClick={() => handleRemove(p)}
                    disabled={removingId === p.id}
                  >
                    {removingId === p.id ? 'Removing…' : 'Remove'}
                  </s-button>
                </s-stack>
              ))}
            </s-stack>

            {gi < state.groups.length - 1 ? <s-divider /> : null}
          </s-stack>
        ))}
      </s-stack>
    </s-admin-block>
  );
}