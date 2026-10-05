#!/usr/bin/env node

// End-to-end test for the virtio-gpu device (2D).
//
// Boots a bare-metal multiboot kernel (virtio_gpu_kernel.asm) which drives
// the device directly over its PCI I/O port BARs: feature negotiation,
// control queue setup, GET_DISPLAY_INFO, RESOURCE_CREATE_2D, framebuffer
// test pattern, ATTACH_BACKING, SET_SCANOUT, TRANSFER_TO_HOST_2D, FLUSH.
// The host verifies the scanout event and the flushed frame pixel-for-pixel.

import assert from "assert/strict";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");

process.on("unhandledRejection", exn => { throw exn; });

const SHOW_LOGS = !!process.env.SHOW_LOGS;

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? root_path + "/build/libv86.mjs" : root_path + "/src/main.js");

const kernel_file = path.join(__dirname, "virtio_gpu_kernel.bin");
try
{
    execFileSync("nasm", ["-w+error", "-f", "bin", "-o", kernel_file,
        path.join(__dirname, "virtio_gpu_kernel.asm")]);
}
catch(e)
{
    console.log("nasm not available or failed, test skipped");
    process.exit(0);
}

const emulator = new V86({
    bios: { url: root_path + "/bios/seabios.bin" },
    vga_bios: { url: root_path + "/bios/vgabios.bin" },
    multiboot: { url: kernel_file },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    acpi: true,
    log_level: SHOW_LOGS ? 0x200000 | 0x800 : 0, // LOG_VIRTIO | LOG_PCI
    disable_jit: +process.env.DISABLE_JIT,
    virtio_gpu: true,
});

let serial_log = "";
let done = false;
let frame_count = 0;
let last_frame = null;
let scanout = null;

function fail(msg)
{
    console.error("\nSerial output: " + serial_log);
    console.error("FAIL: " + msg);
    emulator.destroy();
    process.exit(1);
}

emulator.add_listener("serial0-output-byte", function(byte)
{
    const chr = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(chr);
    serial_log += chr;

    if(!done && serial_log.includes("GPUTEST_FAIL"))
    {
        fail("guest reported failure");
    }

    if(!done && serial_log.includes("GPUTEST_DONE"))
    {
        done = true;

        assert(scanout && scanout.enabled, "no scanout event received");
        assert(frame_count > 0, "no frames received");
        assert(last_frame, "no frame");

        // verify the test pattern landed (format B8G8R8X8: B,G,R,X bytes)
        const { width, height, pixels } = last_frame;
        assert(width > 0 && height > 0);
        assert.strictEqual(pixels.length, width * height * 4);
        for(const [x, y] of [[0, 0], [10, 20], [width - 1, height - 1], [513 % width, 257 % height]])
        {
            const i = (y * width + x) * 4;
            assert.strictEqual(pixels[i], x & 0xFF, `B at ${x},${y}`);
            assert.strictEqual(pixels[i + 1], y & 0xFF, `G at ${x},${y}`);
            assert.strictEqual(pixels[i + 2], (x ^ y) & 0xFF, `R at ${x},${y}`);
        }

        console.log(`Scanout ${scanout.width}x${scanout.height}, ` +
            `received ${frame_count} frame(s), last ${width}x${height}, pattern verified`);
        console.log("Test passed");
        emulator.destroy();
        process.exit(0);
    }
});

emulator.bus.register("virtio-gpu-set-scanout", function(s)
{
    scanout = s;
});

emulator.bus.register("virtio-gpu-frame", function(frame)
{
    frame_count++;
    last_frame = frame;
});

setTimeout(() =>
{
    fail("timed out");
}, 2 * 60 * 1000);
