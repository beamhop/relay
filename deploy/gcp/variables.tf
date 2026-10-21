# SPDX-License-Identifier: AGPL-3.0-or-later

variable "project" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Region for the static IP (must contain zone)."
  type        = string
  default     = "europe-west3"
}

variable "zone" {
  description = "Zone for the VM and its disk."
  type        = string
  default     = "europe-west3-a"
}

variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "beamhop"
}

variable "domain" {
  description = "Domain the relay answers on, e.g. relay.example.com. Point its A record at the `ip` output."
  type        = string
}

variable "acme_email" {
  description = "Optional contact email for the certificate authority."
  type        = string
  default     = ""
}

variable "image" {
  description = "Container image to run."
  type        = string
  default     = "ghcr.io/beamhop/beamhop:latest"
}

variable "machine_type" {
  description = "VM size. e2-small is enough for a small community relay."
  type        = string
  default     = "e2-small"
}

variable "disk_size_gb" {
  description = "Persistent data disk (database + media) in GB."
  type        = number
  default     = 20
}

variable "disk_type" {
  description = "pd-balanced, pd-ssd or pd-standard."
  type        = string
  default     = "pd-balanced"
}

variable "network" {
  description = "VPC network name."
  type        = string
  default     = "default"
}

variable "litestream_bucket" {
  description = "If set, stream the database continuously to this GCS bucket (Litestream sidecar). Created when create_litestream_bucket is true."
  type        = string
  default     = ""
}

variable "create_litestream_bucket" {
  description = "Create the Litestream bucket (otherwise it must already exist)."
  type        = bool
  default     = true
}

variable "litestream_image" {
  description = "Litestream container image."
  type        = string
  default     = "litestream/litestream:0.3.13"
}

variable "ssh_source_ranges" {
  description = "CIDRs allowed to SSH (empty = no SSH firewall rule; use IAP or the console)."
  type        = list(string)
  default     = []
}

variable "labels" {
  description = "Labels added to every resource that supports them."
  type        = map(string)
  default     = {}
}
