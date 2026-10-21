# Beamhop on Google Cloud (Compute Engine)

Terraform module: one Container-Optimized OS VM running the Beamhop container, data on a
persistent disk (daily snapshots, 7 kept), a static IP, firewall for 80/443, and — optionally —
Litestream streaming the database to a GCS bucket every second.

```hcl
module "beamhop" {
  source  = "github.com/beamhop/beamhop//deploy/gcp"
  project = "my-project"
  domain  = "relay.example.com"

  # optional
  litestream_bucket = "my-project-beamhop-replica" # continuous database backup
  ssh_source_ranges = ["203.0.113.4/32"]
}

output "ip" { value = module.beamhop.ip }
```

```bash
terraform init && terraform apply          # needs a configured google provider (see example/)
# point relay.example.com (A record) at the `ip` output, then:
$(terraform output -raw setup_logs)        # setup link + claim code
```

**TLS:** GCE VMs never see their public IP on the network card, so Beamhop's automatic detection
would choose proxy mode. The module sets `tls.mode=acme`: Beamhop obtains its own certificate on
port 80 and serves HTTPS on 443. The first certificate arrives once DNS points at the IP.

**Disk:** the startup script formats the disk on first boot and grows the filesystem after you
raise `disk_size_gb`. Destroying the module deletes the disk (snapshots are kept).

**Rebuilt VM / new zone:** with `litestream_bucket` set, an empty disk is restored from the
replica before Beamhop starts. Media files live on the disk; use `blobStorage` with GCS/S3 if
you need them outside the VM (see `docs/operations.md`).

**Updates:** `gcloud compute ssh <vm> -- sudo systemctl restart beamhop` pulls the image tag
again. Pin `image` to a version tag for controlled upgrades.
