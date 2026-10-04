#!/usr/bin/env node
// Guest RAM above 4 GiB (mem64 build): boots a 64-bit Linux (Alpine "virt" x86_64 ISO), copies
// the 64-bit memhog payload (memhog.rs, `make tests/api/memhog64`) from a 9p mount and runs
// several instances in parallel that together fill and verify ~85% of RAM.
//
//   ALPINE_ISO=images/alpine-virt-3.19.1-x86_64.iso MEMORY_MB=6144 ./tests/api/high-mem.js
//
// MEMORY_MB defaults to 6144; sizes above 3 GiB load the mem64 build (V86_WASM_PATH overrides
// it). Skipped if ALPINE_ISO isn't set. DISABLE_JIT=1 runs everything in the interpreter.

import url from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");

process.on("unhandledRejection", exn => { throw exn; });

const ISO = process.env.ALPINE_ISO;
if(!ISO || !fs.existsSync(ISO))
{
    console.log("ALPINE_ISO not set or not found, test skipped");
    process.exit(0);
}

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? root_path + "/build/libv86.mjs" : root_path + "/src/main.js");

const MEMORY_MB = +process.env.MEMORY_MB || 6144;
const TIMEOUT = (+process.env.TIMEOUT || 1200) * 1000;

// several processes in parallel also exercise the guest's page allocator and context switches
const PROCESS_MB = 2048;
const total_mb = Math.floor(MEMORY_MB * 0.85);
const sizes = [];
for(let left = total_mb; left >= 32; left -= PROCESS_MB)
{
    sizes.push(Math.min(left, PROCESS_MB));
}

const emulator = new V86({
    bios: { url: root_path + "/bios/seabios.bin" },
    vga_bios: { url: root_path + "/bios/vgabios.bin" },
    cdrom: { url: ISO },
    filesystem: {},
    memory_size: MEMORY_MB * 1024 * 1024,
    autostart: true,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
    wasm_path: process.env.V86_WASM_PATH,
});

emulator.bus.register("emulator-started", () => {
    emulator.create_file("memhog", fs.readFileSync(__dirname + "/memhog64"));
});

const start = Date.now();
const elapsed = () => ((Date.now() - start) / 1000).toFixed(0) + "s";

let output = "";
let state = "boot";

const timeout = setTimeout(() => {
    console.error(`[-] Timeout after ${elapsed()}, serial output:\n` + output.slice(-2000));
    process.exit(1);
}, TIMEOUT);

emulator.add_listener("serial0-output-byte", function(byte)
{
    output += String.fromCharCode(byte);

    if(state === "boot" && /login: $/.test(output))
    {
        console.log(`[+] Login prompt after ${elapsed()}`);
        state = "login";
        emulator.serial0_send("root\n");
    }
    else if(state === "login" && /# $/.test(output))
    {
        state = "command";
        output = "";
        console.log(`[+] Running ${sizes.length} memhog processes: ${sizes.join(" + ")} MiB`);
        emulator.serial0_send(
            "modprobe 9pnet_virtio && mkdir -p /mnt/host && mount -t 9p -o trans=virtio host9p /mnt/host && " +
            "cat /mnt/host/memhog > /root/memhog && chmod +x /root/memhog\n" +
            "grep MemTotal /proc/meminfo\n" +
            sizes.map((mb, i) => `(/root/memhog ${mb} > /tmp/memhog${i}.log 2>&1; echo status=$? >> /tmp/memhog${i}.log) &\n`).join("") +
            "wait; cat /tmp/memhog*.log | grep -E 'status=|MISMATCH|failed'; echo test fini''shed\n"
        );
    }
    else if(state === "command" && /test finished\r?\n/.test(output))
    {
        clearTimeout(timeout);
        emulator.destroy();

        const mem_total = /MemTotal:\s+(\d+) kB/.exec(output);
        const statuses = [...output.matchAll(/status=(\d+)/g)].map(m => +m[1]);
        const errors = output.split(/\r?\n/).filter(l => /MISMATCH|failed/.test(l) && !l.includes("grep"));

        if(mem_total)
        {
            console.log(`[+] Guest MemTotal: ${Math.round(mem_total[1] / 1024)} MiB`);
        }

        if(statuses.length === sizes.length && statuses.every(s => s === 0) && !errors.length)
        {
            console.log(`[+] Test passed: ${total_mb} MiB filled and verified (${elapsed()})`);
            process.exit(0);
        }

        console.error(`[-] Test failed, statuses: ${statuses.join(",")}\n` + errors.join("\n"));
        process.exit(1);
    }
});
