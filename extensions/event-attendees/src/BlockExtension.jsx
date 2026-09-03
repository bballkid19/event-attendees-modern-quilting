// extensions/event-attendees/src/BlockExtension.jsx
//
// Shows on the product details page. Reads saved "event_registration"
// metaobjects (NOT orders) and lists attendees grouped by date. Each date
// shows a capacity badge (pulled from the matching variant's real
// inventory, when available) and an inline "Add attendee" form. Each
// attendee has Remove and Move-to-another-date actions.

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export default async () => {
  render(<Attendees />, document.body);
};

const REGISTRATIONS_QUERY = `
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

// Real per-date variants (the "Test Quilting Class" pattern) plus the
// product's own custom.event_dates metafield text, used as a fallback for
// products that store dates as plain text instead of variants (the
// "Harper Holdall" pattern). Mirrors the same logic used by the CSV
// importer, so both places agree on what a product's dates are.
const PRODUCT_DATES_QUERY = `
  query($id: ID!) {
    product(id: $id) {
      variants(first: 100) {
        nodes {
          title
          inventoryQuantity
          inventoryItem {
            id
            tracked
            inventoryLevels(first: 1) {
              nodes {
                location { id }
              }
            }
          }
        }
      }
      metafield(namespace: "custom", key: "event_dates") { value }
    }
  }
`;

const ADJUST_INVENTORY_MUTATION = `
  mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      userErrors { field message }
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

const UPDATE_DATE_MUTATION = `
  mutation UpdateRegistrationDate($id: ID!, $fields: [MetaobjectFieldInput!]!) {
    metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
      metaobject { id }
      userErrors { field message }
    }
  }
`;

function toMap(node) {
  const m = { id: node.id };
  (node.fields || []).forEach((f) => { m[f.key] = f.value; });
  return m;
}

// Parses a product's Event Dates metafield text into individual date
// strings by scanning for MM/DD/YYYY (with an optional time) patterns —
// same approach as the CSV importer, so results stay consistent.
function parseMetafieldDates(raw) {
  if (!raw) return [];
  const matches = raw.match(/\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*[AaPp][Mm])?/g);
  if (matches && matches.length) return matches.map((m) => m.trim());
  return [raw.trim()];
}

