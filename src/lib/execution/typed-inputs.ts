/**
 * Typed dependency inputs of a mixed-provider consumer child (PROD-MIX follow-up, round 2).
 *
 * A consumer partition declares inputs by name (`consumer.input`, e.g. `endpoint_db`). The producing child records the value it
 * produced (a plain value, or for a secret a vault reference and a version digest). The consumer's own execution receives:
 *
 *  - a non-secret value as the DEFAULT of a declared OpenTofu variable `zenith_in_<name>` (so it is part of the rendered
 *    configuration and its digest), reachable from a driver as `ctx.input(name)`;
 *  - a secret as the same variable WITHOUT a default: its value is resolved from the vault when the consumer's own plan/apply
 *    session is created, under that operation's own workspace, and reaches only the tofu child's environment
 *    (`TF_VAR_zenith_in_<name>`). It is never in workspace files, a plan view, evidence or an activity result;
 *  - the digest of every consumed input in the consumer's executable semantics (the `configuration` component), so a producer
 *    output that changed after the consumer's plan was reviewed invalidates that approval at dispatch (DUR-B).
 */
import { digest } from "@/lib/controlplane/digest";

export type TypedInputType = "string" | "number" | "boolean" | "resource_id" | "endpoint" | "secret_ref";

export const INPUT_NAME = /^[a-z][a-z0-9_]{0,60}$/;
export const INPUT_VARIABLE_PREFIX = "zenith_in_";
export const inputVariable = (name: string): string => `${INPUT_VARIABLE_PREFIX}${name}`;
export const inputEnvName = (name: string): string => `TF_VAR_${inputVariable(name)}`;

export interface ConsumedInput {
  /** The consumer's declared input name, `[a-z][a-z0-9_]{0,60}`. */
  name: string;
  referenceId: string;
  type: TypedInputType;
  /** `digest({type, value})`, or for a secret `digest({ref, versionDigest})`. */
  valueDigest: string;
  /** Non-secret value; absent for a secret. */
  value?: string | number | boolean;
  /** Secret reference; the value is resolved by the port at the consumer's own dispatch. */
  secret?: { ref: string; versionDigest: string };
}

/** What the consumer's semantics digest binds: names, types and digests, never a value or a secret. */
export interface ConsumedInputSemantics { name: string; type: TypedInputType; valueDigest: string; secretRef?: string; versionDigest?: string }

export function semanticsOfInputs(inputs: readonly ConsumedInput[]): ConsumedInputSemantics[] {
  return [...inputs]
    .map((input) => ({ name: input.name, type: input.type, valueDigest: input.valueDigest, ...(input.secret ? { secretRef: input.secret.ref, versionDigest: input.secret.versionDigest } : {}) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const digestOfInputs = (inputs: readonly ConsumedInput[]): string => digest(semanticsOfInputs(inputs));

/** A producer-side reference this operation's apply must capture an output for. */
export interface ProducerContract { referenceId: string; producerAddress: string; producerOutput: string; type: TypedInputType }

export interface CapturedOutputs {
  workspaceId: string;
  operationId: string;
  planDigest: string;
  /** `tofu output -json` entries; a sensitive entry has no value here. */
  outputs: Readonly<Record<string, { sensitive: boolean; type: unknown; value?: unknown }>>;
  /** Values of sensitive outputs, sealed into the vault by the port and then dropped. */
  sensitive?: Readonly<Record<string, unknown>>;
}

/**
 * The execution-side port of the typed inputs. Platform composition: mixed/typed-inputs.ts. Absent port means no operation
 * produces or consumes typed inputs (every non-mixed operation).
 */
export interface TypedInputsPort {
  /** References this operation produces for consumers (empty for a non-child or a child nobody consumes). */
  producerContract(workspaceId: string, operationId: string): Promise<readonly ProducerContract[]>;
  /** Record the producer's outputs, sealing sensitive ones into the vault. Returns how many references were recorded. */
  capture(input: CapturedOutputs): Promise<{ recorded: number }>;
  /** Inputs this operation consumes (empty for a non-child). Throws when a declared input has no recorded producer output. */
  load(workspaceId: string, operationId: string): Promise<readonly ConsumedInput[]>;
  /** The vault value of a secret input of THIS operation, under this operation's workspace. Refuses a ref that is not one of its inputs. */
  resolveSecret(workspaceId: string, operationId: string, ref: string): Promise<string>;
}
