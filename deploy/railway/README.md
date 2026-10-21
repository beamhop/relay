# Beamhop on Railway

1. **New project → Deploy from GitHub repo** (your fork of Beamhop), or use the template button
   in the main README.
2. Service **Settings → Config-as-code path**: `deploy/railway/railway.json`.
3. **Add a volume** to the service, mount path `/data`.
4. **Variables**:

   | Variable | Value |
   |---|---|
   | `BEAMHOP_DATA_DIR` | `/data` |
   | `BEAMHOP_LISTEN` | `0.0.0.0:3334` |
   | `PORT` | `3334` (tells Railway where to send traffic) |
   | `BEAMHOP_NODE__TLS__MODE` | `proxy` |
   | `BEAMHOP_NODE__TRUST_PROXY` | `true` |

5. **Networking → Generate domain** (or add your own). Open the deploy logs for the setup link
   and claim code.

Railway terminates HTTPS and forwards plain HTTP, so Beamhop runs in proxy mode. Keep one
replica: the database is a single SQLite file on the volume. To skip the build, set the
service source to the image `ghcr.io/beamhop/beamhop:latest` instead of the repo.
