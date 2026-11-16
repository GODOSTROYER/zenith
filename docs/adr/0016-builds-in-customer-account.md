# ADR-0016 — Source builds run in the customer's account

Status: accepted (2026-09-30)

## Decision
Building an arbitrary repository executes hostile code. For AWS, builds run
in AWS CodeBuild in the customer's account (ephemeral, isolated, customer-
owned credentials, no Zenith control-plane credentials), from a source
bundle Zenith uploads to the customer's artifact bucket, pushing to the
customer's ECR; the image digest is recorded and verified before deploy.
Kubernetes uses an in-cluster build job; the Zenith-managed provider uses
the existing hosted build runners. The control plane never builds customer
code in its own process.
