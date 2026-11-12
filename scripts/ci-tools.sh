#!/usr/bin/env bash
# Installs the pinned command-line tools the workflows run (just, wasm-pack, the SpacetimeDB CLI
# and host) into $MR_TOOLS_DIR (default ~/.local/mr-tools); put $MR_TOOLS_DIR/bin on PATH.
# .github/actions/tools caches that directory keyed on this file, so a workflow job downloads a
# release only after a pin here changes. Every archive is checked against its sha256 before it is
# unpacked, and a tool already installed at its pinned version is left alone, so a run on a warm
# directory touches no network. Linux x86_64 only: the pins are that platform's archives.
set -euo pipefail

JUST_VERSION=1.58.0
JUST_SHA256=4a5cc2f53e6f0f8c59092a6cc38291eb729d46a7dd95d3ae582008881b84931d
WASM_PACK_VERSION=0.15.0
WASM_PACK_SHA256=c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a
SPACETIME_VERSION=2.11.0
SPACETIME_SHA256=fe4645f3abc96a5386ebe98879bba0bea2d0bf56ad7612c322e36a7b93ba04d0

if [ "$(uname -sm)" != "Linux x86_64" ]; then
    echo "ci-tools: the pins are Linux x86_64 archives, this is $(uname -sm)" >&2
    exit 1
fi

root="${MR_TOOLS_DIR:-$HOME/.local/mr-tools}"
mkdir -p "$root/bin" "$root/stamp"
tmp="$(mktemp -d)"
trap 'rm -r "$tmp"' EXIT

# Download $1 to $2 and require sha256 $3. curl retries a failed transfer or an HTTP error up to 8
# times with doubling waits (1 s to 128 s, about 4 minutes in all), which outlasts a release-host
# blip; a longer outage is what the cache in front of this script is for.
fetch() {
    curl --fail --silent --show-error --location --connect-timeout 20 --max-time 300 \
        --retry 8 --retry-all-errors --retry-max-time 900 --output "$2" "$1"
    echo "$3  $2" | sha256sum --check --quiet -
}

# A stamp records a version of a tool this script installed into $root.
installed() { [ -e "$root/stamp/$1-$2" ]; }
stamp() { touch "$root/stamp/$1-$2"; }

if ! installed just "$JUST_VERSION"; then
    fetch "https://github.com/casey/just/releases/download/$JUST_VERSION/just-$JUST_VERSION-x86_64-unknown-linux-musl.tar.gz" \
        "$tmp/just.tar.gz" "$JUST_SHA256"
    tar -xzf "$tmp/just.tar.gz" -C "$root/bin" just
    stamp just "$JUST_VERSION"
fi

if ! installed wasm-pack "$WASM_PACK_VERSION"; then
    fetch "https://github.com/rustwasm/wasm-pack/releases/download/v$WASM_PACK_VERSION/wasm-pack-v$WASM_PACK_VERSION-x86_64-unknown-linux-musl.tar.gz" \
        "$tmp/wasm-pack.tar.gz" "$WASM_PACK_SHA256"
    tar -xzf "$tmp/wasm-pack.tar.gz" -C "$root/bin" --strip-components=1 \
        "wasm-pack-v$WASM_PACK_VERSION-x86_64-unknown-linux-musl/wasm-pack"
    stamp wasm-pack "$WASM_PACK_VERSION"
fi

# The release archive holds the CLI and the standalone host. `spacetime start` runs the host that
# sits beside the CLI, so both stay in one directory and `spacetime` is a link to the CLI.
if ! installed spacetime "$SPACETIME_VERSION"; then
    fetch "https://github.com/clockworklabs/SpacetimeDB/releases/download/v$SPACETIME_VERSION/spacetime-x86_64-unknown-linux-gnu.tar.gz" \
        "$tmp/spacetime.tar.gz" "$SPACETIME_SHA256"
    mkdir -p "$root/spacetime"
    tar -xzf "$tmp/spacetime.tar.gz" -C "$root/spacetime"
    ln -sfn ../spacetime/spacetimedb-cli "$root/bin/spacetime"
    stamp spacetime "$SPACETIME_VERSION"
fi

# Checked on every run, warm or cold: a restored directory is trusted only as far as its binaries
# report the pinned versions.
check() {
    local got
    got="$("$root/bin/$1" --version 2>&1)"
    if [[ "$got" != *"$2"* ]]; then
        echo "ci-tools: $root/bin/$1 does not report version $2: $got" >&2
        exit 1
    fi
    echo "ci-tools: $1 $2"
}
check just "$JUST_VERSION"
check wasm-pack "$WASM_PACK_VERSION"
check spacetime "$SPACETIME_VERSION"
