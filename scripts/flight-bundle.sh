#!/bin/sh
# Packages every image the stack needs into one checksummed tarball, so the
# spacecraft never pulls from a registry.
#
#   On Earth:     sh scripts/flight-bundle.sh save [omni-flight-bundle.tar]
#   On the craft: sh scripts/flight-bundle.sh load [omni-flight-bundle.tar]
set -eu

cmd="${1:-}"
file="${2:-omni-flight-bundle.tar}"

case "$cmd" in
  save)
    docker compose build web
    docker compose pull --ignore-buildable
    images=$(docker compose config --images | sort -u)
    echo "Bundling:"; echo "$images" | sed 's/^/  /'
    # shellcheck disable=SC2086
    docker save -o "$file" $images
    sha256sum "$file" > "$file.sha256"
    echo "Wrote $file and $file.sha256"
    ;;
  load)
    sha256sum -c "$file.sha256"
    docker load -i "$file"
    ;;
  *)
    echo "usage: $0 save|load [bundle.tar]" >&2
    exit 2
    ;;
esac
