import type { ResourceDriver } from "@/lib/drivers/types";
import type { OciSession } from "../../transport";
import { identityDriver } from "./identity";
import { logGroupDriver } from "./log-group";
import { vaultSecretDriver } from "./vault-secret";

/** Identity (dynamic group + policy), Vault secret containers, log groups. */
export const platformDrivers: ResourceDriver<OciSession>[] = [identityDriver, vaultSecretDriver, logGroupDriver];
