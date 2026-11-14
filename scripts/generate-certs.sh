#!/bin/sh
# Creates a mission-local CA and a server certificate for the gateway, with no
# external CA involved. Install data/tls/ca.crt on every crew device once,
# before flight. HTTPS is required for the Phase 4 offline cache: browsers
# only allow service workers on secure origins.
#
#   sh scripts/generate-certs.sh [extra SANs, e.g. DNS:omni-b.local IP:10.0.0.5]
set -eu

dir="${OMNI_TLS_DIR:-./data/tls}"
mkdir -p "$dir"
umask 077

if [ -f "$dir/server.crt" ]; then
  echo "TLS material already exists in $dir; delete it first to reissue." >&2
  exit 1
fi

sans="DNS:omni.local,DNS:localhost,IP:127.0.0.1"
for extra in "$@"; do sans="$sans,$extra"; done

if [ ! -f "$dir/ca.key" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$dir/ca.key"
  openssl req -x509 -new -key "$dir/ca.key" -sha256 -days 3650 \
    -subj "/CN=OMNI Mission Local CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$dir/ca.crt"
fi

openssl ecparam -name prime256v1 -genkey -noout -out "$dir/server.key"
openssl req -new -key "$dir/server.key" -subj "/CN=omni.local" -out "$dir/server.csr"

ext="$dir/server.ext"
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$sans" > "$ext"

# 825 days: the maximum validity Apple platforms accept for TLS server certs.
openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial \
  -sha256 -days 825 -extfile "$ext" -out "$dir/server.crt"

rm -f "$dir/server.csr" "$ext"
# nginx worker reads the key; the directory is mounted read-only into the gateway.
chmod 644 "$dir/server.crt" "$dir/ca.crt"
chmod 640 "$dir/server.key"

echo "Issued $dir/server.crt for: $sans"
echo "Install $dir/ca.crt as a trusted root on each crew device. Keep $dir/ca.key off the LAN."
