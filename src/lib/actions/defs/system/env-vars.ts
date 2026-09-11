/**
 * system.setEnvVar. Split out of the single-file module; the code is
 * unchanged.
 */
import { z } from "zod";
import { SECRET_KEY_RE } from "@/lib/importers/types";
import {
  clone,
  requireService,
} from "../_shared";
import { manifestAction } from "./shared";
/* --------------------------- env vars and secrets -------------------------- */

const SetEnvVar = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "use letters, digits and underscores, starting with a letter or underscore"),
  /** null removes the variable */
  value: z.string().nullable(),
});
type SetEnvVar = z.infer<typeof SetEnvVar>;

manifestAction<SetEnvVar>({
  id: "system.setEnvVar",
  title: "Set environment variable",
  risk: "low",
  input: SetEnvVar,
  build(project, input) {
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    if (input.value === null) {
      const doomed = service.env.find((e) => e.key === input.key);
      if (!doomed)
        throw new Error(`${service.name} has no variable "${input.key}". Nothing to remove.`);
      service.env = service.env.filter((e) => e.key !== input.key);
      return {
        next,
        what: `Removes ${input.key} from ${service.name}`,
        // Removing the reference does not remove what it points at. Saying so
        // is the difference between a tidy store and an orphan nobody knows about.
        warnings: doomed.secretRef
          ? [
              `This removes the reference ${doomed.secretRef} from the manifest. Any value stored under it stays in Zenith's secret store — use system.removeSecret to take the reference and the value together, which also checks first that nothing else still reads it.`,
            ]
          : [],
        data: { serviceId: service.id },
      };
    }
    if (SECRET_KEY_RE.test(input.key))
      throw new Error(`"${input.key}" looks like a secret, and manifests are exported, diffed and audited. Use system.setSecret instead — it stores a reference and keeps the value out of the manifest.`);

    const existing = service.env.find((e) => e.key === input.key);
    if (existing) {
      existing.value = input.value;
      delete existing.secretRef;
    } else {
      service.env.push({ key: input.key, value: input.value });
    }
    return { next, what: `Sets ${input.key} on ${service.name}`, data: { serviceId: service.id } };
  },
});
