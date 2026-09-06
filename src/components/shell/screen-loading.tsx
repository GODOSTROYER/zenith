import { Skeleton } from "@/components/ui/skeleton";

/** Keep the existing shell interactive while the next route is being loaded. */
export function ScreenLoading() {
  return (
    <div role="status" aria-label="Loading screen" className="space-y-6 p-6 md:p-8">
      <span className="sr-only">Loading screen…</span>
      <Skeleton height={26} width="30%" />
      <Skeleton height={14} width="55%" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton height={100} />
        <Skeleton height={100} />
        <Skeleton height={100} />
      </div>
      <Skeleton height={240} />
    </div>
  );
}
