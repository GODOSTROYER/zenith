import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Output } from "@/lib/domain/types";
import { OutputRow } from "@/app/(product)/p/[slug]/deploys/output-row";

const output = (kind: Output["kind"], simulated?: boolean): Output => ({
  key: "result", label: "Provider output", value: "provider-returned-value", kind, simulated,
});

it.each(["connection", "hostname", "text"] as const)("labels a simulated %s output without offering a URL action", (kind) => {
  const markup = renderToStaticMarkup(<OutputRow output={output(kind)} envSimulated={true} />);
  expect(markup).toContain(">simulated</span>");
  expect(markup).not.toContain("<a ");
  expect(markup).toContain("does not identify verified live infrastructure");
});

it("keeps an output's explicit real flag authoritative over the environment fallback", () => {
  const markup = renderToStaticMarkup(<OutputRow output={output("connection", false)} envSimulated={true} />);
  expect(markup).not.toContain(">simulated</span>");
  expect(markup).not.toContain("checking…");
});

it("shows unknown output provenance while the connection is unavailable", () => {
  const markup = renderToStaticMarkup(<OutputRow output={output("text")} envSimulated={undefined} />);
  expect(markup).toContain("checking…");
  expect(markup).not.toContain(">simulated</span>");
});
