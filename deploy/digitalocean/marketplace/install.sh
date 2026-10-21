#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs once on the Packer build Droplet for the DigitalOcean 1-Click image.
set -eu

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ufw

curl -fsSL https://get.beamhop.dev | sh -s -- --systemd --no-start
systemctl enable beamhop

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3334/tcp
ufw --force enable

install -m 0755 /dev/stdin /usr/local/bin/beamhop-setup-domain <<'EOF'
#!/bin/sh
# Switch this server to its own domain with automatic HTTPS: beamhop-setup-domain relay.example.com
set -eu
[ $# -eq 1 ] || { echo "usage: beamhop-setup-domain <domain>"; exit 2; }
curl -fsSL https://get.beamhop.dev | sh -s -- --systemd --domain "$1"
EOF

install -m 0755 "$(dirname "$0")/99-beamhop-motd" /etc/update-motd.d/99-beamhop
