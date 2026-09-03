// extensions/event-attendees/src/BlockExtension.jsx
//
// Shows on the product details page. Reads saved "event_registration"
// metaobjects (NOT orders) and lists attendees grouped by date. Each date
// has a "Copy emails" button and an inline "Add attendee" form, and each
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

const CREATE_MUTATION = `
  mutation CreateRegistration($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject {
        id
        fields { key value }
      }
      userErrors { field message }
    }
  }
`;

function toMap(node) {
  const m = { id: node.id };
  (node.fields || []).forEach((f) => { m[f.key] = f.value; });
  return m;
}

function AddAttendeeForm({ productId, date, onAdded, onCancel }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await shopify.query(CREATE_MUTATION, {
        variables: {
          metaobject: {
            type: 'event_registration',
            fields: [
              { key: 'event_product', value: productId },
              { key: 'event_date', value: date },
              { key: 'attendee_name', value: name.trim() },
              { key: 'attendee_email', value: email.trim() },
              { key: 'quantity', value: quantity || '1' },
              { key: 'order_name', value: 'Added manually' },
              { key: 'ordered_at', value: new Date().toISOString() },
            ],
          },
        },
      });
      const errs = res?.data?.metaobjectCreate?.userErrors;
      if (errs && errs.length) {
        setError(errs[0].message);
        setSaving(false);
        return;
      }
      const node = res?.data?.metaobjectCreate?.metaobject;
      if (node) onAdded(toMap(node));
    } catch (e) {
      setError(String((e && e.message) || e));
      setSaving(false);
    }
  }

  return (
    <s-stack direction="block" gap="tight">
      <s-text-field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <s-text-field label="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
      <s-text-field label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      {error ? <s-text tone="critical">{error}</s-text> : null}
      <s-stack direction="inline" gap="base">
        <s-button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Adding…' : 'Save'}
        </s-button>
        <s-button variant="tertiary" onClick={onCancel} disabled={saving}>
          Cancel
        </s-button>
      </s-stack>
    </s-stack>
  );
}

function Attendees() {
  const { data } = shopify;
  const productId = data?.selected?.[0]?.id;
  const [state, setState] = useState({ loading: true, error: '', groups: [] });
  const [removingId, setRemovingId] = useState(null);
  const [addingForDate, setAddingForDate] = useState(null);

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

  function handleAdded(date, newPerson) {
    setState((s) => {
      let found = false;
      const groups = s.groups.map((g) => {
        if (g.date !== date) return g;
        found = true;
        const people = [...g.people, newPerson].sort((a, b) =>
          (a.attendee_name || '').localeCompare(b.attendee_name || ''));
        const count = people.reduce((n, p) => n + (parseInt(p.quantity, 10) || 1), 0);
        return { ...g, people, count };
      });
      if (!found) {
        groups.push({ date, count: parseInt(newPerson.quantity, 10) || 1, people: [newPerson] });
        groups.sort((a, b) => a.date.localeCompare(b.date));
      }
      return { ...s, groups };
    });
    setAddingForDate(null);
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

  const totalDates = state.groups.length;
  const totalAttendees = state.groups.reduce((n, g) => n + g.count, 0);

  return (
    <s-admin-block heading="Event Attendees">
      <s-stack direction="block" gap="base">
        {state.groups.length ? (
          <>
            <s-text tone="subdued">
              {totalDates} {totalDates === 1 ? 'date' : 'dates'} · {totalAttendees} total {totalAttendees === 1 ? 'attendee' : 'attendees'}
            </s-text>
            <s-divider />
          </>
        ) : (
          <s-text tone="subdued">No attendees saved yet. New orders will appear here automatically.</s-text>
        )}

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

            <s-stack direction="inline" gap="base">
              {addingForDate === g.date ? null : (
                <s-button variant="tertiary" onClick={() => setAddingForDate(g.date)}>
                  + Add attendee
                </s-button>
              )}
            </s-stack>

            {addingForDate === g.date ? (
              <AddAttendeeForm
                productId={productId}
                date={g.date}
                onAdded={(person) => handleAdded(g.date, person)}
                onCancel={() => setAddingForDate(null)}
              />
            ) : null}

            {gi < state.groups.length - 1 ? <s-divider /> : null}
          </s-stack>
        ))}

        {!state.groups.length ? (
          addingForDate === '__new__' ? (
            <NewDateAddForm
              productId={productId}
              onAdded={(date, person) => handleAdded(date, person)}
              onCancel={() => setAddingForDate(null)}
            />
          ) : (
            <s-button variant="tertiary" onClick={() => setAddingForDate('__new__')}>
              + Add attendee
            </s-button>
          )
        ) : null}
      </s-stack>
    </s-admin-block>
  );
}

// Used only when a product has no attendees yet — collects the date and
// the attendee's details together in one form.
function NewDateAddForm({ productId, onAdded, onCancel }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!date.trim() || !name.trim()) {
      setError('Date and name are both required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await shopify.query(CREATE_MUTATION, {
        variables: {
          metaobject: {
            type: 'event_registration',
            fields: [
              { key: 'event_product', value: productId },
              { key: 'event_date', value: date.trim() },
              { key: 'attendee_name', value: name.trim() },
              { key: 'attendee_email', value: email.trim() },
              { key: 'quantity', value: quantity || '1' },
              { key: 'order_name', value: 'Added manually' },
              { key: 'ordered_at', value: new Date().toISOString() },
            ],
          },
        },
      });
      const errs = res?.data?.metaobjectCreate?.userErrors;
      if (errs && errs.length) {
        setError(errs[0].message);
        setSaving(false);
        return;
      }
      const node = res?.data?.metaobjectCreate?.metaobject;
      if (node) onAdded(date.trim(), toMap(node));
    } catch (e) {
      setError(String((e && e.message) || e));
      setSaving(false);
    }
  }

  return (
    <s-stack direction="block" gap="tight">
      <s-text-field label="Date" placeholder="Aug 15 2026 10:00 AM" value={date} onChange={(e) => setDate(e.target.value)} />
      <s-text-field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <s-text-field label="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
      <s-text-field label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      {error ? <s-text tone="critical">{error}</s-text> : null}
      <s-stack direction="inline" gap="base">
        <s-button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Adding…' : 'Save'}
        </s-button>
        <s-button variant="tertiary" onClick={onCancel} disabled={saving}>
          Cancel
        </s-button>
      </s-stack>
    </s-stack>
  );
}
