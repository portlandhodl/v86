# v86_64

**x86-64 in the browser.** v86_64 is a PC emulator and x86-to-WebAssembly JIT
that boots modern **64-bit (long mode)** operating systems in a web page or in
Node.js: 64-bit Linux kernels, 64-bit userspace and a 64-bit JIT, all running
in wasm.

It started as a fork of [v86](https://github.com/copy/v86) and has diverged
into its own project. Everything 32-bit that v86 runs still runs, bit for bit.

## Status

| Guest | State |
|---|---|
| Alpine Linux 3.19 x86_64 | Boots from its ISO (SeaBIOS + ISOLINUX) to an interactive root shell in ~28 s, with 64-bit code in the JIT |
| Linux x86_64 kernels | Full early init, arch selftests and userspace, booted from an ISO or directly from a bzImage |
| ELF64 multiboot kernels | Higher-half ELF64 entry points are loaded and run |
| Xubuntu 24.04 (amd64 live ISO) | Being brought up: [examples/xubuntu.html](examples/xubuntu.html) |
| 32-bit guests | Unchanged from v86 (Linux, Windows 1.01-2000, DOS, BSDs, hobby OSes) |

| Milestone | |
|---|---|
| M1: long-mode CPU core (REX, 64-bit registers and addressing, 4-level paging) | Done |
| M2: 64-bit kernel to userspace (interrupts, syscall, NX, full 48-bit addresses) | Done |
| M3: boot media and devices for real distributions | Done |
| M4: JIT for 64-bit code (~530 MIPS vs ~80 interpreted) | Done, performance work ongoing |
| M5: graphical distributions (Ubuntu and friends) | In progress |

The roadmap, design notes and every long-mode bug found so far are in
[TODOS.md](TODOS.md).

## What's emulated

**CPU**: x86-64 with the 32-bit instruction set at around Pentium 4 level.

- Long mode: EFER.LME/LMA/SCE/NXE, 64-bit and compatibility code segments,
  canonical 48-bit linear addresses, 4-level paging with 4 KiB and 2 MiB
  pages, NX, SMEP. The TLB covers the full 48-bit address space (flat for the
  low 4 GiB, hashed above).
- 64-bit instructions: REX prefixes and 16 GPRs, RIP-relative addressing,
  default-64 opcodes, `movsxd`, `cmpxchg16b`, qword string ops including
  `rep` forms, `moffs64`, `rdrand`, 64-bit far calls, jumps and returns.
- SSE through SSE4.2 (SSE3, SSSE3, SSE4.1, SSE4.2), with all 16 xmm registers in
  64-bit mode, REX.W GPR<->XMM moves and conversions, and `fxsave`/`fxrstor` in
  64-bit format.
- System: 16-byte IDT gates, 64-bit interrupt frames, TSS RSP0-2 and IST stack
  switches, `iretq`, `syscall`/`sysret`, `swapgs`, FS/GS/KERNEL_GS_BASE MSRs,
  NMIs.
- CPUID reports the x86-64-v1 baseline plus SSE3, SSSE3, SSE4.1, SSE4.2, POPCNT,
  RDRAND, NX,
  LAHF/SAHF and SMEP, with 48 linear and 32 physical address bits.
- An x87 FPU using Berkeley SoftFloat (precise, but slow).
- Two execution engines that share one instruction table: an interpreter and
  a JIT that compiles hot guest code to wasm modules. 64-bit code has its own
  JIT tables (`gen/generate_jit64.js`); registers live in i64 wasm locals, and
  the common integer instructions, conditions, branches and memory accesses
  are compiled natively.

**Devices**: local APIC and IOAPIC, 8259 PIC, 8254 PIT, CMOS RTC, ACPI, a PCI
bus, an IDE controller with CD-ROM (including a built-in ISO 9660 generator),
a floppy controller, PS/2 keyboard and mouse, a VGA card with SVGA and Bochs
VBE extensions (Linux's `bochs` DRM driver binds to it), an NE2000 network
card, virtio (9p filesystem, network, console, balloon, 2D GPU), a
SoundBlaster 16, a serial port and a Hayes-compatible modem.

**Limits**: one CPU, guest physical memory up to 4 GiB (wasm32), no 1 GiB
pages, no x2APIC, no AVX, no 3D graphics (OpenGL in guests is
software-rendered).

## Getting started

You need make, Rust with the `wasm32-unknown-unknown` target, a clang
compatible with your Rust, Java (for Closure Compiler) and a recent Node.js
(v24.16 is known to work).
[tools/docker/test-image/Dockerfile](tools/docker/test-image/Dockerfile) has a
full setup for Debian or WSL.

```sh
make all                          # build/libv86.js and build/v86.wasm (index.html)
make                              # debug build (debug.html)
./tools/serve.mjs --port 8000     # static server with HTTP range requests
```

Use `tools/serve.mjs` rather than `make run`: 64-bit distribution ISOs are
several GB and are streamed with range requests, which Python's http.server
doesn't support.

**Xubuntu 24.04 in the browser.** Download the ISO into `images/` (the
commands are at the top of [examples/xubuntu.html](examples/xubuntu.html)) and
open http://localhost:8000/examples/xubuntu.html. Add `?serial` to see the
serial console, `?mem=<MiB>` to change the memory size.

**Internet access in the guest.** `./tools/serve.mjs --wisp` (after
`npm install`) also runs a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol)
proxy at `/wisp/`, and the Xubuntu page connects its network card to it by
default. The guest gets an address by DHCP and can open TCP connections to
the internet (web, apt, git, ssh); DNS is resolved over DNS-over-HTTPS. Add
`--wisp-allow-lan` to also reach your local network and the host. Anyone who
can reach the server can use the proxy, so pass `--host 127.0.0.1` unless you
trust your network. The page takes `?net=` (`wisp`, `none` or another backend
URL), `?nic=ne2k|virtio` and `?doh=<server>`; see
[docs/networking.md](docs/networking.md) for the other backends, including
full-ethernet relays.

**Alpine x86_64 in Node.js.** This boots the ISO, logs in on the serial
console and checks `uname -m`:

```sh
ALPINE_ISO=images/alpine-virt-3.19.1-x86_64.iso ./tests/longmode/alpine.js
```

## Embedding

The JavaScript API is the same for 32-bit and 64-bit guests. Load
`build/libv86.js` and point it at a 64-bit ISO, or at a 64-bit `bzimage` plus
`initrd`:

```javascript
const emulator = new V86({
    wasm_path: "build/v86.wasm",
    memory_size: 2048 * 1024 * 1024,
    vga_memory_size: 32 * 1024 * 1024,   // 16-32 MiB for large framebuffers
    screen_container: document.getElementById("screen_container"),
    bios: { url: "bios/seabios.bin" },
    vga_bios: { url: "bios/vgabios.bin" },
    cdrom: { url: "images/distro-amd64.iso", async: true },  // streamed
    acpi: true,                          // needed for kernels that use the IOAPIC
    autostart: true,
});
```

See [v86.d.ts](v86.d.ts) for the TypeScript definitions (`make doc` or
`make denodoc` generate HTML documentation in `docs/api/`). More examples:

- [Xubuntu 24.04 x86-64 live ISO](examples/xubuntu.html)
- [Basic](examples/basic.html)
- [Programmatically using the serial terminal](examples/serial.html)
- [Saving and restoring emulator state](examples/save_restore.html)
- [Two instances in one window](examples/two_instances.html)
- [Running in a web worker](examples/worker.html)
- [Networking between tabs with the Broadcast Channel API](examples/broadcast-network.html)
- [TCP terminal (fetch-based networking)](examples/tcp_terminal.html)
- [Node.js](examples/nodejs.js)

## Testing

```sh
make longmode-tests        # long mode: interpreter and JIT_THRESHOLD=1, plus ELF64 multiboot
make nasmtests             # instruction tests against the host CPU (nasm + gdb)
make nasmtests-force-jit
make rust-test expect-tests
make tests                 # boots guest images (see below)
make kvm-unit-test
```

`tests/longmode/longmode.asm` enters long mode from the reset vector and
checks 70+ results, each a regression test for a long-mode bug. The x86_64
kvm-unit-tests build from `tests/kvm-unit-tests/`
(`./configure --arch=x86_64 && make`) and run with
`node tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/<test>.flat`;
`access`, `eventinj`, `apic`, `msr`, `vmexit`, `realmode`, `smptest`,
`port80` and `setjmp` pass.

Guest images for `make tests` aren't in the repository:

```sh
mkdir -p images && curl --compressed --output-dir images/ --remote-name-all https://i.copy.sh/{linux.iso,linux3.iso,linux4.iso,buildroot-bzimage68.bin,TinyCore-11.0.iso,oberon.img,msdos.img,openbsd-floppy.img,kolibri.img,windows101.img,os8.img,freedos722.img,mobius-fd-release5.img,msdos622.img}
```

See [tests/Readme.md](tests/Readme.md) for more.

## Documentation

- [TODOS.md](TODOS.md): x86-64 roadmap, design and lessons learned
- [How it works](docs/how-it-works.md) and [Profiling](docs/profiling.md)
- [Networking](docs/networking.md) and [dial-up modem networking](docs/modem.md)
- [9p filesystem](docs/filesystem.md) and [Linux rootfs on 9p](docs/linux-9p-image.md)
- Guest setup: [Alpine](tools/docker/alpine/), [Arch Linux](docs/archlinux.md),
  [Debian with Xfce](tools/docker/debian/), [MS-DOS/FreeDOS](docs/dos.md),
  [Windows 3.1x](docs/windows-31x.md), [Windows 9x](docs/windows-9x.md),
  [Windows NT](docs/windows-nt.md)

## Contributing: generative AI submissions required

**All contributions to v86_64 must be made with generative AI.** Code, tests,
documentation and debugging work are expected to be produced by an AI coding
agent (for example [Claude Code](https://claude.com/claude-code)), with a human
directing and reviewing it. Hand-written submissions will not be accepted.

- Say which tool and model produced the change in the pull request, and keep
  the `Co-Authored-By` trailer the agent adds to commits.
- [TODOS.md](TODOS.md) is written to be handed to an agent with no prior
  context: it contains the orientation, the patterns for adding 64-bit
  instructions, and the hard-won lessons about decoding. Point your agent at
  it first.
- Every CPU fix needs a regression test (usually a new check in
  `tests/longmode/`), and 32-bit behaviour must stay bit-identical: run
  `make nasmtests nasmtests-force-jit longmode-tests` before submitting.

Questions and bug reports go to the
[issue tracker](https://github.com/portlandhodl/v86_64/issues).

## Relationship to v86

v86_64 is built on [v86](https://github.com/copy/v86) by the v86 contributors,
and keeps its API (`new V86({...})`) and build outputs (`libv86.js`,
`v86.wasm`). Upstream v86 does not accept AI-written contributions, so
v86_64's changes are not submitted upstream. For the 32-bit demos, see
[copy.sh/v86](https://copy.sh/v86/).

## License

v86_64 is distributed under the terms of the Simplified BSD License, see
[LICENSE](LICENSE). The following third-party dependencies are included in the
repository under their own licenses:

- [`lib/softfloat/softfloat.c`](lib/softfloat/softfloat.c)
- [`lib/zstd/zstddeclib.c`](lib/zstd/zstddeclib.c)
- [`tests/kvm-unit-tests/`](tests/kvm-unit-tests)
- [`tests/qemu/`](tests/qemu)
- [`src/floppy.js`](src/floppy.js) contains parts ported from qemu under the MIT license, see LICENSE.MIT.

## Credits

- [v86](https://github.com/copy/v86), which this project is built on
- CPU test cases via [QEMU](https://wiki.qemu.org/Main_Page)
- More tests via [kvm-unit-tests](https://www.linux-kvm.org/page/KVM-unit-tests)
- [zstd](https://github.com/facebook/zstd) support is included for better compression of state images
- [Berkeley SoftFloat](http://www.jhauser.us/arithmetic/SoftFloat.html) is included to precisely emulate 80-bit floating point numbers
- [The jor1k project](https://github.com/s-macke/jor1k) for 9p, filesystem and uart drivers
- [WinWorld](https://winworldpc.com/), [OS/2 Museum](https://www.os2museum.com/) and [ArchiveOS](https://archiveos.org/), sources of several operating systems
