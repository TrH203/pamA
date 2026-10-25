#!/usr/bin/env bash
# `scripts/sign.sh <identifier> <path>…` — sign binaries/bundles with a stable local identity.
# Why: the macOS keychain ties "Always Allow" to the code signature. Cargo's ad-hoc signature
# changes on every build, so the prompt came back each time. A fixed certificate plus a fixed
# identifier keeps the grant across rebuilds. The certificate is created once, locally, in the
# login keychain (self-signed, never leaves this machine). No-op on non-macOS.
set -euo pipefail
[ "$(uname)" = "Darwin" ] || exit 0

IDENTITY="pama-local-signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
ID="${1:?usage: sign.sh <identifier> <path>…}"
shift

if ! security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "→ creating local code-signing certificate '$IDENTITY' (one time)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cat > "$tmp/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$tmp/openssl.cnf" \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
  pass="$(uuidgen)"
  # OpenSSL 3 needs -legacy for a PKCS#12 that macOS `security import` can verify.
  openssl pkcs12 -export -legacy -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/id.p12" \
    -passout "pass:$pass" 2>/dev/null ||
    openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/id.p12" \
      -passout "pass:$pass"
  security import "$tmp/id.p12" -k "$KEYCHAIN" -P "$pass" -T /usr/bin/codesign >/dev/null
fi

for p in "$@"; do
  [ -e "$p" ] || continue
  codesign --force --sign "$IDENTITY" --identifier "$ID" "$p"
done
