/**
 * Test fixture: application code that registers a provider's drivers at boot. Its
 * presence is what makes the generator call those drivers "registered" rather
 * than merely "registrable".
 */
import { registerAwsDrivers } from "./providers/aws/drivers";

export const boot = (): void => registerAwsDrivers();
