#!/bin/sh
# Creates a local, self-signed code-signing identity ("VisionCLI Local Signing") in the login keychain.
# With a stable identity, macOS keeps VisionCLI's Screen Recording / Microphone / Speech permissions across
# rebuilds (an ad-hoc signature changes every build, so macOS treats each build as a new app).
# Remove later with: security delete-identity -c "VisionCLI Local Signing"
set -e
NAME="VisionCLI Local Signing"
if security find-certificate -c "$NAME" >/dev/null 2>&1; then echo "Signing identity already exists."; exit 0; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cert.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -out "$TMP/id.p12" -passout pass:visioncli 2>/dev/null
security import "$TMP/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P visioncli -T /usr/bin/codesign >/dev/null
echo "Created signing identity \"$NAME\"."
