#!/usr/bin/env node
// Compatibility mode: boots a 64-bit Linux (Alpine "virt" x86_64 ISO) and runs the *32-bit*
// memhog payload (memhog.rs, `make tests/api/memhog`, an i386 static ELF) on it. 32-bit
// userspace on a 64-bit kernel exercises compat mode: 32-bit code segments with EFER.LMA=1,
// int 0x80 delivery through the 64-bit IDT, syscall/sysenter from compat mode, and page
// faults/signals with a 32-bit CS (TODOS.md §3.4, §5).
//
//   ALPINE_ISO=images/alpine-virt-3.19.1-x86_64.iso ./tests/api/compat32.js
//
// MEMHOG_MB defaults to 128 MiB. Skipped if ALPINE_ISO isn't set. DISABLE_JIT=1 runs
// everything in the interpreter.

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

const MEMHOG_MB = +process.env.MEMHOG_MB || 128;
const TIMEOUT = (+process.env.TIMEOUT || 900) * 1000;

const emulator = new V86({
    bios: { url: root_path + "/bios/seabios.bin" },
    vga_bios: { url: root_path + "/bios/vgabios.bin" },
    cdrom: { url: ISO },
    filesystem: {},
    memory_size: 512 * 1024 * 1024,
    autostart: true,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
    wasm_path: process.env.V86_WASM_PATH,
});

emulator.bus.register("emulator-started", () => {
    emulator.create_file("memhog32", fs.readFileSync(__dirname + "/memhog"));
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
        console.log(`[+] Running 32-bit memhog (${MEMHOG_MB} MiB) on the x86_64 kernel`);
        emulator.serial0_send(
            "modprobe 9pnet_virtio && mkdir -p /mnt/host && mount -t 9p -o trans=virtio host9p /mnt/host && " +
            "cat /mnt/host/memhog32 > /root/memhog32 && chmod +x /root/memhog32\n" +
            "file /root/memhog32 2>/dev/null || head -c 20 /root/memhog32 | od -c | head -2\n" +
            `/root/memhog32 ${MEMHOG_MB}; echo status=$?\n` +
            "echo test fini''shed\n"
        );
    }
    else if(state === "command" && /test finished\r?\n/.test(output))
    {
        clearTimeout(timeout);
        emulator.destroy();

        const status = /status=(\d+)/.exec(output);
        const errors = output.split(/\r?\n/).filter(l => /MISMATCH|failed|Segmentation|panic/i.test(l) && !l.includes("grep"));

        if(status && +status[1] === 0 && !errors.length)
        {
            console.log(`[+] Test passed: 32-bit userspace ran on the 64-bit kernel (${elapsed()})`);
            process.exit(0);
        }
        console.error("[-] Failure, serial output:\n" + output.slice(-2000));
        process.exit(1);
    }
});
