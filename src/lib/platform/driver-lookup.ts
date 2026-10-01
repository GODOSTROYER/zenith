/** AWS's published local references include attributes of secondary resources. */
import { findDriver } from "@/lib/drivers/types";
import type { DriverLookup } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { refLocalName } from "@/lib/providers/aws/drivers/shared/refs";

export const platformDriverLookup: DriverLookup = (provider, nativeType) => {
  const driver = findDriver(provider, nativeType);
  if (!driver?.compile || provider !== "aws") return driver;
  return { ...driver, compile(node, ctx) {
    return driver.compile!(node, { ...ctx, ref(address, attribute) {
      const target = ctx.node(address);
      if (!target || target.provider !== "aws" || target.ownership === "external") throw new StepFailedError("AWS driver reference has no executable target.");
      if (!/^[A-Za-z0-9_:/.-]+$/.test(attribute)) throw new StepFailedError("AWS driver requested an invalid reference attribute.");
      return `\${local.${refLocalName(address, attribute)}}`;
    } });
  } };
};
