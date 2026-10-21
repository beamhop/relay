# SPDX-License-Identifier: AGPL-3.0-or-later
# Beamhop on a Compute Engine VM: Container-Optimized OS running the Beamhop container, data on a
# persistent disk, a static IP, firewall for 80/443, daily disk snapshots, and an optional
# Litestream sidecar that streams the database to a GCS bucket.
#
# TLS: GCE VMs do not see their public IP on the network interface, so automatic detection would
# pick proxy mode. This module therefore sets tls.mode=acme explicitly: Beamhop gets its own
# certificate for var.domain over HTTP-01 on port 80 and serves HTTPS on 443.

locals {
  tag        = "${var.name}-relay"
  litestream = var.litestream_bucket != ""
  labels     = merge({ app = "beamhop" }, var.labels)

  env_file = join("\n", compact([
    "BEAMHOP_DATA_DIR=/data",
    "BEAMHOP_LISTEN=0.0.0.0:3334",
    "BEAMHOP_ACME_HTTP_PORT=3380",
    "BEAMHOP_DOMAIN=${var.domain}",
    "BEAMHOP_NODE__TLS__MODE=acme",
    var.acme_email != "" ? "BEAMHOP_NODE__TLS__EMAIL=${var.acme_email}" : "",
  ]))
}

resource "google_compute_address" "ip" {
  project = var.project
  name    = "${var.name}-ip"
  region  = var.region
}

resource "google_compute_disk" "data" {
  project = var.project
  name    = "${var.name}-data"
  zone    = var.zone
  type    = var.disk_type
  size    = var.disk_size_gb
  labels  = local.labels
}

resource "google_compute_resource_policy" "snapshots" {
  project = var.project
  name    = "${var.name}-daily-snapshots"
  region  = var.region
  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "03:00"
      }
    }
    retention_policy {
      max_retention_days    = 7
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "snapshots" {
  project = var.project
  name    = google_compute_resource_policy.snapshots.name
  disk    = google_compute_disk.data.name
  zone    = var.zone
}

resource "google_service_account" "vm" {
  project      = var.project
  account_id   = "${var.name}-vm"
  display_name = "Beamhop VM"
}

resource "google_project_iam_member" "logs" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project
  role     = each.value
  member   = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_storage_bucket" "litestream" {
  count                       = local.litestream && var.create_litestream_bucket ? 1 : 0
  project                     = var.project
  name                        = var.litestream_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels
  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "litestream" {
  count      = local.litestream ? 1 : 0
  bucket     = var.litestream_bucket
  role       = "roles/storage.objectAdmin"
  member     = "serviceAccount:${google_service_account.vm.email}"
  depends_on = [google_storage_bucket.litestream]
}

resource "google_compute_firewall" "web" {
  project       = var.project
  name          = "${var.name}-web"
  network       = var.network
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.tag]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

resource "google_compute_firewall" "ssh" {
  count         = length(var.ssh_source_ranges) > 0 ? 1 : 0
  project       = var.project
  name          = "${var.name}-ssh"
  network       = var.network
  direction     = "INGRESS"
  source_ranges = var.ssh_source_ranges
  target_tags   = [local.tag]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_instance" "vm" {
  project                   = var.project
  name                      = var.name
  zone                      = var.zone
  machine_type              = var.machine_type
  tags                      = [local.tag]
  labels                    = local.labels
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 10
    }
  }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "beamhop-data"
  }

  network_interface {
    network = var.network
    access_config {
      nat_ip = google_compute_address.ip.address
    }
  }

  metadata = {
    user-data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
      image             = var.image
      env_file          = local.env_file
      litestream        = local.litestream
      litestream_bucket = var.litestream_bucket
      litestream_image  = var.litestream_image
    })
    startup-script = templatefile("${path.module}/startup.sh.tftpl", {
      image            = var.image
      litestream       = local.litestream
      litestream_image = var.litestream_image
    })
    google-logging-enabled = "true"
    enable-oslogin         = "TRUE"
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  depends_on = [google_storage_bucket_iam_member.litestream]
}
