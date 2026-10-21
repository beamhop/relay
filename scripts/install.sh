#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Beamhop installer.
#
#   curl -fsSL https://get.beamhop.dev | sh
#   curl -fsSL https://get.beamhop.dev | sudo sh -s -- --systemd --domain relay.example.com
#
# Options
#   --version <v>      Install a specific version (default: latest)
#   --prefix <dir>     Install directory (default: /usr/local/bin if writable, else ~/.local/bin)
#   --systemd          Also install a hardened systemd service (needs root)
#   --domain <host>    With --systemd: serve this domain on :443 with automatic certificates
#   --no-start         With --systemd: write the service but do not start it
#   --base-url <url>   Release server (default: https://get.beamhop.dev/releases); file:// works,
#                      which is how air-gapped bundles install (see docs/airgap.md)
#   -h, --help         Show this help
#
# Release layout expected under <base-url>:
#   latest/beamhop-<os>-<arch>   latest/SHA256SUMS   (+ optional beamhop-<os>-<arch>.minisig)
#   v<version>/…                 same files for a pinned version
#
# Signature hook: if BEAMHOP_VERIFY_HOOK is set it is run as
#   "$BEAMHOP_VERIFY_HOOK" <binary> <signature-file-or-empty>
# and must exit 0. Otherwise, if `minisign` is installed and a release public key is known
# (BEAMHOP_MINISIGN_PUBKEY or the built-in key below), the .minisig file is checked.
# BEAMHOP_REQUIRE_SIGNATURE=1 refuses to install when no signature could be checked.
#
# Test/advanced overrides: BEAMHOP_OS, BEAMHOP_ARCH, BEAMHOP_SYSTEMD_DIR, BEAMHOP_ETC_DIR.

set -eu

# Release signing public key (minisign). Empty until release signing keys are published.
BUILTIN_PUBKEY=""

BASE_URL="${BEAMHOP_INSTALL_BASE:-https://get.beamhop.dev/releases}"
VERSION="${BEAMHOP_VERSION:-latest}"
PREFIX="${BEAMHOP_PREFIX:-}"
SYSTEMD=0
START=1
DOMAIN=""
PUBKEY="${BEAMHOP_MINISIGN_PUBKEY:-$BUILTIN_PUBKEY}"
REQUIRE_SIG="${BEAMHOP_REQUIRE_SIGNATURE:-0}"
UNIT_DIR="${BEAMHOP_SYSTEMD_DIR:-/etc/systemd/system}"
ETC_DIR="${BEAMHOP_ETC_DIR:-/etc/beamhop}"

say() { printf '%s\n' "$*"; }
warn() { printf 'beamhop-install: %s\n' "$*" >&2; }
die() {
  printf 'beamhop-install: error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Install Beamhop (Nostr relay + media server).

  curl -fsSL https://get.beamhop.dev | sh
  curl -fsSL https://get.beamhop.dev | sudo sh -s -- --systemd --domain relay.example.com

  --version <v>     Install a specific version (default: latest)
  --prefix <dir>    Install directory (default: /usr/local/bin if writable, else ~/.local/bin)
  --systemd         Also install a hardened systemd service (needs root)
  --domain <host>   With --systemd: serve this domain on :443 with automatic certificates
  --no-start        With --systemd: write the service but do not start it
  --base-url <url>  Release server (file:// works for offline bundles)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --base-url) BASE_URL="${2:?--base-url needs a value}"; shift 2 ;;
    --base-url=*) BASE_URL="${1#*=}"; shift ;;
    --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --systemd) SYSTEMD=1; shift ;;
    --no-start) START=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

BASE_URL="${BASE_URL%/}"

# ── Platform ────────────────────────────────────────────────────────────────
detect_os() {
  if [ -n "${BEAMHOP_OS:-}" ]; then
    say "$BEAMHOP_OS"
    return
  fi
  case "$(uname -s)" in
    Linux) say linux ;;
    Darwin) say darwin ;;
    *) die "this system ($(uname -s)) is not supported by the installer; use Docker instead" ;;
  esac
}

