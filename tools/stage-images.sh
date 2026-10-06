#!/bin/sh
# Make ISOs available to the machine profiles in profiles/: links each ISO into images/ and
# extracts the kernel and initrd that direct-boot profiles load (to images/<iso name>/).
#
#   ./tools/stage-images.sh ~/linux-iso/*.iso
#
# Needs bsdtar (libarchive-tools). Serve the result with ./tools/serve.mjs (range requests).

set -e

IMAGES="$(dirname "$0")/../images"
mkdir -p "$IMAGES"

# kernels and initrds of the common live media layouts
CANDIDATES="live/vmlinuz live/initrd.img casper/vmlinuz casper/initrd vmlinuz initrd.gz \
boot/vmlinuz-virt boot/initramfs-virt boot/vmlinuz-lts boot/initramfs-lts"

if [ $# -eq 0 ]; then
    echo "usage: $0 path/to/distro.iso..." >&2
    exit 1
fi

for iso in "$@"; do
    iso="$(realpath "$iso")"
    name="$(basename "$iso" .iso)"
    if [ ! "$iso" -ef "$IMAGES/$name.iso" ]; then
        ln -sfn "$iso" "$IMAGES/$name.iso"
        echo "$name.iso -> $iso"
    fi

    listing="$(bsdtar -tf "$iso")"
    for path in $CANDIDATES; do
        if printf '%s\n' "$listing" | grep -qx "\(\./\)\?$path"; then
            mkdir -p "$IMAGES/$name/$(dirname "$path")"
            # -O follows hard links in the ISO, which -x would otherwise leave empty
            bsdtar -xOf "$iso" "$path" > "$IMAGES/$name/$path"
            echo "  $name/$path ($(du -h "$IMAGES/$name/$path" | cut -f1))"
        fi
    done
done
