#!/usr/bin/env node
// Assembles a static GitHub Pages site in _site/ from a release build (make all), pointing the
// machine manager at the image server named in pages/site.json and adding link previews.
// Nothing else in the repository depends on this directory.
//
// The images listed under "bundle" (small enough for Pages: < 100 MB per file) are downloaded,
// verified and published with the site, as a fallback catalogue used while the image server is
// unreachable.
//
//   make all build/v86-fallback.wasm && node pages/build.mjs [--out _site] [--catalogue <url>]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const args = process.argv.slice(2);
const arg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};

const site = JSON.parse(fs.readFileSync(path.join(here, "site.json"), "utf8"));
const out = path.resolve(arg("--out", path.join(root, "_site")));
const catalogue = arg("--catalogue", process.env.V86_CATALOGUE_URL || site.catalogue_url);
const site_url = (process.env.V86_SITE_URL || site.site_url).replace(/\/?$/, "/");

const FILES = [
    "v86.css",
    "build/v86_all.js",
    "build/v86.wasm",
    "build/v86-mem64.wasm",
    "build/v86-fallback.wasm",
    "build/xterm.js",
    "bios/seabios.bin",
    "bios/vgabios.bin",
];
const REQUIRED = new Set(["v86.css", "build/v86_all.js", "build/v86.wasm", "bios/seabios.bin", "bios/vgabios.bin"]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for(const file of FILES)
{
    const src = path.join(root, file);
    if(!fs.existsSync(src))
    {
        if(REQUIRED.has(file)) throw new Error(`${file} is missing: run make all first`);
        console.warn(`skipping ${file} (not built)`);
        continue;
    }
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.copyFileSync(src, path.join(out, file));
}
const has_image = fs.existsSync(path.join(here, site.image));
if(has_image) fs.copyFileSync(path.join(here, site.image), path.join(out, site.image));
else console.warn(`pages/${site.image} is missing: no preview image`);
// serve files starting with an underscore as they are
fs.writeFileSync(path.join(out, ".nojekyll"), "");

// bundled images: downloaded once into pages/.cache, verified on every build
const cache = path.join(here, ".cache");
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const bundled_profiles = [];
for(const item of site.bundle || [])
{
    const cached = path.join(cache, item.file);
    if(!fs.existsSync(cached) || sha256(cached) !== item.sha256)
    {
        console.log(`downloading ${item.url}`);
        const response = await fetch(item.url);
        if(!response.ok) throw new Error(`${item.url}: HTTP ${response.status}`);
        fs.mkdirSync(cache, { recursive: true });
        fs.writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
        const actual = sha256(cached);
        if(actual !== item.sha256)
        {
            fs.rmSync(cached);
            throw new Error(`${item.file}: checksum mismatch (expected ${item.sha256}, got ${actual})`);
        }
    }
    if(fs.statSync(cached).size >= 100 * 1024 * 1024) throw new Error(`${item.file}: too large for GitHub Pages`);
    fs.mkdirSync(path.join(out, "images"), { recursive: true });
    fs.copyFileSync(cached, path.join(out, "images", item.file));
    fs.mkdirSync(path.join(out, "profiles"), { recursive: true });
    fs.copyFileSync(path.join(root, "profiles", item.profile), path.join(out, "profiles", item.profile));
    bundled_profiles.push(item.profile);
}
if(bundled_profiles.length)
{
    const index = { schema: "v86-machine-catalogue/1", image_base: "../images/", profiles: bundled_profiles };
    fs.writeFileSync(path.join(out, "profiles", "index.json"), JSON.stringify(index, null, 4) + "\n");
}
// the image server first, the bundled machines while it's unreachable
const catalogues = [catalogue, ...(bundled_profiles.length ? ["profiles/index.json"] : [])].filter(Boolean);

const escape = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const image_url = new URL(site.image, site_url).href;
const head = [
    `<meta name="v86-catalogue" content="${escape(catalogues.join(" "))}">`,
    `<link rel="canonical" href="${escape(site_url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="v86_64">`,
    `<meta property="og:url" content="${escape(site_url)}">`,
    `<meta property="og:title" content="${escape(site.title)}">`,
    `<meta property="og:description" content="${escape(site.description)}">`,
    ...(has_image ? [
        `<meta property="og:image" content="${escape(image_url)}">`,
        `<meta property="og:image:width" content="1200">`,
        `<meta property="og:image:height" content="630">`,
        `<meta property="og:image:alt" content="${escape(site.image_alt)}">`,
        `<meta name="twitter:image" content="${escape(image_url)}">`,
    ] : []),
    `<meta name="twitter:card" content="${has_image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escape(site.title)}">`,
    `<meta name="twitter:description" content="${escape(site.description)}">`,
    `<meta name="theme-color" content="#04070a">`,
].join("\n");

let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
if(!html.includes('<link rel="manifest"')) throw new Error("index.html: no manifest link to insert the meta tags before");
html = html
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escape(site.description)}">`)
    .replace('<link rel="manifest"', head + "\n\n<link rel=\"manifest\"");
fs.writeFileSync(path.join(out, "index.html"), html);

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
manifest.start_url = "./";
manifest.icons = [];
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 4) + "\n");

console.log(`site in ${out}, catalogues: ${catalogues.join(", ")}`);
