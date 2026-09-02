/** Search-match splitting in the log viewer — the loop behind the highlight. */
import { describe, expect, it } from "vitest";
import { splitMatches } from "@/components/ui/log-viewer";

const joined = (line: string, needle: string) =>
  splitMatches(line, needle)
    .map((p) => (p.hit ? `[${p.text}]` : p.text))
    .join("");

describe("splitMatches", () => {
  it("returns the line untouched when there is no search", () => {
    expect(splitMatches("GET /healthz 200", "")).toEqual([{ text: "GET /healthz 200", hit: false }]);
  });

  it("marks every occurrence, case-insensitively, keeping the original text", () => {
    expect(joined("GET /Api and /api", "api")).toBe("GET /[Api] and /[api]");
  });

  it("handles a match at each end without emitting empty parts", () => {
    expect(splitMatches("aba", "a")).toEqual([
      { text: "a", hit: true },
      { text: "b", hit: false },
      { text: "a", hit: true },
    ]);
  });

  it("does not loop forever on overlapping candidates", () => {
    expect(joined("aaaa", "aa")).toBe("[aa][aa]");
  });

  it("leaves a line with no match in one piece", () => {
    expect(splitMatches("nothing here", "zzz")).toEqual([{ text: "nothing here", hit: false }]);
  });
});
