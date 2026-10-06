# Image server

Hosts the distribution ISOs for the machine manager (`index.html`) and tells it which
machines are ready to boot. On start it downloads every ISO listed in
[config.json](config.json) into the bound image directory, verifies its checksum and
extracts the kernel and initrd that direct-boot profiles need. It doesn't relay any guest
network traffic.

```sh
cd server
UID=$(id -u) GID=$(id -g) docker compose up -d --build
docker compose logs -f          # download progress
curl localhost:8080/status.json # or watch it here
```

| Endpoint | |
|---|---|
| `GET /catalogue.json` | machines whose images are ready, profiles inline with their sizes |
| `GET /status.json` | download/verify/extract state of every configured distro |
| `GET /images/<file>` | the images, with HTTP range requests (the emulator streams them) |
| `GET /healthz` | liveness |

## Configuration

`config.json` is mounted into the container, so edits apply on `docker compose restart`:

- `public_url`: the https origin the server is reachable at; image urls in the catalogue are
  built from it (if empty, from the request's `Host`/`X-Forwarded-*` headers).
- `allowed_origins`: pages allowed to load the catalogue and images cross-origin (CORS), e.g.
  the GitHub Pages site. `["*"]` allows any.
- `distros`: one entry per machine:
  - `profile`: a file in [../profiles](../profiles/README.md) (also mounted) describing the
    machine; its media urls are relative to the image directory.
  - `iso.url`, `iso.file`: where to download from, and the file name to store it as.
  - `iso.sha256` or `iso.sha256_url` (a `SHA256SUMS`-style file): checksum to verify.
  - `extract`: paths inside the ISO to extract to `<iso name>/<path>`, for profiles that boot
    the kernel directly.
  - `enabled: false` skips a distro.

Environment variables override the file: `PUBLIC_URL`, `ALLOWED_ORIGINS` (comma-separated),
`PORT`, `IMAGE_DIR`, `PROFILES_DIR`. For compose: `IMAGE_DIR` (host directory, default
`./data/images`), `BIND` (default `127.0.0.1`), `PORT` (default `8080`).

Each ISO is downloaded once: a `<file>.verified` marker records the checked hash. To pick up
a new build (Debian's testing image changes weekly), delete the marker and the ISO and
restart. ISOs you already have can be copied into the image directory: they're verified and
used instead of downloaded (copies, not symlinks, which don't resolve inside the container).

## TLS

The container speaks plain HTTP on localhost; terminate TLS in front of it. With Caddy:

```
v86-64.qrsnap.io {
    reverse_proxy 127.0.0.1:8080
}
```

Make sure the proxy passes `Range` requests through and doesn't buffer or compress the
images (Caddy and nginx do the right thing by default for `application/octet-stream`).

Without Docker: `node server/image-server.mjs --config server/config.json` with `IMAGE_DIR`
set (needs `curl` and `bsdtar`).
