#!/bin/sh
# Checks that scripts/pack.sh is reproducible and that the archive has the
# layout the installer expects. Run after `npm ci && npm run build`.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

first=$(sh "$root/scripts/pack.sh" "$work/a" | tail -n 1)
second=$(sh "$root/scripts/pack.sh" "$work/b" | tail -n 1)
if [ "$first" != "$second" ]; then
  printf 'Archive is not reproducible:\n  %s\n  %s\n' "$first" "$second" >&2
  exit 1
fi

archive=$(ls "$work"/a/rurout-opencode-*.tar.gz)
version=$(node -p "require('$root/package.json').version")
case "$archive" in
  *"-$version.tar.gz") ;;
  *) printf 'Archive name does not carry version %s: %s\n' "$version" "$archive" >&2; exit 1 ;;
esac

listing=$(tar -tzf "$archive")
for f in index.js package.json; do
  printf '%s\n' "$listing" | grep -qx "$f" || { printf 'Archive is missing %s\n' "$f" >&2; exit 1; }
done
if printf '%s\n' "$listing" | grep -Eq '^/|\.\.|/|\.d\.ts$'; then
  printf '%s\n' 'Archive must hold only flat runtime files.' >&2
  exit 1
fi

tar -xzOf "$archive" package.json | node -e '
const pkg = JSON.parse(require("fs").readFileSync(0, "utf8"));
const expected = process.argv[1];
if (pkg.name !== "rurout-connect" || pkg.version !== expected || pkg.type !== "module" || pkg.main !== "index.js") {
  console.error("Unexpected runtime package.json: " + JSON.stringify(pkg));
  process.exit(1);
}
' "$version"

printf 'ok  %s\n' "$first"
