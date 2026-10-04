#!/usr/bin/env node
// A static file server with support for HTTP range requests, which v86 uses to
// load large disk and cdrom images on demand (`async: true`). Python's
// http.server (`make run`) doesn't support ranges.
//
//   ./tools/serve.mjs [--port 8000] [--root .]
//
// Symbolic links are followed, so large images can be linked into images/.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const port = +arg("--port", 8000);
const root = path.resolve(arg("--root", "."));

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
    const url = new URL(req.url, "http://localhost");
    let file = path.join(root, decodeURIComponent(url.pathname));
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

server.listen(port, () => {
    console.log(`Serving ${root} on http://localhost:${port}/`);
});
