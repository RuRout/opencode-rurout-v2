#!/bin/sh
# Builds the deterministic distribution archive served from https://rurout.ru.
#
# Usage: scripts/pack.sh [output-dir]      (default output-dir: release)
#
# Run `npm ci && npm run build` first. The archive holds the compiled plugin
# (dist/*.js) plus a minimal runtime package.json at its root, which is the
# layout the RuRout installer unpacks into the OpenCode plugins directory.
# The archive is byte-reproducible for a given toolchain: sorted names, fixed
# mtime/owner/mode and `gzip -n`. The sha256 is printed on the last line.
set -eu

LABEL=v2
PLUGIN_NAME=rurout-connect

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$root/release"}
cd "$root"

[ -f dist/index.js ] || { printf '%s\n' 'dist/index.js not found: run npm ci && npm run build first.' >&2; exit 1; }
command -v node >/dev/null || { printf '%s\n' 'node is required.' >&2; exit 1; }

version=$(node -p "require('./package.json').version")
name="rurout-opencode-$LABEL-$version.tar.gz"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp dist/*.js "$stage/"
PLUGIN_NAME=$PLUGIN_NAME node -e '
const pkg = require("./package.json");
const out = { name: process.env.PLUGIN_NAME, version: pkg.version, type: "module", main: "index.js" };
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) out.dependencies = pkg.dependencies;
process.stdout.write(JSON.stringify(out) + "\n");
' > "$stage/package.json"

chmod 644 "$stage"/*
TZ=UTC touch -t 197001010000.00 "$stage"/*

if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  set -- --format=ustar --owner=0 --group=0 --numeric-owner --mtime='1970-01-01 00:00:00 UTC' -cf -
else
  set -- --format ustar --uid 0 --gid 0 --uname '' --gname '' -cf -
fi

mkdir -p "$out"
(
  cd "$stage"
  LC_ALL=C
  export LC_ALL
  for f in *; do set -- "$@" "$f"; done
  COPYFILE_DISABLE=1 tar "$@" | gzip -n -9 > "$out/$name"
)

if command -v sha256sum >/dev/null; then
  sum=$(sha256sum "$out/$name" | awk '{print $1}')
else
  sum=$(shasum -a 256 "$out/$name" | awk '{print $1}')
fi
printf '%s  %s\n' "$sum" "$name"
