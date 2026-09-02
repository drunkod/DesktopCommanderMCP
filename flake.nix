{
  description = "Desktop Commander MCP development and remote-device migration shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
              git
              just
              jq
              ripgrep
              python3
              pkg-config
              gnumake
            ];
            shellHook = ''
              echo "DesktopCommanderMCP dev shell"
              echo "  node: $(node --version)"
              echo "  npm:  $(npm --version)"
              echo "  git:  $(git --version | awk '{print $3}')"
              echo "Useful gates:"
              echo "  just bootstrap   # npm ci"
              echo "  just check       # TypeScript/build"
              echo "  just test        # project regression suite"
              echo "  just integration # integration suite"
            '';
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt-rfc-style
      );
    };
}
