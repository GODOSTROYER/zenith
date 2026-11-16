terraform {
  # Tested with OpenTofu 1.12.5. The provider is pinned EXACTLY, the same
  # version Zenith's own workspaces use (src/lib/tofu/providers.ts).
  required_version = ">= 1.6.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "= 9.7.1"
    }
  }
}

# Run this module with YOUR OWN credentials (an admin of the tenancy), once, from a
# workstation or cloud shell: `auth` defaults to your ~/.oci/config profile or to
# the cloud shell's delegation token. Zenith never sees these credentials and this
# module creates no user, no API key and no secret key.
provider "oci" {
  region = var.region
}
