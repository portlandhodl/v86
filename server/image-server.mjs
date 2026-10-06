#!/usr/bin/env node
// Image server for the machine manager: downloads the distribution ISOs listed in the config
// file into the image directory (verifying their checksums and extracting the kernels that
// direct-boot profiles need), serves them with HTTP range requests and CORS, and reports the
// machines whose images are ready as a catalogue that index.html can load.
//
//   node server/image-server.mjs [--config server/config.json]
//
//   GET /catalogue.json   machines ready to boot (profiles inline, sizes filled in)
//   GET /status.json      download state of every configured distro
//   GET /images/<file>    the images, with range requests
//   GET /healthz
//
// Environment overrides: PORT (8080), HOST, IMAGE_DIR (/data/images), PROFILES_DIR,
// PUBLIC_URL, ALLOWED_ORIGINS (comma-separated, "*" for any).
//
// A distro is downloaded once: after verification a "<file>.verified" marker is written. Delete
// it (or the ISO) to fetch a new build, e.g. for Debian's weekly images. ISOs copied into the
// image directory by hand are verified and used instead of being downloaded.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const arg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};

const config_path = path.resolve(arg("--config", path.join(__dirname, "config.json")));
const config = JSON.parse(fs.readFileSync(config_path, "utf8"));

const PORT = +(process.env.PORT || config.port || 8080);
const HOST = process.env.HOST || config.host || undefined;
const IMAGE_DIR = path.resolve(process.env.IMAGE_DIR || config.image_dir || "/data/images");
const PROFILES_DIR = path.resolve(process.env.PROFILES_DIR || config.profiles_dir || path.join(__dirname, "..", "profiles"));
const PUBLIC_URL = (process.env.PUBLIC_URL || config.public_url || "").replace(/\/+$/, "");
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ?
    process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean) :
    config.allowed_origins || ["*"];

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- distros ----

const distros = (config.distros || []).filter(d => d.enabled !== false).map(d => {
    const iso = d.iso || {};
    if(!d.profile || !iso.file || !/^[\w.+-]+$/.test(iso.file))
    {
        throw new Error(`config: each distro needs "profile" and "iso.file" (a plain file name): ${JSON.stringify(d)}`);
    }
    const base = iso.file.replace(/\.iso$/i, "");
    return {
        profile_file: d.profile,
        iso,
        // kernels etc. extracted from the ISO, to <iso name>/<path> (see tools/stage-images.sh)
        extract: (d.extract || []).map(p => ({ path: p, file: path.join(base, p) })),
        state: "queued",
        bytes: 0,
        total: undefined,
        error: undefined,
    };
});

function image_path(file)
{
    const full = path.resolve(IMAGE_DIR, file);
    if(!full.startsWith(IMAGE_DIR + path.sep)) throw new Error("path outside the image directory: " + file);
    return full;
}

const exists = file => fsp.access(file).then(() => true, () => false);

async function read_profile(distro)
{
    const text = await fsp.readFile(path.resolve(PROFILES_DIR, distro.profile_file), "utf8");
    return JSON.parse(text);
}

async function expected_sha256(iso)
{
    if(iso.sha256) return iso.sha256.toLowerCase();
    if(!iso.sha256_url) return null;
    const response = await fetch(iso.sha256_url);
    if(!response.ok) throw new Error(`${iso.sha256_url}: HTTP ${response.status}`);
    const name = path.basename(new URL(iso.url).pathname);
    for(const line of (await response.text()).split("\n"))
    {
        // "<hash>  name", "<hash> *name" or "<hash>  ./name"
        const m = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)\s*$/i.exec(line.trim());
        if(m && (m[2] === name || m[2] === iso.file)) return m[1].toLowerCase();
    }
    throw new Error(`${iso.sha256_url} has no checksum for ${name}`);
}

function sha256_file(file, distro)
{
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        distro.bytes = 0;
        fs.createReadStream(file)
            .on("data", chunk => { hash.update(chunk); distro.bytes += chunk.length; })
            .on("error", reject)
            .on("end", () => resolve(hash.digest("hex")));
    });
}

