// extensions/event-attendees/src/BlockExtension.jsx
//
// Shows on the product details page. Reads saved "event_registration"
// metaobjects (NOT orders) and lists attendees grouped by date. Each date
// shows a capacity badge (pulled from the matching variant's real
// inventory, when available) and an inline "Add attendee" form. Each
// attendee has Remove and Move-to-another-date actions.
//
// Remove/Move confirmations are built inline with on-page buttons rather
// than window.confirm(), because native browser dialogs are silently
// blocked inside Shopify's sandboxed admin extension iframe — they never
// show, and the code sees "cancelled" every time with no error at all.

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

const ADJUST_INVENTORY_MUTATION = `
  mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      userErrors { field message }
    }
  }
`;

// The app's page inside Shopify admin (not the raw Railway address). Opening
// the app through admin lets Shopify handle the login, so the full list page
// loads with the right permissions. This is Modern Quilting's store + app.
const APP_ADMIN_URL = 'https://admin.shopify.com/store/modern-quilting/apps/event-attendees-modern';

function shortDateLabel(title) {
  if (!title.includes('|')) return title;
  const parts = title.split('|').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return title;
  const first = parts[0];
  return `${first} (+${parts.length - 1} more, ${parts.length} sessions)`;
}

// Pull every date out of an event label (works for single dates and for
// multi-session labels joined with "|"). Returns { first, last } as
// timestamps, or null if the label has no recognizable date.
function labelDateRange(label) {
  const re = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?/g;
  const times = [];
  let m;
  while ((m = re.exec(label || '')) !== null) {
    let hour = m[4] ? parseInt(m[4], 10) % 12 : 0;
    if (m[6] && m[6].toLowerCase() === 'pm') hour += 12;
    const d = new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10), hour, m[5] ? parseInt(m[5], 10) : 0);
    if (!isNaN(d.getTime())) times.push(d.getTime());
  }
  if (!times.length) return null;
  return { first: Math.min(...times), last: Math.max(...times) };
}

// Split groups into upcoming (soonest first) and older (most recent first).
// An event counts as "older" once the whole calendar day of its LAST date has
// passed, so today's class still shows as upcoming all day. Labels with no
// readable date stay in upcoming so nothing gets hidden by mistake.
function splitUpcomingOlder(groups) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const upcoming = [];
  const older = [];
  groups.forEach((g) => {
    const range = labelDateRange(g.date);
    const entry = { g, range };
    if (range && range.last < startOfToday.getTime()) older.push(entry);
    else upcoming.push(entry);
  });
  upcoming.sort((a, b) => (a.range ? a.range.first : Infinity) - (b.range ? b.range.first : Infinity));
  older.sort((a, b) => b.range.last - a.range.last);
  return { upcoming: upcoming.map((e) => e.g), older: older.map((e) => e.g) };
}

function toMap(node) {
  const m = { id: node.id };
  (node.fields || []).forEach((f) => { m[f.key] = f.value; });
  return m;
}

function parseMetafieldDates(raw) {
  if (!raw) return [];
  const matches = raw.match(/\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*[AaPp][Mm])?/g);
  if (matches && matches.length) return matches.map((m) => m.trim());
  return [raw.trim()];
}

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

// Reusable clickable list of dates. A native <select> dropdown doesn't
// render reliably inside this iframe, so both Move and the first-attendee
// date picker use this same button-list pattern instead.
function DatePicker({ options, onPick, disabled }) {
  if (!options.length) {
    return <s-text tone="subdued">No dates found for this event yet.</s-text>;
  }
  return (
    <s-stack direction="block" gap="tight">
      {options.map((d) => (
        <s-button key={d} variant="tertiary" onClick={() => onPick(d)} disabled={disabled}>
          {shortDateLabel(d)}
        </s-button>
      ))}
    </s-stack>
  );
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

function NewDateAddForm({ productId, dateOptions, onAdded, onCancel }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!date) {
    return (
      <s-stack direction="block" gap="tight">
        <s-text tone="subdued">Pick a date:</s-text>
        <DatePicker options={dateOptions} onPick={setDate} disabled={false} />
        <s-button variant="tertiary" onClick={onCancel}>
          Cancel
        </s-button>
      </s-stack>
    );
  }

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
      if (node) onAdded(date, toMap(node));
    } catch (e) {
      setError(String((e && e.message) || e));
      setSaving(false);
    }
  }

  return (
    <s-stack direction="block" gap="tight">
      <s-text tone="subdued">Date: {shortDateLabel(date)}</s-text>
      <s-text-field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <s-text-field label="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
      <s-text-field label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      {error ? <s-text tone="critical">{error}</s-text> : null}
      <s-stack direction="inline" gap="base">
        <s-button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Adding…' : 'Save'}
        </s-button>
        <s-button variant="tertiary" onClick={() => setDate('')} disabled={saving}>
          Back
        </s-button>
        <s-button variant="tertiary" onClick={onCancel} disabled={saving}>
          Cancel
        </s-button>
      </s-stack>
    </s-stack>
  );
}

