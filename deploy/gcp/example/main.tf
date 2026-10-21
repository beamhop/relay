# SPDX-License-Identifier: AGPL-3.0-or-later
# terraform init && terraform apply -var project=my-project -var domain=relay.example.com

variable "project" {
  type = string
}

variable "domain" {
  type = string
}

provider "google" {
  project = var.project
}

module "beamhop" {
  source  = "../"
  project = var.project
  domain  = var.domain
}

output "ip" {
  value = module.beamhop.ip
}

output "setup_logs" {
  value = module.beamhop.setup_logs
}
