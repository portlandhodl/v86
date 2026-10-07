#!/bin/sh
# Stages Bitcoin Core for examples/bitcoin-wallet-check.html: downloads the official
# x86_64-linux-gnu release, checks it against the pinned SHA256 (from the release's
# SHA256SUMS), and puts bitcoind, bitcoin-cli and bitcoin-wallet in images/bitcoin/
# together with the glibc runtime they need. The guest is Alpine (musl), so the page
# runs the binaries through glibc's own loader; the loader and libraries are copied
# from this machine, which therefore has to be x86_64 glibc Linux.
#
#   ./tools/stage-bitcoin.sh                  # Bitcoin Core 31.1
#   ./tools/stage-bitcoin.sh 30.3 <sha256>    # another release (sha256 of the tarball)
#
# The page fetches images/bitcoin/manifest.json and the files it lists.

set -e

VERSION="${1:-31.1}"
SHA256="${2:-b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e}"
TARBALL="bitcoin-$VERSION-x86_64-linux-gnu.tar.gz"
URL="https://bitcoincore.org/bin/bitcoin-core-$VERSION/$TARBALL"

IMAGES="$(cd "$(dirname "$0")/.." && pwd)/images"
OUT="$IMAGES/bitcoin"
DL="$IMAGES/bitcoin-dl"
mkdir -p "$OUT" "$DL"

if [ ! -f "$DL/$TARBALL" ]; then
    echo "Downloading $URL"
    curl -fL --progress-bar -o "$DL/$TARBALL.part" "$URL"
    mv "$DL/$TARBALL.part" "$DL/$TARBALL"
fi

echo "$SHA256  $DL/$TARBALL" | sha256sum -c -

tar -xzf "$DL/$TARBALL" -C "$DL" "bitcoin-$VERSION/bin/bitcoind" "bitcoin-$VERSION/bin/bitcoin-cli" "bitcoin-$VERSION/bin/bitcoin-wallet"
rm -f "$OUT"/*
for bin in bitcoind bitcoin-cli bitcoin-wallet; do
    cp "$DL/bitcoin-$VERSION/bin/$bin" "$OUT/$bin"
done

# The glibc runtime: the loader named in the ELF interpreter plus every library ldd
# resolves (libc, libm, libpthread, ...).
interp="$(sed -n 's/^.*Requesting program interpreter: \([^]]*\)].*$/\1/p' <<EOF
$(readelf -l "$OUT/bitcoind" 2>/dev/null || true)
EOF
)"
if [ -z "$interp" ]; then
    interp="$(ldd "$OUT/bitcoind" | awk '/ld-linux/ { print $1 }')"
fi
if [ -z "$interp" ] || [ ! -f "$interp" ]; then
    echo "error: cannot find the glibc loader ($interp); the binaries need an x86_64 glibc Linux host" >&2
    exit 1
fi
cp "$interp" "$OUT/$(basename "$interp")"
libs="$(ldd "$OUT/bitcoind" "$OUT/bitcoin-cli" "$OUT/bitcoin-wallet" | awk '/=> \// { print $3 }' | sort -u)"
if printf '%s\n' "$libs" | grep -q 'not found'; then
    echo "error: unresolved libraries:" >&2
    ldd "$OUT/bitcoind" >&2
    exit 1
fi
for lib in $libs; do
    cp "$lib" "$OUT/$(basename "$lib")"
done

# manifest.json: the files, their sizes and sha256 (the page verifies what it fetched)
{
    printf '{\n    "bitcoin_core": "%s",\n    "tarball": "%s",\n    "tarball_sha256": "%s",\n' "$VERSION" "$TARBALL" "$SHA256"
    printf '    "glibc": "%s",\n' "$(ldd --version 2>/dev/null | head -n 1 | sed 's/"/\\"/g')"
    printf '    "loader": "%s",\n    "files": [\n' "$(basename "$interp")"
    first=1
    for f in "$OUT"/*; do
        [ "$(basename "$f")" = manifest.json ] && continue
        [ $first = 1 ] || printf ',\n'
        first=0
        printf '        { "name": "%s", "size": %s, "sha256": "%s" }' \
            "$(basename "$f")" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
    done
    printf '\n    ]\n}\n'
} > "$OUT/manifest.json"

echo "Staged Bitcoin Core $VERSION in $OUT:"
ls -l "$OUT"
