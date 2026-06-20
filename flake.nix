{
  description = "beamhop relay: a Bun/TypeScript Nostr relay";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-root.url = "github:srid/flake-root";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      imports = [ inputs.flake-root.flakeModule ];
      perSystem =
        { config, pkgs, ... }:
        {
          devShells.default = pkgs.mkShell {
            name = "beamhop-relay-dev";
            # flake-root publishes $FLAKE_ROOT (srid/flake-root), used instead of $PWD.
            inputsFrom = [ config.flake-root.devShell ];
            packages = with pkgs; [
              bun
              nodejs_24
              postgresql_17
              docker-compose
              git
              jq
              curl
              coreutils
            ];
            shellHook = ''
              export MONOREPO_ROOT="$FLAKE_ROOT"
              export PATH="$PATH:$MONOREPO_ROOT/bin:$MONOREPO_ROOT/node_modules/.bin"
              if [ -f "$MONOREPO_ROOT/.env" ]; then
                set -a
                # shellcheck disable=SC1091
                . "$MONOREPO_ROOT/.env"
                set +a
              fi
            '';
          };
        };
    };
}
