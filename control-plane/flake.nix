{
  description = "Remote Desktop Commander + Jazz MVP development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
              pnpm
              git
              jq
              curl
              openssl
              sqlite
              cloudflared
              just
              python3
              pkg-config
              cmake
              gnumake
              nixfmt-rfc-style
            ];

            shellHook = ''
              export REMOTE_MCP_ROOT="$PWD"
              export PNPM_HOME="$PWD/.pnpm-home"
              export PATH="$PNPM_HOME:$PATH"
              echo "RemoteMCP-Jazz dev shell"
              echo "  node: $(node --version)"
              echo "  pnpm: $(pnpm --version)"
              echo "  next: just bootstrap"
            '';
          };
        });

      formatter = forAllSystems (system:
        (import nixpkgs { inherit system; }).nixfmt-rfc-style);
    };
}
