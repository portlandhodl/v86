# Machine profiles

Each JSON file here describes one machine: the OS images it boots and the virtual
hardware to run them on. The start page (`index.html`) lists the files named in
[index.json](index.json); users can import further profiles in the page (file,
URL, pasted text or drag and drop), which are kept in their browser's
localStorage along with any settings they change.

## Serving the images

For a public deployment, the Docker image server in [../server](../server/README.md)
downloads the ISOs, serves them and generates the catalogue from these profiles.

`index.json` sets `image_base` (relative to itself, `../images/` by default), the
directory that relative image urls are resolved against. `?cdn=<url>` on the page
overrides it, e.g. to serve the HTML from GitHub Pages and the ISOs from elsewhere.

```sh
./tools/stage-images.sh ~/linux-iso/*.iso   # link ISOs into images/, extract kernels
./tools/serve.mjs --wisp --host 127.0.0.1   # range requests + network proxy at /wisp/
```

Images are streamed with HTTP range requests, so a cross-origin image host must
allow them (CORS: `Range` request header, `Content-Range`/`Content-Length` exposed).

## Format

```jsonc
{
    "schema": "v86-machine/1",
    "id": "debian-live-xfce",            // unique; letters, digits, . _ -
    "name": "Debian Live (testing) Xfce",
    "os": {                               // informational, shown in the details
        "family": "Linux", "distro": "debian", "version": "testing",
        "arch": "x86_64", "ui": "graphical"
    },
    "description": "...",
    "notes": "...",                       // e.g. how to prepare the images
    "homepage": "https://...",
    "download": "https://...",            // upstream image, linked from the details
    "icon": { "text": "Db", "color": "#e8366e" },  // optional, otherwise from os.distro

    "machine": {
        "memory_mb": 4096,                // > 3072 needs a browser with wasm memory64
        "vram_mb": 32,
        "acpi": true,                     // needed by kernels that use the io apic
        "boot_order": "cd,hd,fd",         // or a number, see the boot order setting
        "net_device_type": "ne2k",        // ne2k, virtio or none
        "relay_url": "",                  // "" = no network; "wisp://{host}/wisp/" = the
                                          // wisp proxy of tools/serve.mjs on this page's host
        "virtio_gpu": false,              // WebGPU display; implies direct kernel boot
        "floppy_drives": false,           // false: no drives on the floppy controller
        "disable_audio": false
    },

    // cdrom, hda, hdb, fda, fdb, bzimage, initrd, multiboot, state
    // either a url or { "url", "size", "async", "fixed_chunk_size", "use_parts" };
    // cdrom/hda/hdb are streamed (async) by default, the rest downloaded up front
    "media": {
        "cdrom": { "url": "debian-live-testing-amd64-xfce.iso", "size": 4382429184 },
        "bzimage": "debian-live-testing-amd64-xfce/live/vmlinuz",
        "initrd": "debian-live-testing-amd64-xfce/live/initrd.img"
    },
    "cmdline": "boot=live components console=tty0 console=ttyS0",

    "image_base": "https://cdn.example.org/isos/",  // optional, overrides index.json's
    "autotype": { "text": "\n", "delay_ms": 3000 }  // optional keys sent after start
}
```

Only `id`, `name` and `media` are required. Profiles are validated on load (see
`validate_profile` in [src/browser/machines.js](../src/browser/machines.js)).

To add a machine to the served catalogue, drop its JSON file here and list it in
`index.json`.
