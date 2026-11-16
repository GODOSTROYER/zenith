import { certificateDriver } from "./certificate";
import { dnsEndpointDriver } from "./dnsendpoint";
import { ingressDriver } from "./ingress";
import { namespaceDriver } from "./namespace";
import { networkPolicyDriver } from "./networkpolicy";

export { certificateDriver, dnsEndpointDriver, ingressDriver, namespaceDriver, networkPolicyDriver };
export const networkDrivers = [namespaceDriver, networkPolicyDriver, ingressDriver, dnsEndpointDriver, certificateDriver];
