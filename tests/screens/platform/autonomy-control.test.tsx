import { describe, expect, it, vi } from "vitest";
import { AutonomyControl, adminOnlyReason } from "@/components/platform/autonomy-control";
import { AUTONOMY_LEVELS } from "@/components/platform/autonomy-levels";
import type { AutonomyLevel } from "@/lib/policy/types";
import { button, click, describedBy, flush, headingsDoNotSkip, mount, text } from "./render";

const radios = (el: Element) => [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const radio = (el: Element, level: number) => radios(el)[level];

describe("<AutonomyControl>", () => {
  it("offers levels 0 to 5, each with its plain-language meaning", () => {
    const el = mount(<AutonomyControl level={2} viewerRole="admin" onChange={vi.fn()} />);
    expect(radios(el)).toHaveLength(6);
    expect(radios(el).map((r) => r.value)).toEqual(["0", "1", "2", "3", "4", "5"]);
    const labels = AUTONOMY_LEVELS.map((l) => l.name);
    expect(labels).toEqual(["Observe", "Recommend", "Plan with approval", "Safe automatic", "Bounded operations", "Broad autonomy"]);
    for (const l of AUTONOMY_LEVELS) {
      expect(text(el)).toContain(l.name);
      expect(text(el)).toContain(l.summary);
    }
    expect(text(el)).toContain("A person must approve each one before anything changes");
    expect(text(el)).toContain("still need approval");
  });

  it("marks the current level, and checks it", () => {
    const el = mount(<AutonomyControl level={3} viewerRole="admin" onChange={vi.fn()} />);
    expect(radio(el, 3).checked).toBe(true);
    expect(text(el)).toContain("Level 3 · Safe automatic");
    expect([...el.querySelectorAll("label")].filter((l) => text(l).includes("Current"))).toHaveLength(1);
  });

  it("gives every radio an accessible name from its label", () => {
    const el = mount(<AutonomyControl level={0} viewerRole="admin" onChange={vi.fn()} />);
    for (const r of radios(el)) {
      const label = el.querySelector(`label[for="${r.id}"]`);
      expect(label).not.toBeNull();
      expect(text(label!).length).toBeGreaterThan(10);
    }
    expect(el.querySelector("fieldset legend")?.textContent).toBe("Autonomy level");
  });

  it("stages a change instead of applying it on click, and shows what moves", () => {
    const onChange = vi.fn();
    const el = mount(<AutonomyControl level={2} viewerRole="admin" onChange={onChange} />);
    click(radio(el, 4));
    expect(onChange).not.toHaveBeenCalled();
    expect(text(el)).toContain("Change from level 2 to level 4");
    expect(text(el)).toContain("Plan with approval");
    expect(text(el)).toContain("Bounded operations");
    expect(button(el, "Save autonomy level").disabled).toBe(false);
  });

  it("saves the staged level through the callback", async () => {
    const onChange = vi.fn();
    const el = mount(<AutonomyControl level={2} viewerRole="admin" onChange={onChange} />);
    click(radio(el, 5));
    click(button(el, "Save autonomy level"));
    await flush();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(5 as AutonomyLevel);
  });

  it("can discard a staged change", () => {
    const onChange = vi.fn();
    const el = mount(<AutonomyControl level={2} viewerRole="admin" onChange={onChange} />);
    click(radio(el, 5));
    click(button(el, "Discard change"));
    expect(radio(el, 2).checked).toBe(true);
    expect(text(el)).not.toContain("Change from level");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables Save, with a visible reason, until a different level is chosen", () => {
    const el = mount(<AutonomyControl level={2} viewerRole="admin" onChange={vi.fn()} />);
    const save = button(el, "Save autonomy level");
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("title")).toContain("nothing to save");
    expect(describedBy(save)).toBe("Choose a different level to save a change.");
    click(radio(el, 2)); // choosing the current level is not a change
    expect(save.disabled).toBe(true);
  });

  it("warns when raising autonomy in production", () => {
    const el = mount(<AutonomyControl level={2} viewerRole="admin" environmentClass="production" environmentName="Production" onChange={vi.fn()} />);
    click(radio(el, 4));
    expect(text(el)).toContain("This is a production environment");
    expect(text(el)).toContain("without waiting for a person");
    click(radio(el, 1)); // lowering is not warned about
    expect(text(el)).not.toContain("This is a production environment");
  });

  it("is admin-only: everyone else sees the levels disabled with the reason linked", () => {
    for (const role of ["viewer", "editor", "none"] as const) {
      const onChange = vi.fn();
      const el = mount(<AutonomyControl level={2} viewerRole={role} onChange={onChange} />);
      const reason = adminOnlyReason(role)!;
      expect(text(el)).toContain(reason);
      expect(el.querySelector("fieldset")!.disabled).toBe(true);
      expect(describedBy(el.querySelector("fieldset")!)).toBe(reason);
      for (const r of radios(el)) {
        expect(r.disabled).toBe(true);
        expect(describedBy(r)).toBe(reason);
      }
      // no Save button that could never work
      expect(el.querySelectorAll("button")).toHaveLength(0);
      click(radio(el, 5));
      expect(onChange).not.toHaveBeenCalled();
      expect(text(el)).not.toContain("Change from level");
    }
  });

  it("names the role in the reason", () => {
    expect(adminOnlyReason("editor")).toContain("you have the editor role");
    expect(adminOnlyReason("none")).toContain("not a member");
    expect(adminOnlyReason("admin")).toBeUndefined();
  });

  it("says policy can still require approval at any level", () => {
    expect(text(mount(<AutonomyControl level={5} viewerRole="admin" onChange={vi.fn()} />))).toContain("Policy can still require approval at any level");
  });

  it("shows a failed save and keeps the staged choice", async () => {
    const onChange = vi.fn().mockRejectedValue(new Error("Only admins may change autonomy."));
    const el = mount(<AutonomyControl level={2} viewerRole="admin" onChange={onChange} />);
    click(radio(el, 3));
    click(button(el, "Save autonomy level"));
    await flush();
    expect(text(el)).toContain("Only admins may change autonomy.");
    expect(radio(el, 3).checked).toBe(true);
    expect(button(el, "Save autonomy level").disabled).toBe(false);
  });

  it("shows an error from the host", () => {
    expect(text(mount(<AutonomyControl level={2} viewerRole="admin" onChange={vi.fn()} actionError="Saving is unavailable." />))).toContain("Saving is unavailable.");
  });

  it("has loading and error states that keep the heading", () => {
    const loading = mount(<AutonomyControl level={2} viewerRole="admin" onChange={vi.fn()} loading />);
    expect(loading.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(loading.querySelector("h3")?.textContent).toBe("Autonomy");
    expect(loading.querySelectorAll("input")).toHaveLength(0);
    const onRetry = vi.fn();
    const failed = mount(<AutonomyControl level={2} viewerRole="admin" onChange={vi.fn()} error="Could not read the level." onRetry={onRetry} />);
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("keeps heading order", () => {
    expect(headingsDoNotSkip(mount(<AutonomyControl level={2} viewerRole="admin" onChange={vi.fn()} />))).toBe(true);
  });
});
