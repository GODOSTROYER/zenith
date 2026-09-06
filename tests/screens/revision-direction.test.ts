import { expect, it } from "vitest";
import { orderComparison } from "@/app/(product)/p/[slug]/revisions/order-comparison";
it("preserves the requested environment direction when the source has a newer revision", () => {
  const source = { number: 12 }, target = { number: 9 };
  expect(orderComparison(source, target, true)).toEqual([source, target]);
  expect(orderComparison(source, target, false)).toEqual([target, source]);
});
