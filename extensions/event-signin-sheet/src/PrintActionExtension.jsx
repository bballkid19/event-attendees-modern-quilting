// extensions/event-signin-sheet/src/PrintActionExtension.jsx
//
// Adds an entry to the Print menu on the product page. It previews and prints
// the sign-in sheet served by /print/attendees for the current event product.

import { render } from 'preact';

export default async () => {
  render(<PrintAction />, document.body);
};

function PrintAction() {
  const { data } = shopify;
  const productId = data?.selected?.[0]?.id;

  // Relative app URL — resolves to your app's /print/attendees route.
  const src = productId
    ? `/print/attendees?product=${encodeURIComponent(productId)}`
    : undefined;

  return <s-admin-print-action src={src}></s-admin-print-action>;
}