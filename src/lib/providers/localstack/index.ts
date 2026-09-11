/**
 * The adapter lives in `provider.ts` and its parts in the sibling modules;
 * this keeps `@/lib/providers/localstack` resolving.
 */
export { LOCALSTACK_ENDPOINT } from "./clients";
export { teardownIntent, type TeardownIntent } from "./teardown";
export { localstackProvider } from "./provider";
