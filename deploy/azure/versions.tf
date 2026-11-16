terraform {
  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      # The provider Zenith pins for the environments it deploys (src/lib/tofu/providers.ts).
      version = ">= 5.7.0, < 6.0.0"
    }
  }
}
