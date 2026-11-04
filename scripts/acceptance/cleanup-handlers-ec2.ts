/**
 * Network and compute deleters (EC2 API) for the cleaner, in dependency order:
 * instances and volumes, NAT gateways, VPC endpoints, addresses, internet
 * gateways, route tables, subnets, security groups, VPCs.
 *
 * None of these resources has a name we control (they are named with a `Name`
 * tag, if at all), so the run tag — verified by the cleaner immediately before
 * the call — is the only guard, plus two refusals that do not depend on tags:
 * the default VPC and a default security group are never deleted here (a default
 * security group goes with its VPC).
 *
 * Dependencies the service enforces (an ENI left by a just-deleted load
 * balancer, a NAT gateway still holding an address) surface as
 * `DependencyViolation`/`InvalidIPAddress.InUse`; each delete retries those, and
 * the cleaner makes a second pass over anything that still failed that way.
 *
 * Verified only against `aws-sdk-client-mock`; never against a real account.
 */
import {
  DeleteInternetGatewayCommand,
  DeleteLaunchTemplateCommand,
  DeleteNatGatewayCommand,
  DeleteNetworkInterfaceCommand,
  DeleteRouteTableCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteVolumeCommand,
  DeleteVpcCommand,
  DeleteVpcEndpointsCommand,
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  DetachInternetGatewayCommand,
  DisassociateAddressCommand,
  DisassociateRouteTableCommand,
  EC2Client,
  ReleaseAddressCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { isNotFound, lastSegment, pollUntil, regionOf, retryInUse, type Arn, type Handler, type HandlerCtx } from "./cleanup-util";

const ec2 = (ctx: HandlerCtx, arn: Arn): EC2Client => ctx.access.client(EC2Client, { region: regionOf(arn, ctx) });
const id = (arn: Arn): string => lastSegment(arn.resource);
const isEc2 = (a: Arn, prefix: string): boolean => a.service === "ec2" && a.resource.startsWith(prefix);

/** Describe helper: `undefined` when the service says the resource is gone. */
async function orGone<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
}

