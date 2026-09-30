import { describe, expect, it, vi } from "vitest";
import { ResourceStateDetail } from "@/components/platform/resource-state-detail";
import { ResourceStateTable } from "@/components/platform/resource-state-table";
import { button, click, headingsDoNotSkip, mount, text } from "./render";
import { driftReport, node, observation, runtime } from "./fixtures";

const row = (over: Parameters<typeof node>[0] = {}, obs = observation(), rt = runtime()) => ({ node: node(over), observation: obs, runtime: rt });

describe("<ResourceStateDetail>", () => {
  it("shows desired, observed and runtime side by side", () => {
    const el = mount(<ResourceStateDetail row={row()} />);
    const group = el.querySelector('[role="group"][aria-label="Desired, observed and runtime state"]')!;
    const panels = [...group.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"));
    expect(panels).toEqual(["Desired", "Observed", "Runtime"]);
    expect(text(group.querySelector('[aria-label="Desired"]')!)).toContain("Managed by Zenith");
    expect(text(group.querySelector('[aria-label="Observed"]')!)).toContain("Present");
    expect(text(group.querySelector('[aria-label="Runtime"]')!)).toContain("Degraded");
  });

  it("renders an unread attribute as 'Not observed (reason)', never blank and never 'matches'", () => {
    const el = mount(<ResourceStateDetail row={row()} />);
    const cpu = el.querySelector('tr[data-status="not_observed"]')!;
    const rows = [...el.querySelectorAll("tbody tr")];
    const cpuRow = rows.find((r) => text(r.querySelector("th")!) === "cpu")!;
    expect(text(cpuRow)).toContain("Not observed (the connected role is not allowed to read it)");
    expect(cpuRow.getAttribute("data-status")).toBe("not_observed");
    expect(text(cpuRow)).not.toContain("Matches");
    expect(cpu).not.toBeNull();
    // an attribute the observation never included
    const interval = rows.find((r) => text(r.querySelector("th")!) === "health.interval")!;
    expect(text(interval)).toContain("Not observed (the last observation did not include this attribute)");
    expect(text(interval)).toContain("Unknown");
    for (const td of el.querySelectorAll("tbody td")) expect(text(td).length).toBeGreaterThan(0);
  });

  it("marks matching and differing attributes and tallies them", () => {
    const el = mount(<ResourceStateDetail row={row()} />);
    const rows = [...el.querySelectorAll("tbody tr")];
    const at = (name: string) => rows.find((r) => text(r.querySelector("th")!) === name)!;
    expect(text(at("replicas"))).toContain("Matches");
    expect(text(at("image"))).toContain("Differs");
    expect(at("image").getAttribute("data-status")).toBe("differs");
    expect(text(el)).toMatch(/2 match, 1 differ, 3 unknown/);
  });

  it("says when nothing has read the resource, without claiming it is present", () => {
    const el = mount(<ResourceStateDetail row={{ node: node() }} />);
    expect(text(el)).toContain("Not observed yet");
    expect(text(el)).toContain("Runtime not read");
    expect(text(el)).not.toContain("Present");
    for (const r of el.querySelectorAll("tbody tr")) {
      expect(r.getAttribute("data-status")).toBe("not_observed");
      expect(text(r)).toContain("Not observed (nothing has read this resource yet)");
    }
  });

  it("explains a missing resource and does not compare attributes against it", () => {
    const el = mount(<ResourceStateDetail row={row({}, observation({ presence: "missing" }))} />);
    expect(text(el)).toContain("Missing");
    expect(text(el)).toContain("Not observed (the resource does not exist at the provider)");
    expect(text(el)).not.toContain("Matches");
  });

  it("explains an inaccessible resource", () => {
    const el = mount(<ResourceStateDetail row={row({}, observation({ presence: "inaccessible" }))} />);
    expect(text(el)).toContain("Not accessible");
    expect(text(el)).toContain("Not observed (the connected role cannot see this resource)");
  });

  it("labels simulated observation and runtime as simulated", () => {
    const el = mount(<ResourceStateDetail row={row({}, observation({ simulated: true }), runtime({ simulated: true }))} />);
    expect(text(el)).toContain("simulated");
    expect(text(el)).toContain("No real infrastructure was read");
  });

  it("does not show simulated for real data", () => {
    expect(text(mount(<ResourceStateDetail row={row()} />))).not.toContain("simulated");
  });

  it("shows runtime counts and turns signals into sentences", () => {
    const el = mount(<ResourceStateDetail row={row()} />);
    const rt = el.querySelector('[aria-label="Runtime"]')!;
    const counts = Object.fromEntries([...rt.querySelectorAll("dt")].map((dt) => [text(dt), text(dt.nextElementSibling!)]));
    expect(counts).toEqual({ Desired: "3", Running: "2", Pending: "1" });
    expect(text(rt)).toContain("2 load balancer targets are unhealthy.");
    expect(text(rt)).toContain("A task stopped: OutOfMemory.");
    expect(text(rt)).toContain("Crash loop backoff.");
    expect(text(rt)).not.toContain("target_unhealthy");
  });

  it("masks secret-looking attributes on both sides but shows references", () => {
    const n = node({ spec: { db_password: "hunter2-desired", dbSecret: { secretRef: "vault:web/db" } } });
    const o = observation({
      attributes: {
        db_password: { state: "known", value: "hunter2-observed", observedAt: "t" },
        dbSecret: { state: "known", value: { secretRef: "vault:web/db" }, observedAt: "t" },
      },
    });
    const el = mount(<ResourceStateDetail row={{ node: n, observation: o }} />);
    expect(text(el)).not.toContain("hunter2");
    expect(text(el)).toContain("(sensitive)");
    expect(text(el)).toContain("Secret reference vault:web/db");
  });

  it("shows the drift finding and an observation error when present", () => {
    const finding = driftReport().findings[0];
    const el = mount(<ResourceStateDetail row={row({}, observation({ error: "AccessDenied calling DescribeServices" }))} finding={finding} />);
    expect(text(el)).toContain("Drift: Changed");
    expect(text(el)).toContain("The running service uses a different image");
    expect(text(el)).toContain("Reading this resource failed");
    expect(text(el)).toContain("AccessDenied calling DescribeServices");
  });

  it("has empty, loading and error states", () => {
    expect(text(mount(<ResourceStateDetail />))).toContain("Select a resource");
    expect(mount(<ResourceStateDetail loading />).querySelector('[aria-busy="true"]')).not.toBeNull();
    const onRetry = vi.fn();
    const failed = mount(<ResourceStateDetail error="Could not reach the control plane." onRetry={onRetry} />);
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("keeps heading order and labels its table", () => {
    const el = mount(<ResourceStateDetail row={row()} />);
    expect(headingsDoNotSkip(el)).toBe(true);
    expect(el.querySelector("table caption")?.textContent).toContain("service/web");
  });
});

describe("<ResourceStateTable>", () => {
  const rows = [
    row({ address: "service/web" }),
    { node: node({ address: "resource/db", kind: "postgres", nativeType: "aws:rds_instance", ownership: "referenced" }) },
    { node: node({ address: "network/main", kind: "network" }), observation: observation({ address: "network/main", presence: "missing", attributes: {} }) },
  ];

  it("lists desired, observed and runtime per resource", () => {
    const el = mount(<ResourceStateTable rows={rows} />);
    const heads = [...el.querySelectorAll("th")].map(text);
    expect(heads.some((h) => h.startsWith("Desired"))).toBe(true);
    expect(heads.some((h) => h.startsWith("Observed"))).toBe(true);
    expect(heads.some((h) => h.startsWith("Runtime"))).toBe(true);
    expect(el.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("says 'Not observed yet' for a resource nobody has read, never 'Present'", () => {
    const el = mount(<ResourceStateTable rows={rows} />);
    const db = [...el.querySelectorAll("tbody tr")].find((r) => text(r).includes("resource/db"))!;
    expect(text(db)).toContain("Not observed yet");
    expect(text(db)).toContain("Nothing has read it yet.");
    expect(text(db)).toContain("Runtime not read");
    expect(text(db)).not.toContain("Present");
  });

  it("shows how many attributes differ or could not be read", () => {
    const el = mount(<ResourceStateTable rows={rows} />);
    const web = [...el.querySelectorAll("tbody tr")].find((r) => text(r).includes("service/web"))!;
    expect(text(web)).toContain("1 differ");
    expect(text(web)).toContain("3 not observed");
  });

  it("uses words for kind, provider and ownership", () => {
    const el = mount(<ResourceStateTable rows={rows} />);
    expect(text(el)).toContain("Container service · AWS · ap-south-1");
    expect(text(el)).toContain("PostgreSQL database");
    expect(text(el)).toContain("Referenced");
    expect(text(el)).not.toContain("container_service");
    expect(text(el)).not.toContain("aws:ecs_service");
  });

  it("adds a Drift column when a report is supplied, with 'Not checked' for unobserved resources", () => {
    const report = driftReport({ unobserved: ["resource/db"], findings: [driftReport().findings[0]] });
    const el = mount(<ResourceStateTable rows={rows} drift={report} />);
    expect([...el.querySelectorAll("th")].map(text).some((h) => h.startsWith("Drift"))).toBe(true);
    const db = [...el.querySelectorAll("tbody tr")].find((r) => text(r).includes("resource/db"))!;
    expect(text(db)).toContain("Not checked");
    expect(text([...el.querySelectorAll("tbody tr")].find((r) => text(r).includes("service/web"))!)).toContain("Changed · medium");
    expect(text([...el.querySelectorAll("tbody tr")].find((r) => text(r).includes("network/main"))!)).toContain("No drift reported");
  });

  it("has no Drift column without a report", () => {
    const el = mount(<ResourceStateTable rows={rows} />);
    expect([...el.querySelectorAll("th")].map(text).some((h) => h.startsWith("Drift"))).toBe(false);
  });

  it("labels the table as simulated when any state is", () => {
    const sim = mount(<ResourceStateTable rows={[row({}, observation({ simulated: true }))]} />);
    expect(text(sim)).toContain("simulated");
    expect(text(mount(<ResourceStateTable rows={rows} />))).not.toContain("simulated");
  });

  it("selects a row with the mouse and the keyboard", () => {
    const onSelect = vi.fn();
    const el = mount(<ResourceStateTable rows={rows} onSelect={onSelect} selectedAddress="service/web" />);
    const db = [...el.querySelectorAll<HTMLElement>("tbody tr")].find((r) => text(r).includes("resource/db"))!;
    click(db);
    expect(onSelect).toHaveBeenCalledWith("resource/db");
    const selected = el.querySelector('tr[aria-current="true"]');
    expect(text(selected!)).toContain("service/web");
  });

  it("has empty, loading and error states", () => {
    expect(text(mount(<ResourceStateTable rows={[]} />))).toContain("No resources in this environment yet");
    expect(mount(<ResourceStateTable rows={[]} loading />).querySelector('[aria-busy="true"]')).not.toBeNull();
    const onRetry = vi.fn();
    const failed = mount(<ResourceStateTable rows={[]} error="Resource state is unavailable." onRetry={onRetry} />);
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("names its table and keeps heading order", () => {
    const el = mount(<ResourceStateTable rows={rows} />);
    expect(el.querySelector("table caption")?.textContent).toContain("desired, observed and runtime state per resource");
    expect(headingsDoNotSkip(el)).toBe(true);
  });
});