// Fetches this event's known dates and, where available, real inventory
// numbers. Returns a map keyed by lowercased date title.
async function loadEventDates(productId) {
  const res = await shopify.query(PRODUCT_DATES_QUERY, { variables: { id: productId } });
  const product = res?.data?.product;
  const variantNodes = product?.variants?.nodes || [];
  const realVariants = variantNodes.filter((v) => v.title && v.title !== 'Default Title');

  const map = {};
  if (realVariants.length) {
    realVariants.forEach((v) => {
      const tracked = !!v.inventoryItem?.tracked;
      const locationId = v.inventoryItem?.inventoryLevels?.nodes?.[0]?.location?.id || null;
      map[v.title.toLowerCase()] = {
        title: v.title,
        tracked,
        inventoryQuantity: v.inventoryQuantity,
        inventoryItemId: tracked ? v.inventoryItem?.id : null,
        locationId: tracked ? locationId : null,
      };
    });
    return map;
  }

  const raw = product?.metafield?.value || '';
  parseMetafieldDates(raw).forEach((title) => {
    map[title.toLowerCase()] = { title, tracked: false, inventoryQuantity: null };
  });
  return map;
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

// Small inline control: pick a different date for this one attendee, then
// confirm with "Move". If both the old and new dates map to tracked
// Shopify variants, this also adjusts real inventory: +1 back on the old
// date, -1 on the new date, so "spots left" stays accurate. Dates without
// tracked inventory (e.g. metafield-only products) are simply skipped for
// the inventory step — only the registration's date changes for those.
function MoveControl({ person, dateOptions, eventDates, onMoved }) {
  const options = dateOptions.filter((d) => d.toLowerCase() !== (person.event_date || '').toLowerCase());
  const [target, setTarget] = useState(options[0] || '');
  const [moving, setMoving] = useState(false);

  if (!options.length) {
    return <s-text tone="subdued">No other dates for this event to move to yet.</s-text>;
  }

  async function handleMove() {
    if (!target) return;
    setMoving(true);
    try {
      const fromInfo = eventDates[(person.event_date || '').toLowerCase()];
      const toInfo = eventDates[target.toLowerCase()];
      const canAdjustInventory =
        fromInfo && fromInfo.tracked && fromInfo.inventoryItemId && fromInfo.locationId &&
        toInfo && toInfo.tracked && toInfo.inventoryItemId && toInfo.locationId;

      if (canAdjustInventory) {
        const invRes = await shopify.query(ADJUST_INVENTORY_MUTATION, {
          variables: {
            input: {
              reason: 'correction',
              name: 'available',
              changes: [
                { delta: 1, inventoryItemId: fromInfo.inventoryItemId, locationId: fromInfo.locationId },
                { delta: -1, inventoryItemId: toInfo.inventoryItemId, locationId: toInfo.locationId },
              ],
            },
          },
        });
        const invErrs = invRes?.data?.inventoryAdjustQuantities?.userErrors;
        if (invErrs && invErrs.length) {
          window.alert(`Couldn't update inventory: ${invErrs[0].message}`);
          setMoving(false);
          return;
        }
      }

      const res = await shopify.query(UPDATE_DATE_MUTATION, {
        variables: {
          id: person.id,
          fields: [{ key: 'event_date', value: target }],
        },
      });
      const errs = res?.data?.metaobjectUpdate?.userErrors;
      if (errs && errs.length) {
        window.alert(`Couldn't move: ${errs[0].message}`);
        setMoving(false);
        return;
      }
      onMoved(person, target, canAdjustInventory);
    } catch (e) {
      window.alert(`Couldn't move: ${String((e && e.message) || e)}`);
      setMoving(false);
    }
  }

  return (
    <s-stack direction="inline" gap="tight">
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={moving}
        style={{ padding: '4px 6px', borderRadius: '6px' }}
      >
        {options.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      <s-button variant="tertiary" onClick={handleMove} disabled={moving}>
        {moving ? 'Moving…' : 'Move'}
      </s-button>
    </s-stack>
  );
}

function Attendees() {
  const { data } = shopify;
  const productId = data?.selected?.[0]?.id;
  const [state, setState] = useState({ loading: true, error: '', groups: [] });
  const [eventDates, setEventDates] = useState({});
  const [removingId, setRemovingId] = useState(null);
  const [addingForDate, setAddingForDate] = useState(null);
  const [movingFor, setMovingFor] = useState(null);

  async function loadAttendees() {
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const rows = [];
      let after = null;
      let pages = 0;
      do {
        const res = await shopify.query(REGISTRATIONS_QUERY, { variables: { after } });
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
    loadEventDates(productId).then(setEventDates).catch(() => setEventDates({}));
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

  function regroup(people) {
    const byDate = {};
    people.forEach((r) => {
      const d = r.event_date || 'Event';
      (byDate[d] || (byDate[d] = [])).push(r);
    });
    return Object.keys(byDate).sort().map((date) => {
      const ppl = byDate[date].sort((a, b) =>
        (a.attendee_name || '').localeCompare(b.attendee_name || ''));
      const count = ppl.reduce((n, p) => n + (parseInt(p.quantity, 10) || 1), 0);
      return { date, count, people: ppl };
    });
  }

  function handleAdded(date, newPerson) {
    setState((s) => {
      const allPeople = s.groups.flatMap((g) => g.people).concat([{ ...newPerson, event_date: date }]);
      return { ...s, groups: regroup(allPeople) };
    });
    setAddingForDate(null);
  }

  function handleMoved(person, newDate, inventoryAdjusted) {
    setState((s) => {
      const allPeople = s.groups
        .flatMap((g) => g.people)
        .map((p) => (p.id === person.id ? { ...p, event_date: newDate } : p));
      return { ...s, groups: regroup(allPeople) };
    });
    setMovingFor(null);
    // Real inventory changed on Shopify's side — refresh the capacity
    // numbers so the badges reflect the new spots-left counts.
    if (inventoryAdjusted && productId) {
      loadEventDates(productId).then(setEventDates).catch(() => {});
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

  const totalDates = state.groups.length;
  const totalAttendees = state.groups.reduce((n, g) => n + g.count, 0);
  const allDateOptions = Object.keys(eventDates).length
    ? Object.values(eventDates).map((d) => d.title)
    : state.groups.map((g) => g.date);

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

        {state.groups.map((g, gi) => {
          const capacityInfo = eventDates[g.date.toLowerCase()];
          const showCapacity = capacityInfo && capacityInfo.tracked && capacityInfo.inventoryQuantity != null;
          const total = showCapacity ? capacityInfo.inventoryQuantity + g.count : null;
          const badgeTone = showCapacity && capacityInfo.inventoryQuantity <= 0 ? 'critical' : 'success';

          return (
            <s-stack direction="block" gap="tight" key={g.date}>
              <s-stack direction="inline" gap="base" inlineAlignment="space-between">
                <s-text fontWeight="bold">{g.date}</s-text>
                <s-badge tone={badgeTone}>
                  {showCapacity ? `${g.count} of ${total} spots filled` : `${g.count} attending`}
                </s-badge>
              </s-stack>

              <s-stack direction="block" gap="extra-tight">
                {g.people.map((p, i) => (
                  <s-stack direction="block" gap="extra-tight" key={p.id}>
                    <s-stack direction="inline" gap="base" inlineAlignment="space-between">
                      <s-text>
                        {i + 1}. {p.attendee_name}
                        {p.attendee_email ? ` · ${p.attendee_email}` : ''}
                        {parseInt(p.quantity, 10) > 1 ? ` · ×${p.quantity}` : ''}
                      </s-text>
                      <s-stack direction="inline" gap="tight">
                        {movingFor === p.id ? null : (
                          <s-button variant="tertiary" onClick={() => setMovingFor(p.id)}>
                            Move
                          </s-button>
                        )}
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          onClick={() => handleRemove(p)}
                          disabled={removingId === p.id}
                        >
                          {removingId === p.id ? 'Removing…' : 'Remove'}
                        </s-button>
                      </s-stack>
                    </s-stack>
                    {movingFor === p.id ? (
                      <MoveControl
                        person={p}
                        dateOptions={allDateOptions}
                        eventDates={eventDates}
                        onMoved={handleMoved}
                      />
                    ) : null}
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
          );
        })}

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
