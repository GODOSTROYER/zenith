import { describe, expect, it, vi } from "vitest";
import { PlanChangesTable } from "@/components/platform/plan-changes-table";
import { button, click, headingsDoNotSkip, mount, text } from "./render";
import { planView } from "./fixtures";

describe("<PlanChangesTable>", () => {
  it("groups changes by the Zenith resource they belong to, unmapped ones last", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    const groups = [...el.querySelectorAll("section h4")].map((h) => text(h));
    expect(groups[0]).toContain("resource/db");
    expect(groups[1]).toContain("service/web");
    expect(groups[2]).toContain("Other changes");
    expect(groups[2]).toContain("not linked to one Zenith resource");
  });

  it("names each action in words and marks destructive rows", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    const byAddress = (a: string) => [...el.querySelectorAll("article")].find((x) => text(x).includes(a))!;
    expect(text(byAddress("aws_ecs_service.web"))).toContain("Change");
    expect(text(byAddress("aws_cloudwatch_log_group.app"))).toContain("Create");
    const replace = byAddress("aws_db_instance.main");
    expect(text(replace)).toContain("Replace");
    expect(replace.getAttribute("data-destructive")).toBe("true");
    expect(byAddress("aws_ecs_service.web").getAttribute("data-destructive")).toBeNull();
  });

  it("highlights deletes as destructive too", () => {
    const plan = planView({
      summary: { create: 0, update: 0, delete: 1, replace: 0, noop: 0 },
      resources: [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", action: "delete", destroysData: true, changes: [], omittedChanges: 0 }],
    });
    const el = mount(<PlanChangesTable plan={plan} />);
    expect(el.querySelector('article[data-action="delete"]')?.getAttribute("data-destructive")).toBe("true");
    expect(text(el)).toContain("No attribute details were listed for this change.");
  });

  it("calls out data destruction and names the resources", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    const callout = el.querySelector('[role="alert"]')!;
    expect(text(callout)).toContain("This plan destroys data");
    expect(text(callout)).toContain("aws_db_instance.main");
    expect(text(callout)).toContain("rollback cannot restore");
    expect([...el.querySelectorAll("article")].some((a) => text(a).includes("Destroys data"))).toBe(true);
  });

  it("shows sensitive attributes only as '(sensitive)'", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    const row = [...el.querySelectorAll("tr")].find((r) => text(r).startsWith("password"))!;
    const cells = [...row.querySelectorAll("td")].map(text);
    expect(cells).toEqual(["(sensitive)", "(sensitive)"]);
    // a change whose value the view withheld at a secret-looking path is also '(sensitive)'
    const envRow = [...el.querySelectorAll("tr")].find((r) => text(r).startsWith("environment.DATABASE_PASSWORD"))!;
    expect([...envRow.querySelectorAll("td")].map(text)).toEqual(["(sensitive)", "(sensitive)"]);
  });

  it("never prints a secret value even when one reaches it", () => {
    const plan = planView({
      resources: [
        {
          address: "aws_db_instance.main",
          nodeAddress: "resource/db",
          type: "aws_db_instance",
          action: "update",
          destroysData: false,
          omittedChanges: 0,
          changes: [{ path: "master_password", forcesReplacement: false, before: "hunter2", after: "hunter3", sensitive: true } as never],
        },
      ],
    });
    const el = mount(<PlanChangesTable plan={plan} />);
    expect(text(el)).not.toContain("hunter2");
    expect(text(el)).not.toContain("hunter3");
    expect(text(el)).toContain("(sensitive)");
  });

  it("preserves '(known after apply)' and shows old values", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    const row = [...el.querySelectorAll("tr")].find((r) => text(r).startsWith("task_definition"))!;
    expect([...row.querySelectorAll("td")].map(text)).toEqual(["web:4", "(known after apply)"]);
  });

  it("flags attributes that force replacement", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    const row = [...el.querySelectorAll("tr")].find((r) => text(r).startsWith("engine_version"))!;
    expect(text(row)).toContain("Forces replacement");
    expect(row.getAttribute("data-forces-replacement")).toBe("true");
    const other = [...el.querySelectorAll("tr")].find((r) => text(r).startsWith("desired_count"))!;
    expect(text(other)).not.toContain("Forces replacement");
  });

  it("never leaves a value cell blank", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    for (const td of el.querySelectorAll("tbody td")) expect(text(td).length).toBeGreaterThan(0);
  });

  it("says when attribute changes were left out, and when the whole view was trimmed", () => {
    const el = mount(<PlanChangesTable plan={planView({ truncated: true })} />);
    expect(text(el)).toContain("2 more attribute changes not shown here");
    expect(text(el)).toContain("left out to keep this view short");
  });

  it("summarises the counts and shows the short plan digest", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    expect(text(el)).toContain("1 to create");
    expect(text(el)).toContain("1 to change");
    expect(text(el)).toContain("1 to replace");
    expect(text(el)).toContain("0 to delete");
    expect(text(el)).toContain("2c26b46b68ff…");
  });

  it("lists outputs without values, marking sensitive ones", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    const outputs = el.querySelector('section[aria-labelledby$="-outputs"]')!;
    expect(text(outputs)).toContain("service_url");
    expect(text(outputs)).toContain("db_connection");
    expect(text(outputs)).toContain("(sensitive)");
  });

  it("shows tofu warnings as text", () => {
    const el = mount(<PlanChangesTable plan={planView({ diagnostics: [{ severity: "warning", summary: "Deprecated argument", detail: "Use engine_version instead." }] })} />);
    expect(text(el)).toContain("Warning: Deprecated argument");
    expect(text(el)).toContain("Use engine_version instead.");
  });

  it("renders plan text as text, never as markup", () => {
    const plan = planView({
      resources: [
        {
          address: "aws_x.y",
          type: "aws_x",
          action: "update",
          destroysData: false,
          omittedChanges: 0,
          changes: [{ path: "tags.Name", forcesReplacement: false, before: "<b>bold</b>", after: '<img src=x onerror="window.__xss=1">' }],
        },
      ],
    });
    const el = mount(<PlanChangesTable plan={plan} />);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(text(el)).toContain("<b>bold</b>");
  });

  it("has an empty state for a plan with no changes, and for no plan", () => {
    const none = mount(<PlanChangesTable plan={planView({ empty: true, resources: [], outputs: [] })} />);
    expect(text(none)).toContain("This plan contains no changes");
    const missing = mount(<PlanChangesTable />);
    expect(text(missing)).toContain("No plan yet");
  });

  it("has loading and error states that keep the heading", () => {
    const loading = mount(<PlanChangesTable loading />);
    expect(loading.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(loading.querySelector("h3")?.textContent).toBe("Planned changes");
    const onRetry = vi.fn();
    const failed = mount(<PlanChangesTable error="The plan could not be read." onRetry={onRetry} />);
    expect(text(failed)).toContain("Could not load the plan");
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("gives every table a caption and column headers, and keeps heading order", () => {
    const el = mount(<PlanChangesTable plan={planView()} />);
    for (const table of el.querySelectorAll("table")) {
      expect(table.querySelector("caption")?.textContent?.length).toBeGreaterThan(0);
      expect(table.querySelectorAll('th[scope="col"]').length).toBe(3);
    }
    expect(headingsDoNotSkip(el)).toBe(true);
  });
});