detect_arch() {
  if [ -n "${BEAMHOP_ARCH:-}" ]; then
    say "$BEAMHOP_ARCH"
    return
  fi
  case "$(uname -m)" in
    x86_64 | amd64) say x64 ;;
    aarch64 | arm64) say arm64 ;;
    *) die "this processor ($(uname -m)) is not supported; use Docker instead" ;;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
# Rosetta: prefer the native arm64 build on Apple silicon.
if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ -z "${BEAMHOP_ARCH:-}" ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi
fi
if [ "$OS" = linux ] && [ -z "${BEAMHOP_OS:-}" ] && ldd --version 2>&1 | grep -qi musl; then
  warn "musl-based Linux (e.g. Alpine) detected; the binary needs glibc. Docker is the easiest route."
fi
ASSET="beamhop-${OS}-${ARCH}"

# ── Tools ───────────────────────────────────────────────────────────────────
fetch() { # fetch <url> <dest>
  case "$1" in
    file://*)
      cp "${1#file://}" "$2" 2>/dev/null || return 1
      return 0
      ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    case "$1" in
      https://*) curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1" ;;
      *) curl -fsSL --retry 3 -o "$2" "$1" ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "curl or wget is needed"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "sha256sum, shasum or openssl is needed to verify the download"
  fi
}

# ── Download + verify ───────────────────────────────────────────────────────
case "$VERSION" in
  latest) REL="latest" ;;
  v*) REL="$VERSION" ;;
  *) REL="v$VERSION" ;;
esac
REL_URL="$BASE_URL/$REL"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/beamhop.XXXXXX")" || die "cannot create a temporary directory"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "Downloading Beamhop ($REL, $OS-$ARCH)…"
fetch "$REL_URL/$ASSET" "$TMP/$ASSET" || die "download failed: $REL_URL/$ASSET"
fetch "$REL_URL/SHA256SUMS" "$TMP/SHA256SUMS" || die "download failed: $REL_URL/SHA256SUMS"

