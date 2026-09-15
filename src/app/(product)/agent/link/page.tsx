import LinkApproval from "./link-approval";

/**
 * The approval screen lives under `(product)`, so it inherits the layout's
 * single `<main>` landmark and its chrome, and — deliberately — the session
 * gate: `/agent/link` is **not** on the middleware bypass list, so a signed-out
 * visitor is sent to `/login?next=/agent/link%3Fcode%3D…` and lands back here
 * with the code intact.
 */
export const metadata = { title: "Link an agent · Zenith" };

export default function AgentLinkPage() {
  return <LinkApproval />;
}
