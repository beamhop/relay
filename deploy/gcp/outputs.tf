# SPDX-License-Identifier: AGPL-3.0-or-later

output "ip" {
  description = "Static IP. Point the domain's A record here."
  value       = google_compute_address.ip.address
}

output "url" {
  description = "Relay address once DNS points at the IP."
  value       = "wss://${var.domain}"
}

output "admin_url" {
  description = "Admin app. The claim code is in the VM logs (see setup_logs)."
  value       = "https://${var.domain}/admin/"
}

output "setup_logs" {
  description = "Command that shows the setup link and claim code."
  value       = "gcloud compute ssh ${google_compute_instance.vm.name} --zone ${var.zone} --project ${var.project} -- sudo journalctl -u beamhop -n 40 --no-pager"
}

output "instance" {
  description = "VM name."
  value       = google_compute_instance.vm.name
}