EXPECTED="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1; exit }' "$TMP/SHA256SUMS")"
[ -n "$EXPECTED" ] || die "no checksum for $ASSET in SHA256SUMS"
ACTUAL="$(sha256_of "$TMP/$ASSET")"
[ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for $ASSET (expected $EXPECTED, got $ACTUAL); nothing was installed"
say "  checksum ok"

SIG=""
if fetch "$REL_URL/$ASSET.minisig" "$TMP/$ASSET.minisig" 2>/dev/null; then SIG="$TMP/$ASSET.minisig"; fi
SIGNED=0
if [ -n "${BEAMHOP_VERIFY_HOOK:-}" ]; then
  "$BEAMHOP_VERIFY_HOOK" "$TMP/$ASSET" "$SIG" || die "signature check failed; nothing was installed"
  SIGNED=1
elif [ -n "$SIG" ] && [ -n "$PUBKEY" ] && command -v minisign >/dev/null 2>&1; then
  minisign -Vq -m "$TMP/$ASSET" -x "$SIG" -P "$PUBKEY" || die "signature check failed; nothing was installed"
  SIGNED=1
fi
if [ "$SIGNED" = 1 ]; then
  say "  signature ok"
elif [ "$REQUIRE_SIG" = 1 ]; then
  die "BEAMHOP_REQUIRE_SIGNATURE=1 but no signature could be checked (need minisign + public key, or BEAMHOP_VERIFY_HOOK)"
fi

chmod 0755 "$TMP/$ASSET"
NEW_VERSION="$("$TMP/$ASSET" --version 2>/dev/null)" || die "the downloaded binary does not run on this machine"

# ── Install ─────────────────────────────────────────────────────────────────
if [ -z "$PREFIX" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then PREFIX=/usr/local/bin; else PREFIX="$HOME/.local/bin"; fi
fi
if [ "$SYSTEMD" = 1 ]; then
  case "$PREFIX" in
    /home/* | /root* | "$HOME"*) die "--systemd needs a system-wide install; run as root (curl … | sudo sh -s -- --systemd) or pass --prefix /usr/local/bin" ;;
  esac
fi
mkdir -p "$PREFIX" || die "cannot create $PREFIX (try sudo, or --prefix ~/.local/bin)"
[ -w "$PREFIX" ] || die "cannot write to $PREFIX (try sudo, or --prefix ~/.local/bin)"
DEST="$PREFIX/beamhop"
cp "$TMP/$ASSET" "$PREFIX/.beamhop.tmp.$$"
chmod 0755 "$PREFIX/.beamhop.tmp.$$"
mv -f "$PREFIX/.beamhop.tmp.$$" "$DEST"
say "Installed Beamhop $NEW_VERSION to $DEST"

# ── systemd ─────────────────────────────────────────────────────────────────
write_unit() {
  if [ -n "$DOMAIN" ]; then
    LISTEN="0.0.0.0:443"
  else
    LISTEN="0.0.0.0:3334"
  fi
  mkdir -p "$UNIT_DIR" "$ETC_DIR" || die "cannot write $UNIT_DIR / $ETC_DIR (run as root)"
  [ -w "$UNIT_DIR" ] || die "cannot write $UNIT_DIR (run as root)"

  ENV_FILE="$ETC_DIR/beamhop.env"
  if [ ! -f "$ENV_FILE" ]; then
    {
      say "# Beamhop service settings (read by systemd). Most settings live in the admin app."
      say "BEAMHOP_DATA_DIR=/var/lib/beamhop"
      say "BEAMHOP_LISTEN=$LISTEN"
      say "BEAMHOP_ACME_HTTP_PORT=80"
    } >"$ENV_FILE"
  fi
  if [ -n "$DOMAIN" ]; then
    grep -v -e '^BEAMHOP_DOMAIN=' -e '^BEAMHOP_LISTEN=' "$ENV_FILE" >"$ENV_FILE.tmp" || true
    {
      say "BEAMHOP_LISTEN=$LISTEN"
      say "BEAMHOP_DOMAIN=$DOMAIN"
    } >>"$ENV_FILE.tmp"
    mv -f "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  chmod 0640 "$ENV_FILE"

  cat >"$UNIT_DIR/beamhop.service" <<EOF
# Installed by the Beamhop installer. Local changes: systemctl edit beamhop
[Unit]
Description=Beamhop Nostr relay and media server
Documentation=https://beamhop.dev/docs
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$DEST serve
EnvironmentFile=-$ENV_FILE
# Runs as a throwaway system user; data lives in /var/lib/beamhop (StateDirectory).
DynamicUser=yes
StateDirectory=beamhop
StateDirectoryMode=0750
WorkingDirectory=/var/lib/beamhop
Restart=on-failure
RestartSec=2s
TimeoutStopSec=30s
LimitNOFILE=1048576
# Bind :80/:443 without root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
# Sandboxing. MemoryDenyWriteExecute is deliberately absent: the JavaScript JIT needs it.
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
UMask=0027

[Install]
WantedBy=multi-user.target
EOF
  say "Wrote $UNIT_DIR/beamhop.service and $ENV_FILE"

  if [ "$START" = 1 ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    systemctl enable beamhop
    systemctl restart beamhop
    say "Started the beamhop service."
    STARTED=1
  fi
}

STARTED=0
if [ "$SYSTEMD" = 1 ]; then write_unit; fi

# ── Next step ───────────────────────────────────────────────────────────────
say ""
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) say "Note: $PREFIX is not on your PATH. Add it, e.g.: export PATH=\"$PREFIX:\$PATH\"" ;;
esac
if [ "$SYSTEMD" = 1 ]; then
  if [ "$STARTED" = 1 ]; then
    say "Next: open the setup link printed by the service:"
    say "  journalctl -u beamhop -n 30 --no-pager      (or: sudo beamhop claim-code --data-dir /var/lib/beamhop)"
  else
    say "Next: sudo systemctl daemon-reload && sudo systemctl enable --now beamhop"
    say "      then open the setup link from: journalctl -u beamhop -n 30 --no-pager"
  fi
else
  say "Next: run \`beamhop\` and open the URL it prints. That's it."
fi
