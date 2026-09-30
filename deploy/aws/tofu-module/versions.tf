terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # >= 6 for data.aws_region.current.region and the optional OIDC thumbprint list.
      version = ">= 6.0"
    }
  }
}