function MoveControl({ person, dateOptions, eventDates, onMoved }) {
  const options = dateOptions.filter((d) => d.toLowerCase() !== (person.event_date || '').toLowerCase());
  const [pendingTarget, setPendingTarget] = useState(null);
  const [moving, setMoving] = useState(false);

  if (!options.length) {
    return <s-text tone="subdued">No other dates for this event to move to yet.</s-text>;
  }

  async function confirmMove() {
    const target = pendingTarget;
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

  if (pendingTarget) {
    return (
      <s-stack direction="inline" gap="tight">
        <s-text tone="critical">Move to {shortDateLabel(pendingTarget)}?</s-text>
        <s-button variant="tertiary" tone="critical" onClick={confirmMove} disabled={moving}>
          {moving ? 'Moving…' : 'Yes, move'}
        </s-button>
        <s-button variant="tertiary" onClick={() => setPendingTarget(null)} disabled={moving}>
          Cancel
        </s-button>
      </s-stack>
    );
  }

  return (
    <s-stack direction="block" gap="tight">
      <s-text tone="subdued">Move to:</s-text>
      <DatePicker options={options} onPick={setPendingTarget} disabled={moving} />
    </s-stack>
  );
}

function Attendees() {
  const { data } = shopify;
  const productId = data?.selected?.[0]?.id;
  const [state, setState] = useState({ loading: true, error: '', groups: [] });
  const [eventDates, setEventDates] = useState({});
  const [removingId, setRemovingId] = useState(null);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState(null);
  const [addingForDate, setAddingForDate] = useState(null);
  const [movingFor, setMovingFor] = useState(null);
  const [showOlder, setShowOlder] = useState(false);

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
    setConfirmingRemoveId(null);
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

  const totalAttendees = state.groups.reduce((n, g) => n + g.count, 0);
  const allDateOptions = Object.keys(eventDates).length
    ? Object.values(eventDates).map((d) => d.title)
    : state.groups.map((g) => g.date);

  // Dates that exist on the product but have nobody registered yet. They are
  // built from the product's own dates (not saved attendees), so a new date
  // still shows up with an "+ Add attendee" button. Only upcoming dates are
  // listed, soonest first, capped so a 24-date series doesn't flood the panel.
  const MAX_EMPTY_DATES = 10;
  const knownDates = new Set(state.groups.map((g) => g.date.trim().toLowerCase()));
  const emptyCandidates = Object.values(eventDates)
    .filter((d) => d.title && !knownDates.has(d.title.trim().toLowerCase()) && labelDateRange(d.title))
    .map((d) => ({ date: d.title, count: 0, people: [] }));
  const emptyUpcomingAll = splitUpcomingOlder(emptyCandidates).upcoming;
  const emptyShown = emptyUpcomingAll.slice(0, MAX_EMPTY_DATES);
  const emptyHidden = emptyUpcomingAll.length - emptyShown.length;
  const { upcoming, older } = splitUpcomingOlder([...state.groups, ...emptyShown]);

  function renderGroup(g, showDivider) {
      const capacityInfo = eventDates[g.date.toLowerCase()];
      const showCapacity = capacityInfo && capacityInfo.tracked && capacityInfo.inventoryQuantity != null;
      const total = showCapacity ? capacityInfo.inventoryQuantity + g.count : null;
      const badgeTone = showCapacity && capacityInfo.inventoryQuantity <= 0 ? 'critical' : 'success';

      return (
        <s-stack direction="block" gap="tight" key={g.date}>
          <s-stack direction="inline" gap="base" inlineAlignment="space-between">
            <s-text fontWeight="bold">{shortDateLabel(g.date)}</s-text>
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
                    {confirmingRemoveId === p.id ? (
                      <s-stack direction="inline" gap="tight">
                        <s-text tone="critical">Remove?</s-text>
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          onClick={() => handleRemove(p)}
                          disabled={removingId === p.id}
                        >
                          {removingId === p.id ? 'Removing…' : 'Yes, remove'}
                        </s-button>
                        <s-button variant="tertiary" onClick={() => setConfirmingRemoveId(null)}>
                          Cancel
                        </s-button>
                      </s-stack>
                    ) : (
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => setConfirmingRemoveId(p.id)}
                      >
                        Remove
                      </s-button>
                    )}
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

          {showDivider ? <s-divider /> : null}
        </s-stack>
      );
  }

  return (
    <s-admin-block heading="Event Attendees">
      <s-stack direction="block" gap="base">
        {state.groups.length || upcoming.length ? (
          <>
            <s-stack direction="inline" gap="base" inlineAlignment="space-between">
              <s-text tone="subdued">
                {upcoming.length} upcoming {upcoming.length === 1 ? 'date' : 'dates'}{older.length ? ` · ${older.length} older` : ''} · {totalAttendees} total {totalAttendees === 1 ? 'attendee' : 'attendees'}
              </s-text>
              <s-link
                href={`${APP_ADMIN_URL}/app/manage-attendees?productId=${encodeURIComponent(productId)}`}
                target="_blank"
              >
                View full list
              </s-link>
            </s-stack>
            <s-divider />
          </>
        ) : (
          <s-text tone="subdued">No attendees saved yet. New orders will appear here automatically.</s-text>
        )}

        {upcoming.map((g, gi) => renderGroup(g, gi < upcoming.length - 1))}

        {emptyHidden > 0 ? (
          <s-text tone="subdued">
            +{emptyHidden} more upcoming {emptyHidden === 1 ? 'date' : 'dates'} with no attendees yet
          </s-text>
        ) : null}

        {state.groups.length && !upcoming.length ? (
          <s-text tone="subdued">No upcoming dates.</s-text>
        ) : null}

        {older.length ? (
          <s-stack direction="block" gap="base">
            <s-divider />
            <s-button variant="tertiary" onClick={() => setShowOlder((v) => !v)}>
              {showOlder ? 'Hide Older Events' : `Show Older Events (${older.length} ${older.length === 1 ? 'date' : 'dates'})`}
            </s-button>
            {showOlder ? (
              <s-stack direction="block" gap="base">
                <s-text fontWeight="bold" tone="subdued">Older Events</s-text>
                {older.map((g, gi) => renderGroup(g, gi < older.length - 1))}
              </s-stack>
            ) : null}
          </s-stack>
        ) : null}

        {!state.groups.length && !upcoming.length ? (
          addingForDate === '__new__' ? (
            <NewDateAddForm
              productId={productId}
              dateOptions={allDateOptions}
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
