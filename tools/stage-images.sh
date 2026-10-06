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

    listing="$(bsdtar -tvf "$iso")"
    for path in $CANDIDATES; do
        if printf '%s\n' "$listing" | grep -q " \(\./\)\?$path\( link to .*\)\?$"; then
            mkdir -p "$IMAGES/$name/$(dirname "$path")"
            bsdtar -xOf "$iso" "$path" > "$IMAGES/$name/$path"
            if [ ! -s "$IMAGES/$name/$path" ]; then
                # a hard link: depending on the libarchive version, the data is streamed
                # under the other name of the pair (e.g. live/vmlinuz-<version>)
                other="$(printf '%s\n' "$listing" | sed -n "s| \(\./\)\?\([^ ]*\) link to \(\./\)\?$path\$|\2|p; s| \(\./\)\?$path link to \(\./\)\?\([^ ]*\)\$|\3|p" | head -n 1)"
                [ -n "$other" ] && bsdtar -xOf "$iso" "$other" > "$IMAGES/$name/$path"
            fi
            echo "  $name/$path ($(du -h "$IMAGES/$name/$path" | cut -f1))"
        fi
    done
done