const instance: Handler = {
  id: "ec2:instance",
  rank: 95,
  match: (a) => (isEc2(a, "instance/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    const InstanceId = id(arn);
    const state = async () => (await orGone(() => c.send(new DescribeInstancesCommand({ InstanceIds: [InstanceId] }))))?.Reservations?.[0]?.Instances?.[0]?.State?.Name;
    const current = await state();
    if (current === undefined || current === "terminated") return "already_gone";
    if (current !== "shutting-down") await c.send(new TerminateInstancesCommand({ InstanceIds: [InstanceId] }));
    await pollUntil(ctx, `instance ${InstanceId}`, async () => {
      const s = await state();
      return s === undefined || s === "terminated";
    });
    return "deleted";
  },
};

const volume: Handler = {
  id: "ec2:volume",
  rank: 96,
  match: (a) => (isEc2(a, "volume/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    return retryInUse(ctx, `volume ${id(arn)}`, async () => void (await c.send(new DeleteVolumeCommand({ VolumeId: id(arn) }))));
  },
};

const launchTemplate: Handler = {
  id: "ec2:launch-template",
  rank: 97,
  match: (a) => (isEc2(a, "launch-template/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    try {
      await c.send(new DeleteLaunchTemplateCommand({ LaunchTemplateId: id(arn) }));
      return "deleted";
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

const natGateway: Handler = {
  id: "ec2:natgateway",
  rank: 100,
  match: (a) => (isEc2(a, "natgateway/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    const NatGatewayId = id(arn);
    const state = async () => (await orGone(() => c.send(new DescribeNatGatewaysCommand({ NatGatewayIds: [NatGatewayId] }))))?.NatGateways?.[0]?.State;
    const current = await state();
    if (current === undefined || current === "deleted") return "already_gone";
    if (current !== "deleting") await c.send(new DeleteNatGatewayCommand({ NatGatewayId }));
    await pollUntil(ctx, `NAT gateway ${NatGatewayId}`, async () => {
      const s = await state();
      return s === undefined || s === "deleted";
    });
    return "deleted";
  },
};

const vpcEndpoint: Handler = {
  id: "ec2:vpc-endpoint",
  rank: 101,
  match: (a) => (isEc2(a, "vpc-endpoint/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    const out = await orGone(() => c.send(new DeleteVpcEndpointsCommand({ VpcEndpointIds: [id(arn)] })));
    if (out === undefined) return "already_gone";
    const failure = out.Unsuccessful?.[0];
    if (failure) {
      if (/NotFound/i.test(failure.Error?.Code ?? "")) return "already_gone";
      throw new Error(`Deleting VPC endpoint ${id(arn)} failed (${failure.Error?.Code ?? "error"}).`);
    }
    return "deleted";
  },
};

const networkInterface: Handler = {
  id: "ec2:network-interface",
  rank: 105,
  match: (a) => (isEc2(a, "network-interface/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    const eni = (await orGone(() => c.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [id(arn)] }))))?.NetworkInterfaces?.[0];
    if (!eni) return "already_gone";
    // An attached interface belongs to a service (load balancer, NAT gateway, task); it goes when that does.
    if (eni.Attachment?.AttachmentId) return "covered_by_parent";
    return retryInUse(ctx, `network interface ${id(arn)}`, async () => void (await c.send(new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: id(arn) }))));
  },
};

const elasticIp: Handler = {
  id: "ec2:elastic-ip",
  rank: 110,
  match: (a) => (isEc2(a, "elastic-ip/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    const AllocationId = id(arn);
    const address = (await orGone(() => c.send(new DescribeAddressesCommand({ AllocationIds: [AllocationId] }))))?.Addresses?.[0];
    if (!address) return "already_gone";
    if (address.AssociationId && !address.NetworkInterfaceOwnerId) await c.send(new DisassociateAddressCommand({ AssociationId: address.AssociationId }));
    return retryInUse(ctx, `address ${AllocationId}`, async () => void (await c.send(new ReleaseAddressCommand({ AllocationId }))));
  },
};

const internetGateway: Handler = {
  id: "ec2:internet-gateway",
  rank: 120,
  match: (a) => (isEc2(a, "internet-gateway/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    const InternetGatewayId = id(arn);
    const igw = (await orGone(() => c.send(new DescribeInternetGatewaysCommand({ InternetGatewayIds: [InternetGatewayId] }))))?.InternetGateways?.[0];
    if (!igw) return "already_gone";
    for (const att of igw.Attachments ?? []) {
      if (!att.VpcId) continue;
      await retryInUse(ctx, `detaching ${InternetGatewayId}`, async () => void (await c.send(new DetachInternetGatewayCommand({ InternetGatewayId, VpcId: att.VpcId }))));
    }
    return retryInUse(ctx, `internet gateway ${InternetGatewayId}`, async () => void (await c.send(new DeleteInternetGatewayCommand({ InternetGatewayId }))));
  },
};

const routeTable: Handler = {
  id: "ec2:route-table",
  rank: 121,
  match: (a) => (isEc2(a, "route-table/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    const RouteTableId = id(arn);
    const table = (await orGone(() => c.send(new DescribeRouteTablesCommand({ RouteTableIds: [RouteTableId] }))))?.RouteTables?.[0];
    if (!table) return "already_gone";
    // The main route table belongs to its VPC and goes with it.
    if (table.Associations?.some((a) => a.Main)) return "covered_by_parent";
    for (const a of table.Associations ?? []) if (a.RouteTableAssociationId) await c.send(new DisassociateRouteTableCommand({ AssociationId: a.RouteTableAssociationId }));
    return retryInUse(ctx, `route table ${RouteTableId}`, async () => void (await c.send(new DeleteRouteTableCommand({ RouteTableId }))));
  },
};

const subnet: Handler = {
  id: "ec2:subnet",
  rank: 130,
  match: (a) => (isEc2(a, "subnet/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    return retryInUse(ctx, `subnet ${id(arn)}`, async () => void (await c.send(new DeleteSubnetCommand({ SubnetId: id(arn) }))));
  },
};

const securityGroup: Handler = {
  id: "ec2:security-group",
  rank: 140,
  match: (a) => (isEc2(a, "security-group/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    const GroupId = id(arn);
    const group = (await orGone(() => c.send(new DescribeSecurityGroupsCommand({ GroupIds: [GroupId] }))))?.SecurityGroups?.[0];
    if (!group) return "already_gone";
    if (group.GroupName === "default") return "covered_by_parent"; // a VPC's default group goes with the VPC
    // Drop this group's own rules first: groups that reference each other cannot be deleted while either rule stands.
    if ((group.IpPermissions?.length ?? 0) > 0) await c.send(new RevokeSecurityGroupIngressCommand({ GroupId, IpPermissions: group.IpPermissions }));
    if ((group.IpPermissionsEgress?.length ?? 0) > 0) await c.send(new RevokeSecurityGroupEgressCommand({ GroupId, IpPermissions: group.IpPermissionsEgress }));
    return retryInUse(ctx, `security group ${GroupId}`, async () => void (await c.send(new DeleteSecurityGroupCommand({ GroupId }))));
  },
};

const vpc: Handler = {
  id: "ec2:vpc",
  rank: 150,
  match: (a) => (isEc2(a, "vpc/") ? {} : null),
  async remove(ctx, arn) {
    const c = ec2(ctx, arn);
    const VpcId = id(arn);
    const found = (await orGone(() => c.send(new DescribeVpcsCommand({ VpcIds: [VpcId] }))))?.Vpcs?.[0];
    if (!found) return "already_gone";
    if (found.IsDefault) throw new Error(`${VpcId} is the default VPC; the harness never deletes it.`);
    return retryInUse(ctx, `VPC ${VpcId}`, async () => void (await c.send(new DeleteVpcCommand({ VpcId }))));
  },
};

export const EC2_HANDLERS: readonly Handler[] = [instance, volume, launchTemplate, natGateway, vpcEndpoint, networkInterface, elasticIp, internetGateway, routeTable, subnet, securityGroup, vpc];
