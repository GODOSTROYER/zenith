/** Pure input constraints shared by the browser form and AWS bootstrap registration. */
export const BOOTSTRAP_NAME_SUFFIX_PATTERN = /^(-[a-z0-9-]{1,19})?$/;
export const isBootstrapNameSuffix = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 20 && BOOTSTRAP_NAME_SUFFIX_PATTERN.exec(value)?.[0] === value;

/** Current connection registration regions; sovereign runtime remains unsupported. */
export const AWS_CONNECTION_REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-south-1", "ap-southeast-2"] as const;
export const isSupportedAwsConnectionRegion = (value: unknown): value is string =>
  typeof value === "string" && (AWS_CONNECTION_REGIONS as readonly string[]).includes(value);