function run(cmd, argv, options = {})
{
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, argv, { stdio: ["ignore", options.stdout || "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", d => stderr = (stderr + d).slice(-2000));
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${stderr.trim()}`)));
    });
}

async function remote_size(url)
{
    try
    {
        const response = await fetch(url, { method: "HEAD", redirect: "follow" });
        const length = response.headers.get("content-length");
        return response.ok && length ? +length : undefined;
    }
    catch(e)
    {
        return undefined;
    }
}

async function download(distro, dest)
{
    const part = dest + ".part";
    distro.state = "downloading";
    distro.total = distro.iso.size || await remote_size(distro.iso.url);
    try
    {
        distro.bytes = (await fsp.stat(part)).size;
    }
    catch(e)
    {
        distro.bytes = 0;
    }
    log(`[${distro.iso.file}] downloading ${distro.iso.url}` + (distro.bytes ? ` (resuming at ${distro.bytes})` : ""));

    const progress = setInterval(() => {
        fsp.stat(part).then(s => distro.bytes = s.size, () => {});
    }, 1000);
    try
    {
        // curl resumes partial downloads (-C -) and retries transient errors
        await run("curl", ["-fL", "--retry", "10", "--retry-delay", "5", "--retry-all-errors",
            "-C", "-", "-o", part, distro.iso.url]);
    }
    finally
    {
        clearInterval(progress);
    }
    await fsp.rename(part, dest);
}

async function extract(distro, iso_file, items)
{
    distro.state = "extracting";
    for(const { path: inner, file } of items)
    {
        const dest = image_path(file);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        // -O follows hard links in the ISO, which -x would leave as empty files
        const out = fs.openSync(dest + ".part", "w");
        try
        {
            await run("bsdtar", ["-xOf", iso_file, inner], { stdout: out });
        }
        finally
        {
            fs.closeSync(out);
        }
        if(!(await fsp.stat(dest + ".part")).size) throw new Error(`${inner} not found in ${distro.iso.file}`);
        await fsp.rename(dest + ".part", dest);
        log(`[${distro.iso.file}] extracted ${inner}`);
    }
}

async function prepare(distro)
{
    const iso_file = image_path(distro.iso.file);
    const marker = iso_file + ".verified";

    if(!(await exists(iso_file) && await exists(marker)))
    {
        const expected = await expected_sha256(distro.iso);

        if(await exists(iso_file))
        {
            log(`[${distro.iso.file}] found, verifying`);
        }
        else
        {
            await download(distro, iso_file);
        }

        if(expected)
        {
            distro.state = "verifying";
            distro.total = (await fsp.stat(iso_file)).size;
            const actual = await sha256_file(iso_file, distro);
            if(actual !== expected)
            {
                await fsp.rm(iso_file, { force: true });
                throw new Error(`checksum mismatch (expected ${expected}, got ${actual}); removed, will retry`);
            }
        }
        await fsp.writeFile(marker, (expected || "unverified") + "\n");
        log(`[${distro.iso.file}] ${expected ? "verified" : "downloaded (no checksum configured)"}`);
    }

    const missing = [];
    for(const e of distro.extract)
    {
        if(!(await exists(image_path(e.file)))) missing.push(e);
    }
    if(missing.length) await extract(distro, iso_file, missing);

    distro.total = (await fsp.stat(iso_file)).size;
    distro.bytes = distro.total;
    distro.state = "ready";
    distro.error = undefined;
    log(`[${distro.iso.file}] ready`);
}

async function prepare_all()
{
    await fsp.mkdir(IMAGE_DIR, { recursive: true });
    // small images first, so that something is bootable early
    const queue = [...distros].sort((a, b) => (a.iso.size || 0) - (b.iso.size || 0));
    for(let attempt = 1; queue.length; attempt++)
    {
        for(const distro of [...queue])
        {
            try
            {
                await prepare(distro);
                queue.splice(queue.indexOf(distro), 1);
            }
            catch(e)
            {
                distro.state = "error";
                distro.error = e.message;
                log(`[${distro.iso.file}] error: ${e.message}`);
            }
        }
        if(queue.length)
        {
            const delay = Math.min(3600, 60 * attempt);
            log(`retrying ${queue.length} distro(s) in ${delay}s`);
            await new Promise(r => setTimeout(r, delay * 1000));
        }
    }
}

// ---- http ----

function public_base(req)
{
    if(PUBLIC_URL) return PUBLIC_URL;
    const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}`;
}

function cors_headers(req)
{
    const origin = req.headers.origin;
    const headers = {
        "Vary": "Origin",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    };
    if(ALLOWED_ORIGINS.includes("*"))
    {
        headers["Access-Control-Allow-Origin"] = "*";
    }
    else if(origin && ALLOWED_ORIGINS.includes(origin))
    {
        headers["Access-Control-Allow-Origin"] = origin;
    }
    return headers;
}

function send_json(req, res, status, data)
{
    const body = JSON.stringify(data, null, 4) + "\n";
    res.writeHead(status, {
        ...cors_headers(req),
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(req.method === "HEAD" ? undefined : body);
}

async function catalogue(req)
{
    const profiles = [];
    for(const distro of distros)
    {
        if(distro.state !== "ready") continue;
        try
        {
            const profile = await read_profile(distro);
            // fill in the real sizes, so the client needn't probe (and so they're right for
            // images that change, like Debian's weekly builds)
            for(const [type, media] of Object.entries(profile.media || {}))
            {
                const url = typeof media === "string" ? media : media && media.url;
                if(!url || /^([a-z]+:|\/)/i.test(url)) continue;
                try
                {
                    const size = (await fsp.stat(image_path(url))).size;
                    profile.media[type] = { ...(typeof media === "string" ? { url } : media), size };
                }
                catch(e) {}
            }
            delete profile.image_base;
            profiles.push(profile);
        }
        catch(e)
        {
            log(`[${distro.profile_file}] can't load profile: ${e.message}`);
        }
    }
    return {
        schema: "v86-machine-catalogue/1",
        image_base: public_base(req) + "/images/",
        profiles,
    };
}

function status()
{
    return {
        distros: distros.map(d => ({
            file: d.iso.file,
            profile: d.profile_file,
            state: d.state,
            bytes: d.bytes,
            total: d.total,
            progress: d.total ? +(d.bytes / d.total).toFixed(4) : undefined,
            error: d.error,
        })),
    };
}

function serve_image(req, res, name)
{
    let file;
    try
    {
        file = image_path(name);
    }
    catch(e)
    {
        return send_json(req, res, 403, { error: "forbidden" });
    }
    // partial downloads and bookkeeping aren't images
    if(/\.(part|verified)$/.test(file) || name.split("/").some(s => s.startsWith(".")))
    {
        return send_json(req, res, 404, { error: "not found" });
    }

    let stat;
    try
    {
        stat = fs.statSync(file);
        if(!stat.isFile()) throw new Error();
    }
    catch(e)
    {
        return send_json(req, res, 404, { error: "not found" });
    }

    const headers = {
        ...cors_headers(req),
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
        "Last-Modified": stat.mtime.toUTCString(),
    };

    let start = 0;
    let end = stat.size - 1;
    let code = 200;
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(req.headers.range && !range)
    {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` }).end();
        return;
    }
    if(range)
    {
        if(range[1] === "")
        {
            start = Math.max(0, stat.size - +range[2]);
        }
        else
        {
            start = +range[1];
            if(range[2] !== "") end = Math.min(+range[2], stat.size - 1);
        }
        if(start > end || start >= stat.size)
        {
            res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` }).end();
            return;
        }
        code = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers["Content-Length"] = end - start + 1;

    res.writeHead(code, headers);
    if(req.method === "HEAD")
    {
        res.end();
        return;
    }
    fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
    let pathname;
    try
    {
        pathname = decodeURIComponent(new URL("http://localhost" + req.url).pathname);
    }
    catch(e)
    {
        res.writeHead(400).end("Bad request\n");
        return;
    }

    if(req.method === "OPTIONS")
    {
        res.writeHead(204, {
            ...cors_headers(req),
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range",
            "Access-Control-Max-Age": "86400",
        }).end();
        return;
    }
    if(req.method !== "GET" && req.method !== "HEAD")
    {
        res.writeHead(405, { "Allow": "GET, HEAD, OPTIONS" }).end();
        return;
    }

    try
    {
        if(pathname === "/catalogue.json") return send_json(req, res, 200, await catalogue(req));
        if(pathname === "/status.json") return send_json(req, res, 200, status());
        if(pathname === "/healthz") return send_json(req, res, 200, { ok: true });
        if(pathname.startsWith("/images/")) return serve_image(req, res, pathname.slice("/images/".length));
        if(pathname === "/") return send_json(req, res, 200, { catalogue: "/catalogue.json", status: "/status.json" });
        send_json(req, res, 404, { error: "not found" });
    }
    catch(e)
    {
        log("request error:", e);
        if(!res.headersSent) send_json(req, res, 500, { error: "internal error" });
        else res.destroy();
    }
});

server.listen(PORT, HOST, () => {
    log(`image server on http://${HOST || "0.0.0.0"}:${PORT}/ (images in ${IMAGE_DIR}, profiles in ${PROFILES_DIR})`);
    log(`public url: ${PUBLIC_URL || "(from request)"}, allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});

prepare_all().then(() => log("all distros ready"));

for(const signal of ["SIGINT", "SIGTERM"])
{
    process.on(signal, () => {
        log(`${signal}, exiting`);
        process.exit(0);
    });
}
