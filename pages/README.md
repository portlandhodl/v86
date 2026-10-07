# GitHub Pages (optional)

Publishes the machine manager as a static site that loads its machines and ISOs from the
image server in [../server](../server/README.md). Nothing outside this directory and
`.github/workflows/pages.yml` depends on it.

- [site.json](site.json): the site's public url, the catalogue url of the image server, the
  images to bundle with the site, and the text and image of link previews. The repository
  variables `V86_SITE_URL` and `V86_CATALOGUE_URL` override it without a commit.
- [build.mjs](build.mjs): copies a release build (`make all`) into `_site/`, adding a
  `<meta name="v86-catalogue">` tag (which `src/browser/machines.js` reads) and Open Graph /
  Twitter card tags.
- **Bundled machines**: the images under `bundle` in `site.json` (each under Pages' 100 MB
  file limit; currently Alpine, 61 MB) are downloaded, checked against their sha256 and
  published with the site. The page tries the image server's catalogue first and falls back
  to the bundled one when the server is unreachable or has nothing ready, so the site works
  before (or without) an image server. Pages serves range requests, so they stream the same way.
- **Moved pages**: the Bitcoin tools (the wallet check and the AnchorWatch recovery check) now
  live in [wasm-bitcoin-tools](https://github.com/portlandhodl/wasm-bitcoin-tools). The pages
  under `moved` in `site.json` are published as redirects to their new addresses.
- Icons: [../icons/](../icons/) holds the favicon (`favicon.svg`) and its PNG renders, used by
  every page and by the web app manifest.
- [og.jpg](og.jpg): the 1200×630 link preview (a baseline JPEG well under 300 KB, which
  WhatsApp needs), rendered from [og-card.html](og-card.html) around a screenshot of a
  booted machine ([terminal.png](terminal.png)).

To publish: Settings → Pages → Source: **GitHub Actions**; the workflow then deploys on every
push to master. The image server must list the Pages origin (`https://<user>.github.io`) in
its `allowed_origins`.

Locally:

```sh
make all build/v86-fallback.wasm
node pages/build.mjs --catalogue http://localhost:8080/catalogue.json
./tools/serve.mjs --root _site --port 8000
```
