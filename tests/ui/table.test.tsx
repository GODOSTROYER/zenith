/**
 * The Table primitive's three promises that a screen cannot check for itself.
 *
 * Sorting has to be *announced*, not just performed: a column that reorders
 * rows without moving `aria-sort` is a table that only sighted users can tell
 * has been sorted. And a row that can be clicked has to be reachable by
 * keyboard — a selectable list navigable only with a mouse is a dead list for
 * anyone driving from the keys.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Table, type TableColumn, type TableProps } from "@/components/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

interface Row {
  id: string;
  name: string;
  size: number;
}

const ROWS: Row[] = [
  { id: "b", name: "beta", size: 2 },
  { id: "a", name: "alpha", size: 30 },
  { id: "c", name: "gamma", size: 9 },
];

const COLUMNS: TableColumn<Row>[] = [
  { key: "name", header: "Name", sortable: true, sortValue: (r) => r.name, render: (r) => r.name },
  {
    key: "size",
    header: "Size",
    sortable: true,
    sortValue: (r) => r.size,
    render: (r) => String(r.size),
  },
  { key: "note", header: "Note", render: () => "—" },
];

function render(props: Partial<TableProps<Row>> = {}): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <Table<Row>
        caption="Three things"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        {...props}
      />
    )
  );
  return host;
}

const headers = (el: HTMLElement) => [...el.querySelectorAll("th")];
const bodyRows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("tbody tr")];
const cells = (el: HTMLElement) => bodyRows(el).map((r) => r.querySelector("td")?.textContent);

const press = (el: HTMLElement, key: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

describe("<Table>", () => {
  it("names itself for a screen reader without drawing the caption", () => {
    const el = render();
    const caption = el.querySelector("caption");
    expect(caption?.textContent).toBe("Three things");
    expect(caption?.className).toContain("sr-only");
    expect(render({ captionVisible: true }).querySelector("caption")?.className).not.toContain(
      "sr-only"
    );
  });

  it("marks only sortable columns as sortable, and only the active one as sorted", () => {
    const el = render();
    // Unsorted: the two sortable columns say "none", the plain one says nothing
    // at all — "none" on a column that cannot sort would be a lie.
    expect(headers(el).map((h) => h.getAttribute("aria-sort"))).toEqual(["none", "none", null]);

    act(() => headers(el)[0].querySelector("button")!.click());
    expect(headers(el).map((h) => h.getAttribute("aria-sort"))).toEqual([
      "ascending",
      "none",
      null,
    ]);

    // Same header again reverses it; it never cycles back to "none", because
    // there is no unsorted order to return to once rows have moved.
    act(() => headers(el)[0].querySelector("button")!.click());
    expect(headers(el)[0].getAttribute("aria-sort")).toBe("descending");

    // A different header takes the sort with it, and starts ascending.
    act(() => headers(el)[1].querySelector("button")!.click());
    expect(headers(el).map((h) => h.getAttribute("aria-sort"))).toEqual([
      "none",
      "ascending",
      null,
    ]);
  });

  it("actually reorders the rows, numerically where the values are numbers", () => {
    const el = render();
    expect(cells(el)).toEqual(["beta", "alpha", "gamma"]);

    act(() => headers(el)[0].querySelector("button")!.click());
    expect(cells(el)).toEqual(["alpha", "beta", "gamma"]);

    act(() => headers(el)[0].querySelector("button")!.click());
    expect(cells(el)).toEqual(["gamma", "beta", "alpha"]);

    // 2 < 9 < 30 — the string sort that would put "30" before "9" is the bug
    // this asserts against.
    act(() => headers(el)[1].querySelector("button")!.click());
    expect(cells(el)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("leaves the rows alone when the caller owns the order", () => {
    // A sortable column with no `sortValue` is a paged/server-sorted column:
    // the header tracks state so it can be announced, and nothing is reordered
    // locally — sorting one loaded page would misrepresent the whole set.
    const el = render({
      columns: [{ key: "name", header: "Name", sortable: true, render: (r: Row) => r.name }],
    });
    act(() => headers(el)[0].querySelector("button")!.click());
    expect(headers(el)[0].getAttribute("aria-sort")).toBe("ascending");
    expect(cells(el)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("reports a controlled sort without owning it", () => {
    const seen: string[] = [];
    const el = render({
      sort: { key: "size", dir: "desc" },
      onSortChange: (s) => seen.push(`${s.key}:${s.dir}`),
    });
    expect(headers(el)[1].getAttribute("aria-sort")).toBe("descending");
    expect(cells(el)).toEqual(["alpha", "gamma", "beta"]);

    act(() => headers(el)[1].querySelector("button")!.click());
    expect(seen).toEqual(["size:asc"]);
    // Still descending: the prop did not change, so neither did the table.
    expect(headers(el)[1].getAttribute("aria-sort")).toBe("descending");
  });

  it("keeps rows out of the tab order until they can be selected", () => {
    expect(bodyRows(render()).map((r) => r.getAttribute("tabindex"))).toEqual([null, null, null]);
    // One tab stop, not three: a long table must not be a tab trap.
    const el = render({ onSelectRow: () => undefined });
    expect(bodyRows(el).map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("gives the tab stop and aria-current to the selected row", () => {
    const el = render({ onSelectRow: () => undefined, selectedKey: "c" });
    expect(bodyRows(el).map((r) => r.getAttribute("aria-current"))).toEqual([null, null, "true"]);
    expect(bodyRows(el).map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
  });

  it("walks rows with the arrow keys, and Home/End to the ends", () => {
    const el = render({ onSelectRow: () => undefined });
    const rows = bodyRows(el);
    act(() => rows[0].focus());

    press(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);

    press(rows[1], "ArrowDown");
    expect(document.activeElement).toBe(rows[2]);

    // Past the last row there is nowhere to go; focus stays rather than wrapping
    // silently to the top, which reads as the list having jumped.
    press(rows[2], "ArrowDown");
    expect(document.activeElement).toBe(rows[2]);

    press(rows[2], "ArrowUp");
    expect(document.activeElement).toBe(rows[1]);

    press(rows[1], "End");
    expect(document.activeElement).toBe(rows[2]);

    press(rows[2], "Home");
    expect(document.activeElement).toBe(rows[0]);
  });

  it("selects with Enter, Space and a click", () => {
    const picked: string[] = [];
    const el = render({ onSelectRow: (r: Row) => picked.push(r.id) });
    const rows = bodyRows(el);

    press(rows[1], "Enter");
    press(rows[2], " ");
    act(() => rows[0].click());
    expect(picked).toEqual(["a", "c", "b"]);
  });

  it("shows the empty slot instead of rows, spanning the whole table", () => {
    const el = render({
      rows: [],
      empty: <Table.Empty>Nothing here yet</Table.Empty>,
    });
    expect(bodyRows(el)).toHaveLength(1);
    const cell = el.querySelector("tbody td");
    expect(cell?.textContent).toBe("Nothing here yet");
    expect(cell?.getAttribute("colspan")).toBe("3");
    // The header still stands: an empty table must still say what it is a
    // table of, or the reader cannot tell what is missing.
    expect(headers(el)).toHaveLength(3);
  });

  it("does not steal arrow keys from an input inside a selectable row", () => {
    const el = render({ onSelectRow: () => undefined,
      columns: [{ key: "name", header: "Name", render: (row) => <input aria-label={row.name} defaultValue={row.name} /> }] });
    const input = el.querySelector("input")!;
    act(() => input.focus());
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("scrolls sideways inside its own wrapper", () => {
    // The page must never scroll horizontally because one table is wide.
    expect(render().firstElementChild?.className).toContain("overflow-x-auto");
  });
});
