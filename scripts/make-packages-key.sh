#!/bin/sh
# Makes the dedicated key that signs the apt and dnf repositories on https://visioncli.thethirdsourcers.com
# (ed25519, no expiry, in a throwaway keyring: it never touches yours), then prints the `gh secret set` commands
# that hand it to the site workflow. It runs nothing against GitHub: read the commands, then run them yourself.
#   sh scripts/make-packages-key.sh [output-dir]      (default ./packages-key; keep it somewhere safe, offline)
set -eu
OUT=${1:-packages-key}
NAME="VisionCLI packages"
EMAIL=visioncli@thethirdsourcers.com
if [ -e "$OUT/private.asc" ]; then echo "$OUT/private.asc already exists; not overwriting it." >&2; exit 1; fi
mkdir -p "$OUT"
chmod 700 "$OUT"
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT

printf 'Passphrase for the signing key (empty for none; CI then needs no PACKAGES_GPG_PASSPHRASE): '
stty -echo 2>/dev/null || true
read -r PASS
stty echo 2>/dev/null || true
echo
# The passphrase goes in on stdin, never on a command line (ps would show it).
printf '%s' "$PASS" | gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 \
  --quick-generate-key "$NAME <$EMAIL>" ed25519 sign never
FPR=$(gpg --batch --list-secret-keys --with-colons | awk -F: '/^fpr/ { print $10; exit }')
gpg --batch --armor --export "$FPR" > "$OUT/public.key"
printf '%s' "$PASS" | gpg --batch --pinentry-mode loopback --passphrase-fd 0 --armor --export-secret-keys "$FPR" > "$OUT/private.asc"
chmod 600 "$OUT/private.asc"
[ -n "$PASS" ] && { printf '%s' "$PASS" > "$OUT/passphrase"; chmod 600 "$OUT/passphrase"; }

echo
echo "Key $FPR written to $OUT/ (private.asc is the secret: back it up offline, never commit it)."
echo "Hand it to GitHub Actions with:"
echo
echo "  gh secret set PACKAGES_GPG_PRIVATE_KEY -R thethirdsourcers/visioncli < $OUT/private.asc"
[ -n "$PASS" ] && echo "  gh secret set PACKAGES_GPG_PASSPHRASE -R thethirdsourcers/visioncli < $OUT/passphrase"
echo
[ -n "$PASS" ] && echo "Then delete $OUT/passphrase if you keep the passphrase elsewhere."
echo "The site publishes the public key (public.key) itself."
