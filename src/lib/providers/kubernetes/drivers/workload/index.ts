import { cronJobDriver } from "./cronjob";
import { deploymentDriver } from "./deployment";
import { statefulSetDriver } from "./statefulset";

export { cronJobDriver, deploymentDriver, statefulSetDriver };
export const workloadDrivers = [deploymentDriver, statefulSetDriver, cronJobDriver];
