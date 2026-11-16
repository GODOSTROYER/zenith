import { secretDriver } from "./secret";
import { serviceAccountDriver } from "./serviceaccount";

export { secretDriver, serviceAccountDriver };
export const identityDrivers = [serviceAccountDriver, secretDriver];
