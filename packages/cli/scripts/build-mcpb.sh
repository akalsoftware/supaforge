#!/usr/bin/env bash
# Build a Claude Desktop extension (.mcpb) of a published SupaForge version
# for one platform, with that platform's DBDiff binary inside.
#
#   scripts/build-mcpb.sh <version> <os>-<cpu> [out-dir]
#   scripts/build-mcpb.sh 0.0.33 darwin-arm64 dist-mcpb
#
# One bundle per platform: @dbdiff/cli resolves a native binary per OS and
# CPU, and a bundle carrying all of them would be eight times the size.
set -euo pipefail

version="${1:?usage: $0 <version> <os>-<cpu> [out-dir]}"
platform="${2:?usage: $0 <version> <os>-<cpu> [out-dir]}"
out="$(mkdir -p "${3:-dist-mcpb}" && cd "${3:-dist-mcpb}" && pwd)"
os="${platform%-*}"; cpu="${platform#*-}"
here="$(cd "$(dirname "$0")/.." && pwd)"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/server"
sed -e "s/__VERSION__/$version/" -e "s/__OS__/$os/" "$here/mcpb/manifest.template.json" > "$work/manifest.json"
cp "$here/LICENSE" "$work/LICENSE"

(cd "$work/server" && echo '{"private":true}' > package.json \
  && npm install --omit=dev --no-audit --no-fund --loglevel=error --os="$os" --cpu="$cpu" "@akal/supaforge@$version")

bin="$work/server/node_modules/@dbdiff/cli-$platform"
[ -d "$bin" ] || { echo "no DBDiff binary package for $platform" >&2; exit 1; }

npx --yes @anthropic-ai/mcpb@2 validate "$work/manifest.json"
npx --yes @anthropic-ai/mcpb@2 pack "$work" "$out/supaforge-$version-$platform.mcpb"
