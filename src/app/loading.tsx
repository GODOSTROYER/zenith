import { ScreenLoading } from "@/components/shell/screen-loading";

/** The root fallback is ordinary page content, never a viewport-covering curtain. */
export default function Loading() {
  return <ScreenLoading />;
}
