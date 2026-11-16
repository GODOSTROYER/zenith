/**
 * Hand-written ECS response shapes for the read/operation tests. They follow
 * the SDK's output types; they are NOT derived from the driver's compile and
 * nothing here has been compared with a real account (contract evidence).
 */
import type { Deployment, Service, Task, TaskDefinition } from "@aws-sdk/client-ecs";
import { CTX_TAGS, zenithTagList } from "./fixtures";

export const ACCOUNT = "123456789012";
export const CLUSTER = "zn-acme-web";
export const SERVICE_NAME = "zn-acme-web";
export const SERVICE_ARN = `arn:aws:ecs:eu-west-1:${ACCOUNT}:service/${CLUSTER}/${SERVICE_NAME}`;
export const CLUSTER_ARN = `arn:aws:ecs:eu-west-1:${ACCOUNT}:cluster/${CLUSTER}`;
export const TD_FAMILY = "zn-acme-web";
export const TD_ARN = `arn:aws:ecs:eu-west-1:${ACCOUNT}:task-definition/${TD_FAMILY}:7`;
export const TG_ARN = `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:targetgroup/zn-acme-tg-web-50e7e9/73e2d6bc24d8a067`;
export const REGISTRY_ARN = `arn:aws:ecr:eu-west-1:${ACCOUNT}:repository/zn-acme-web`;
export const REGISTRY_HOST = `${ACCOUNT}.dkr.ecr.eu-west-1.amazonaws.com`;
export const DIGEST = `sha256:${"d".repeat(64)}`;
export const OLD_DIGEST = `sha256:${"0".repeat(64)}`;
export const IMAGE = `${REGISTRY_HOST}/zn-acme-web@${DIGEST}`;
export const OLD_IMAGE = `${REGISTRY_HOST}/zn-acme-web@${OLD_DIGEST}`;

/** ECS-style (`key`/`value`) tags of the web service. */
export const ecsTags = (address = "container_service/web", extra: Record<string, string> = {}) =>
  Object.entries({ ...CTX_TAGS, "zenith:resource": address, ...extra }).map(([key, value]) => ({ key, value }));

export function deployment(over: Partial<Deployment> = {}): Deployment {
  return { id: "ecs-svc/1111", status: "PRIMARY", rolloutState: "COMPLETED", desiredCount: 2, runningCount: 2, pendingCount: 0, createdAt: new Date("2026-09-30T10:00:00.000Z"), ...over };
}

export function service(over: Partial<Service> = {}): Service {
  return {
    serviceArn: SERVICE_ARN,
    serviceName: SERVICE_NAME,
    clusterArn: CLUSTER_ARN,
    status: "ACTIVE",
    desiredCount: 2,
    runningCount: 2,
    pendingCount: 0,
    launchType: "FARGATE",
    taskDefinition: TD_ARN,
    networkConfiguration: { awsvpcConfiguration: { subnets: ["subnet-a", "subnet-b"], securityGroups: ["sg-1"], assignPublicIp: "DISABLED" } },
    loadBalancers: [{ targetGroupArn: TG_ARN, containerName: "web", containerPort: 8080 }],
    deployments: [deployment()],
    tags: ecsTags(),
    ...over,
  };
}

export function taskDefinition(over: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    taskDefinitionArn: TD_ARN,
    family: TD_FAMILY,
    revision: 7,
    status: "ACTIVE",
    cpu: "512",
    memory: "1024",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    taskRoleArn: `arn:aws:iam::${ACCOUNT}:role/zn-acme-web-task`,
    executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/zn-acme-web-exec`,
    runtimePlatform: { operatingSystemFamily: "LINUX", cpuArchitecture: "X86_64" },
    containerDefinitions: [
      {
        name: "web",
        image: OLD_IMAGE,
        essential: true,
        portMappings: [{ containerPort: 8080, protocol: "tcp" }],
        environment: [{ name: "LOG_LEVEL", value: "info" }],
        secrets: [{ name: "DATABASE_URL", valueFrom: `arn:aws:secretsmanager:eu-west-1:${ACCOUNT}:secret:zn-acme-db-url-AbCdEf` }],
        logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": "/zenith/web", "awslogs-region": "eu-west-1", "awslogs-stream-prefix": "ecs" } },
      },
    ],
    ...over,
  };
}

export function stoppedTask(over: Partial<Task> = {}): Task {
  return { taskArn: `arn:aws:ecs:eu-west-1:${ACCOUNT}:task/${CLUSTER}/${Math.random().toString(16).slice(2, 14)}`, lastStatus: "STOPPED", stopCode: "ServiceSchedulerInitiated", stoppedReason: "Scaling activity initiated by (deployment ecs-svc/1111)", containers: [{ name: "web", exitCode: 0 }], ...over };
}

export const zenithTagsFor = zenithTagList;
