/** Regression proof for the local evaluator; this is not an IAM simulator. */
import { describe, expect, it } from "vitest";
import { boundaryAllows } from "./workload-boundary";
import type { Statement } from "./cfn";

const allow: Statement = { Effect: "Allow", Action: "iam:PassRole", Resource: "*" };

describe("boundary evaluator denial semantics", () => {
  it.each([undefined, "lambda.amazonaws.com"])("negated IfExists denies a missing or wrong service: %s", (service) => {
    const deny: Statement = { Effect: "Deny", Action: "iam:*", Resource: "*", Condition: { StringNotEqualsIfExists: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } } };
    const context: Record<string, string> = service === undefined ? {} : { "iam:PassedToService": service };
    expect(boundaryAllows([allow, deny], "iam:PassRole", "*", context)).toBe(false);
    expect(boundaryAllows([deny, allow], "iam:PassRole", "*", { "iam:PassedToService": "ecs-tasks.amazonaws.com" })).toBe(true);
  });
  it("ArnNotLike denies missing and foreign principals even with an Allow", () => {
    const deny: Statement = { Effect: "Deny", Action: "iam:*", Resource: "*", Condition: { ArnNotLike: { "aws:PrincipalArn": "arn:aws:iam::123456789012:role/zenith-*-events" } } };
    const contexts: Record<string, string>[] = [{}, { "aws:PrincipalArn": "arn:aws:iam::123456789012:role/zenith-env-web-role" }];
    for (const context of contexts) expect(boundaryAllows([allow, deny], "iam:PassRole", "*", context)).toBe(false);
  });
  it("throws on unsupported conditions instead of ignoring a Deny", () => {
    const deny: Statement = { Effect: "Deny", Action: "iam:*", Resource: "*", Condition: { UnknownOperator: { unknown: "true" } } };
    expect(() => boundaryAllows([allow, deny], "iam:PassRole", "*")).toThrow("Unsupported boundary condition operator");
  });
});
