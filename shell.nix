{
  withProviders ? false,
}:

let
  nixpkgs = fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/55bfb4d7437bd4e09ab7cba58a43bd68eb310044.tar.gz";
    sha256 = "02sljlk6abwqsx32nhjmfbm7hki7nvcsg442ldp0yx9f5qz0c5lc";
  };
  pkgs = import nixpkgs { };
  inherit (pkgs) lib;

  nodejs = pkgs.nodejs_24;

  npm = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
    pname = "npm";
    version = "11.16.0";
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/npm/-/npm-${finalAttrs.version}.tgz";
      hash = "sha256-MPwVaXx3EAKHhmXCn0nd3emqhmf6VxmFSy9S080ZIws=";
    };
    nativeBuildInputs = [ pkgs.makeWrapper ];
    installPhase = ''
      mkdir -p $out/lib/node_modules/npm $out/bin
      cp -r . $out/lib/node_modules/npm
      makeWrapper ${lib.getExe nodejs} $out/bin/npm \
        --add-flags $out/lib/node_modules/npm/bin/npm-cli.js
      makeWrapper ${lib.getExe nodejs} $out/bin/npx \
        --add-flags $out/lib/node_modules/npm/bin/npx-cli.js
    '';
  });

  jadxHeadlessMcpJar = pkgs.fetchurl {
    url = "https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar";
    sha256 = "6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75";
  };

  providerPackages = with pkgs; [
    jdk21
    ghidra
    binwalk
    unblob
  ];
in
pkgs.mkShell {
  name = "rea-dev";

  packages =
    with pkgs;
    [
      npm
      nodejs
      python3
      git
    ]
    ++ lib.optionals stdenv.isLinux [
      procps
      util-linux
    ]
    ++ lib.optionals withProviders providerPackages;

  shellHook = ''
    export PATH="$PWD/node_modules/.bin:$PATH"
  ''
  + lib.optionalString withProviders ''
    export JAVA_HOME="${pkgs.jdk21.home}"
    export GHIDRA_INSTALL_DIR="${pkgs.ghidra}/lib/ghidra"
    export REA_JADX_MCP_JAR="${jadxHeadlessMcpJar}"
    export REA_BINWALK_COMMAND="${lib.getExe pkgs.binwalk}"
    export REA_UNBLOB_COMMAND="${lib.getExe pkgs.unblob}"
  ''
  + lib.optionalString (withProviders && pkgs.stdenv.isLinux) ''
    export REA_FIRMWARE_PRLIMIT_COMMAND="${pkgs.util-linux}/bin/prlimit"
  ''
  + ''
    if [ -f package-lock.json ]; then
      if [ ! -f node_modules/.package-lock.json ]; then
        echo "rea: installing locked npm dependencies (npm ci)..."
        npm ci
      elif ! node scripts/check-dependency-install.mjs >/dev/null 2>&1; then
        echo "rea: node_modules is stale, run 'npm ci'"
      fi
    fi
  '';
}
