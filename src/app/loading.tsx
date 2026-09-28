import { ZenithLoader } from "@/components/brand/zenith-loader";

/** Covers server redirects and navigations without a link-click transition. */
export default function Loading() {
  return <div className="zenith-route-loading" role="status" aria-live="polite">
    <span className="sr-only">Loading Zenith</span>
    <ZenithLoader id="route" size={76} />
  </div>;
}
