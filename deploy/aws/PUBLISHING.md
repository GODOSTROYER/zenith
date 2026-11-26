# Publishing the AWS connection template

Zenith's one-click "Connect AWS" button opens a CloudFormation quick-create
link. Quick-create only accepts a template that already lives in Amazon S3, and
`deploy/aws/zenith-connection.cfn.yaml` (about 118 KB) is too large to send
inline. The workflow `.github/workflows/publish-aws-template.yml` publishes it
to a public S3 bucket owned by the Zenith AWS account. Until the setup below is
done the workflow does nothing: its job is skipped unless the three repository
variables in step 5 are set.

Placeholders used below: `BUCKET` (bucket name), `REGION` (its region),
`ACCOUNT_ID` (the Zenith-owned AWS account), `ROLE_NAME` (the publisher role).
`GODOSTROYER/zenith` is the GitHub repository.

## What gets published

- Key: `aws/connection/<sha256 of the template>.yaml`. The key is the content
  hash, so a published URL always serves exactly the bytes that were hashed.
- Written with `put-object --if-none-match '*'`: an existing key is never
  overwritten. If the object already exists the workflow checks its stored
  `sha256` metadata and succeeds without writing.
- Metadata: `sha256` and `git-commit`. Content type: `text/yaml`.
- Before upload the workflow checks the file is under 1 MB and parses as YAML.
  After upload it runs `aws cloudformation validate-template --template-url`.
- The job summary prints the final URL, in the form
  `https://BUCKET.s3.REGION.amazonaws.com/aws/connection/<sha256>.yaml`.

## 1. Create the bucket

In the Zenith-owned account, in `REGION`:

```sh
aws s3api create-bucket --bucket BUCKET --region REGION \
  --create-bucket-configuration LocationConstraint=REGION
aws s3api put-bucket-versioning --bucket BUCKET \
  --versioning-configuration Status=Enabled
```

Omit `--create-bucket-configuration` when `REGION` is `us-east-1`.

S3 Object Lock can only be enabled when the bucket is created
(`--object-lock-enabled-for-bucket` on `create-bucket`). If you want
write-once retention on published templates, decide now; it cannot be added to
this bucket later. It is optional: the workflow's no-overwrite write and the
role's lack of delete permission already prevent replacement through the
pipeline.

Use a dedicated bucket. It holds nothing but public templates.

## 2. Allow public reads on this one bucket

CloudFormation fetches the template from the URL in the quick-create link while
the customer is signed in to their own account, so the object must be readable
anonymously. Turn off Block Public Access for this bucket only, not at the
account level:

```sh
aws s3api put-public-access-block --bucket BUCKET \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
```

ACLs stay blocked; only the bucket policy can grant access. Then attach this
bucket policy, which grants anonymous read on the template prefix only (no
listing, no other prefixes):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadConnectionTemplates",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::BUCKET/aws/connection/*"
    }
  ]
}
```

```sh
aws s3api put-bucket-policy --bucket BUCKET --policy file://bucket-policy.json
```

Keep Block Public Access on at the account level so no other bucket can become
public by accident.

## 3. Create the publisher role (GitHub OIDC, no stored keys)

If the account has no GitHub OIDC provider yet, create it once: provider URL
`https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.

Role `ROLE_NAME` trust policy. It can only be assumed by a job that runs in the
`aws-template-publish` environment of this repository:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:GODOSTROYER/zenith:environment:aws-template-publish"
        }
      }
    }
  ]
}
```

GitHub puts the environment name in `sub` when the job uses an environment, so
a workflow run that has not passed the environment's protection rules cannot
mint a token this role accepts.

Permissions policy. Write and read on the template prefix only, plus template
validation. There is no `s3:DeleteObject`, no `s3:DeleteObjectVersion`, no list
and no bucket-level action. `s3:GetObject` covers `HeadObject`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteAndReadTemplatePrefix",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::BUCKET/aws/connection/*"
    },
    {
      "Sid": "ValidateTemplate",
      "Effect": "Allow",
      "Action": "cloudformation:ValidateTemplate",
      "Resource": "*"
    }
  ]
}
```

`cloudformation:ValidateTemplate` does not support resource-level permissions,
so `"Resource": "*"` is required for that statement. Keep the role's maximum
session duration at one hour (the workflow requests 15 minutes).

## 4. Create the GitHub environment

Repository Settings, Environments, New environment, name exactly
`aws-template-publish`:

- Required reviewers: at least one owner. Every publish waits for approval.
- Deployment branches and tags: Selected branches, `master` only. This keeps a
  dispatch from another branch (which could publish a different template) from
  ever receiving a token.
- No secrets are needed.

## 5. Set the repository variables

Settings, Secrets and variables, Actions, Variables tab (variables, not
secrets; none of these values is sensitive):

| Variable | Value |
| --- | --- |
| `ZENITH_TEMPLATE_BUCKET` | `BUCKET` |
| `ZENITH_TEMPLATE_REGION` | `REGION` |
| `ZENITH_TEMPLATE_PUBLISH_ROLE_ARN` | `arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME` |

All three must be non-empty or the job is skipped.

## 6. Publish and point Zenith at it

Run the workflow from Actions, "Publish AWS template", on `master` (or let the
next push that touches the template trigger it), and approve the environment
prompt. Open the run's job summary and copy the URL it prints.

On the Zenith server set:

```
ZENITH_AWS_CONNECTION_TEMPLATE_URL=https://BUCKET.s3.REGION.amazonaws.com/aws/connection/<sha256>.yaml
```

It must be an `https` S3 object URL with no query string. Restart the server
so it reads the variable. Each template change produces a new URL; update the
variable when you want customers to receive the new template. Older URLs keep
working because objects are never overwritten or deleted.

## Verifying

```sh
curl -sSfI "https://BUCKET.s3.REGION.amazonaws.com/aws/connection/<sha256>.yaml"
curl -sS  "https://BUCKET.s3.REGION.amazonaws.com/aws/connection/<sha256>.yaml" | sha256sum
```

The second command's hash must equal `<sha256>` in the URL.
