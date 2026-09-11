/**
 * `/apps/accept?token=…` — where an invitation link lands.
 *
 * The token is read on the server so the panel never has to wait for a
 * client-side search-param read, and the whole screen is one narrow column:
 * whoever arrives here was invited to an app, not to the product.
 */
import type { Metadata } from "next";
import { PageHeading } from "@/components/screens/page-heading";
import { AcceptPanel } from "./accept-panel";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = typeof raw === "string" && raw.trim() ? raw : null;

  return (
    <div className="product-page mx-auto h-full w-full max-w-[640px] overflow-y-auto">
      <PageHeading
        title="Invitation"
        description="Accept an invitation to an app someone shared with you."
      />
      <AcceptPanel token={token} />
    </div>
  );
}
