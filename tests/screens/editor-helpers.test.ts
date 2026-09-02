/**
 * The two pieces of non-presentational logic behind the Source editor and the
 * Revisions compare heading. Both are pure, so they are tested directly.
 */
import { describe, expect, it } from "vitest";
import {
  describeJsonError,
  jsonErrorSite,
  lineColToOffset,
  offsetToLineCol,
} from "@/app/(product)/p/[slug]/source/json-error";
import { revisionPairLabel } from "@/app/(product)/p/[slug]/revisions/pair-label";

const TEXT = 'line one\nline two\nline three';

describe("offsetToLineCol", () => {
  it("is 1-based on both axes", () => {
    expect(offsetToLineCol(TEXT, 0)).toEqual({ line: 1, column: 1, offset: 0 });
    expect(offsetToLineCol(TEXT, 4)).toEqual({ line: 1, column: 5, offset: 4 });
  });

  it("counts the newline as the end of its line, not the start of the next", () => {
    expect(offsetToLineCol(TEXT, 8)).toMatchObject({ line: 1, column: 9 }); // the \n itself
    expect(offsetToLineCol(TEXT, 9)).toMatchObject({ line: 2, column: 1 });
    expect(offsetToLineCol(TEXT, 18)).toMatchObject({ line: 3, column: 1 });
  });

  it("clamps offsets outside the text instead of reporting a phantom line", () => {
    expect(offsetToLineCol(TEXT, -5)).toMatchObject({ line: 1, column: 1 });
    expect(offsetToLineCol(TEXT, 9_999)).toMatchObject({ line: 3, offset: TEXT.length });
  });

  it("round-trips with lineColToOffset", () => {
    for (let offset = 0; offset <= TEXT.length; offset++) {
      const site = offsetToLineCol(TEXT, offset);
      expect(lineColToOffset(TEXT, site.line, site.column)).toBe(offset);
    }
  });
});

describe("jsonErrorSite", () => {
  it("reads the character position older engines report", () => {
    expect(jsonErrorSite(TEXT, "Unexpected token } in JSON at position 12")).toMatchObject({
      line: 2,
      column: 4,
    });
  });

  it("prefers the position over the engine's own line/column, and agrees with it", () => {
    const msg = "Expected ',' or '}' after property value in JSON at position 9 (line 2 column 1)";
    expect(jsonErrorSite(TEXT, msg)).toMatchObject({ line: 2, column: 1, offset: 9 });
  });

  it("falls back to a bare line/column when no position is given", () => {
    expect(jsonErrorSite(TEXT, "bad thing at line 3 column 2")).toMatchObject({
      line: 3,
      column: 2,
      offset: 19,
    });
  });

  it("points an unterminated document at its end", () => {
    expect(jsonErrorSite(TEXT, "Unexpected end of JSON input")).toMatchObject({
      line: 3,
      offset: TEXT.length,
    });
  });

  it("returns nothing when the message says nothing about where", () => {
    expect(jsonErrorSite(TEXT, "something went wrong")).toBeUndefined();
  });
});

describe("describeJsonError", () => {
  it("names the line and column of a real parse failure", () => {
    const text = '{\n  "a": 1,\n  "b" 2\n}';
    let thrown: unknown;
    try {
      JSON.parse(text);
    } catch (e) {
      thrown = e;
    }
    const { message, site } = describeJsonError(text, thrown);
    expect(site).toBeDefined();
    expect(site?.line).toBe(3);
    expect(message).toMatch(/^Line 3, column \d+: /);
    // the engine's own "at position N" tail is not repeated back at the user
    expect(message).not.toMatch(/at position/);
  });

  it("still explains itself when the engine gave no location", () => {
    const { message, site } = describeJsonError("{}", new Error("something went wrong"));
    expect(site).toBeUndefined();
    expect(message).toBe(
      "something went wrong. Fix the JSON syntax — the manifest has to parse before anything can be checked."
    );
  });
});

describe("revisionPairLabel", () => {
  it("orders older → newer past r9, where a string sort flips", () => {
    expect(["r10", "r9"].sort().join(" → ")).toBe("r10 → r9"); // the bug this replaces
    expect(revisionPairLabel([10, 9])).toBe("r9 → r10");
    expect(revisionPairLabel([9, 10])).toBe("r9 → r10");
    expect(revisionPairLabel([2, 100])).toBe("r2 → r100");
  });

  it("sorts an unknown revision last rather than calling it the oldest", () => {
    expect(revisionPairLabel([undefined, 7])).toBe("r7 → r?");
  });
});
