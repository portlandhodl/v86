#!/usr/bin/env node
// A static file server with support for HTTP range requests, which v86 uses to
// load large disk and cdrom images on demand (`async: true`). Python's
// http.server (`make run`) doesn't support ranges.
//
//   ./tools/serve.mjs [--port 8000] [--host 0.0.0.0] [--root .] [--wisp [--wisp-allow-lan]]
//
// Symbolic links are followed, so large images can be linked into images/.
//
// --wisp also serves a Wisp proxy (https://github.com/MercuryWorkshop/wisp-protocol) at
// /wisp/, which gives guests internet access through v86's wisp network backend
// (net_device.relay_url = "wisp://host:port/wisp/"). Guest TCP connections are made from
// this machine, so anyone who can reach the port can use it as a proxy: bind it to
// localhost (--host 127.0.0.1) unless you trust your network. Connections to private and
// loopback addresses (your LAN, this machine) are refused unless --wisp-allow-lan is given.
// Needs the dev dependencies: npm install

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const port = +arg("--port", 8000);
const host = arg("--host", undefined);
const root = path.resolve(arg("--root", "."));
const wisp_allow_lan = args.includes("--wisp-allow-lan");
const wisp_enabled = args.includes("--wisp") || wisp_allow_lan;

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
    let file;
    try
    {
        // a path like "//x" would be parsed as a host, so give the url an explicit origin
        const url = new URL("http://localhost" + req.url);
        file = path.join(root, decodeURIComponent(url.pathname));
    }
    catch(e)
    {
        // invalid url or percent-encoding: don't let one request take the server down
        res.writeHead(400).end("Bad request\n");
        return;
    }
    if(!file.startsWith(root))
    {
        res.writeHead(403).end();
        return;
    }

    let stat;
    try
    {
        stat = fs.statSync(file);
        if(stat.isDirectory())
        {
            file = path.join(file, "index.html");
            stat = fs.statSync(file);
        }
    }
    catch(e)
    {
        res.writeHead(404).end("Not found\n");
        return;
    }

    const headers = {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
    };

    let start = 0;
    let end = stat.size - 1;
    let status = 200;

    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(req.headers.range && !range)
    {
        // multiple ranges aren't supported (v86 doesn't use them)
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
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
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
            return;
        }
        status = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers["Content-Length"] = end - start + 1;

    res.writeHead(status, headers);
    if(req.method === "HEAD")
    {
        res.end();
        return;
    }
    fs.createReadStream(file, { start, end }).pipe(res);
});

if(wisp_enabled)
{
    let wisp;
    try
    {
        ({ server: wisp } = await import("@mercuryworkshop/wisp-js/server"));
    }
    catch(e)
    {
        console.error("--wisp needs @mercuryworkshop/wisp-js, run `npm install` first");
        process.exit(1);
    }
    wisp.options.allow_private_ips = wisp_allow_lan;
    wisp.options.allow_loopback_ips = wisp_allow_lan;
    server.on("upgrade", (req, socket, head) => {
        if(new URL(req.url, "http://localhost").pathname === "/wisp/")
        {
            wisp.routeRequest(req, socket, head);
        }
        else
        {
            socket.destroy();
        }
    });
}

server.listen(port, host, () => {
    console.log(`Serving ${root} on http://${host || "localhost"}:${port}/`);
    if(wisp_enabled)
    {
        console.log(`Wisp proxy on ws://${host || "localhost"}:${port}/wisp/` +
            (wisp_allow_lan ? " (LAN and loopback allowed)" : " (internet only)"));
    }
});
