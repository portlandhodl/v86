#!/usr/bin/env node
// Assembles a static GitHub Pages site in _site/ from a release build (make all), pointing the
// machine manager at the image server named in pages/site.json and adding link previews.
// Nothing else in the repository depends on this directory.
//
//   make all build/v86-fallback.wasm && node pages/build.mjs [--out _site] [--catalogue <url>]

import fs from "node:fs";
import path from "node:path";
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

const escape = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const image_url = new URL(site.image, site_url).href;
const head = [
    `<meta name="v86-catalogue" content="${escape(catalogue)}">`,
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

console.log(`site in ${out}, catalogue ${catalogue}`);
