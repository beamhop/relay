# Air-gapped install

For networks with no internet access. You build one file on a connected machine, carry it
across, check it, install. Updates work the same way. Nothing in this setup calls out.

## 1. Build the bundle (connected machine)

```bash
bun install
bun scripts/release.ts --version 1.4.0 --target linux-x64,linux-arm64      # or download a release
bun scripts/airgap-bundle.ts --version 1.4.0 --release-dir dist/release/v1.4.0
```

You get `dist/airgap/beamhop-airgap-1.4.0.tar.gz` plus `.sha256` (and `.minisig` when
`MINISIGN_KEY_FILE` is set). It contains:

| Folder | What |
|---|---|
| `releases/` | Beamhop for each chosen CPU, `SHA256SUMS`, and `latest.json` for updates |
| `web/` | admin app and team client builds |
| `plugins/` | plugin catalog snapshot (+ packages with `--plugins-dir`) |
| `litestream/` | how to add Litestream for backups/HA (third-party; add with `--litestream-dir`) |
| `config/beamhop.yaml` | settings for a closed network (see below) |
| `docs/`, `ha/`, `install.sh` | these docs, the standby kit, the installer |

## 2. Check and install (server)

```bash
minisign -Vm beamhop-airgap-1.4.0.tar.gz -P <release public key>    # if signed
sha256sum -c beamhop-airgap-1.4.0.tar.gz.sha256

sudo mkdir -p /opt/beamhop/bundle
sudo tar xzf beamhop-airgap-1.4.0.tar.gz -C /opt/beamhop/bundle --strip-components=1
cd /opt/beamhop/bundle && sha256sum -c SHA256SUMS

sudo sh install.sh --base-url file:///opt/beamhop/bundle/releases --systemd --no-start
sudo cp config/beamhop.yaml /var/lib/beamhop/beamhop.yaml          # review first
sudo systemctl enable --now beamhop
journalctl -u beamhop -n 30                                          # setup link + claim code
```

The bundle expects to live in `/opt/beamhop/bundle`. Somewhere else? Build it with
`--base-url file:///your/path`.

## 3. Settings for a closed network

`config/beamhop.yaml` sets:

- **Certificates:** automatic certificates (ACME) are off — `node.tls.mode: proxy`. Terminate TLS
  with your internal CA at your reverse proxy (or use `off` for plain HTTP inside the network).
- **Updates:** `modules.updates.manifestUrl` points at the bundle, so `beamhop update` and the
  admin app's update button read the extracted bundle instead of the internet.
- **Plugins:** the catalog is the snapshot in `plugins/catalog.json`.
- **AI assistant** (optional, off): `ai.baseUrl` points at an Ollama server on your network.
- **Alerts:** web push and chat webhooks need the internet; use email via your SMTP relay or
  Nostr DMs to an internal relay.
- Per relay, consider `blossom.mirror: false` so nothing tries to fetch media from outside.

## 4. Update

Build and carry a newer bundle, check it the same way, then:

```bash
sudo rm -rf /opt/beamhop/bundle && sudo mkdir -p /opt/beamhop/bundle
sudo tar xzf beamhop-airgap-1.5.0.tar.gz -C /opt/beamhop/bundle --strip-components=1
sudo beamhop update --manifest file:///opt/beamhop/bundle/releases/latest.json
sudo systemctl restart beamhop          # `sudo beamhop rollback` if anything looks wrong
```

`beamhop update` checks the SHA-256 of the new binary, test-runs it, keeps the old one for
rollback, and only then swaps it in.
