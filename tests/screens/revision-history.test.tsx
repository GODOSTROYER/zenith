import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRevisions } from "@/app/(product)/p/[slug]/revisions/use-revisions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api: calls.api }));
let root: Root;
let host: HTMLDivElement;
let state: ReturnType<typeof useRevisions>;
const rows = (total: number) => Array.from({ length: total }, (_, i) => ({ id: `r${total - i}`, number: total - i }));
function Harness({ project = "p1", count }: { project?: string; count: number }) {
  state = useRevisions(project, count);
  return <div>{state.revisions.map((r) => <span key={r.id}>{r.id}</span>)}</div>;
}
function serve(total: number) {
  calls.api.mockImplementation(async (url: string) => {
    const offset = Number(new URL(url, "http://local.test").searchParams.get("cursor") ?? 0);
    const revisions = rows(total).slice(offset, offset + 25);
    return { revisions, total, nextCursor: offset + revisions.length < total ? String(offset + revisions.length) : undefined };
  });
}
beforeEach(() => {
  calls.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("keeps older loaded revisions visible when a new deployment refreshes the first page", async () => {
  serve(60);
  await act(async () => root.render(<Harness count={60} />));
  await act(async () => state.loadMore());
  expect(state.revisions.at(-1)?.id).toBe("r11");
  serve(61);
  await act(async () => root.render(<Harness count={61} />));
  expect(state.revisions[0].id).toBe("r61");
  expect(state.revisions.some((r) => r.id === "r11")).toBe(true);
  expect(new Set(state.revisions.map((r) => r.id)).size).toBe(state.revisions.length);
  expect(state.total).toBe(61);
});

it("does not leave a gap when more than a page of new revisions arrives", async () => {
  serve(80);
  await act(async () => root.render(<Harness count={80} />));
  await act(async () => state.loadMore());
  serve(110);
  await act(async () => root.render(<Harness count={110} />));
  expect(state.revisions.some((r) => r.id === "r31")).toBe(true);
  const numbers = state.revisions.map((r) => r.number);
  expect(numbers.every((n, i) => i === 0 || numbers[i - 1] - n === 1)).toBe(true);
  await act(async () => state.loadMore());
  expect(state.revisions.at(-1)?.id).toBe("r1");
  expect(state.hasMore).toBe(false);
});

it("ignores a previous project's pending request after a project switch", async () => {
  let finish!: (value: unknown) => void;
  calls.api.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<Harness count={30} />));
  serve(1);
  await act(async () => root.render(<Harness project="p2" count={1} />));
  await act(async () => finish({ revisions: [{ id: "old-project", number: 30 }], total: 30 }));
  expect(state.revisions.map((r) => r.id)).toEqual(["r1"]);
});
