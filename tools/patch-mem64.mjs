#!/usr/bin/env node

// Post-link step for the mem64 build (cargo feature "mem64"): adds a 64-bit memory for guest RAM
// (memory index 1, exported as "guest_memory") to the core module and replaces the bodies of the
// v86_guest_* placeholder functions (see src/rust/cpu/guest.rs) with accesses to it, which rust
// can't express itself.
//
// usage: patch-mem64.mjs <input.wasm> <output.wasm>

import fs from "node:fs";

// 16 GiB, the limit of 64-bit memories in V8
const GUEST_MEMORY_MAX_PAGES = 262144;

const I32 = 0x7F, I64 = 0x7E;

// name -> [params, results, body (without locals, end is added)]
const local_get = i => [0x20, i];
const local_set = i => [0x21, i];
const memarg_m1 = (align, offset = 0) => [0x40 | align, 1, offset];
const memarg_m0 = (align, offset = 0) => [align, offset];

// A copy loop between the core memory and guest memory: V8 doesn't support memory.copy between
// memories of different index types. Copies 8 bytes at a time, then single bytes. src, dst and
// count are the locals 0, 1 and 2; count is i32
function copy_loop(src_in_guest)
{
    const src_memarg = src_in_guest ? memarg_m1 : memarg_m0;
    const dst_memarg = src_in_guest ? memarg_m0 : memarg_m1;
    // increment a local holding an address in guest memory (i64) or core memory (i32)
    const advance = (local, in_guest, n) => in_guest ?
        [...local_get(local), 0x42, n, 0x7C, ...local_set(local)] : // i64.const n, i64.add
        [...local_get(local), 0x41, n, 0x6A, ...local_set(local)]; // i32.const n, i32.add
    const loop = (n, condition, load, store) => [
        0x02, 0x40, // block
        0x03, 0x40, // loop
        ...local_get(2), ...condition, 0x0D, 1, // br_if 1 (exit)
        ...local_get(1), ...local_get(0), ...load, ...store,
        ...advance(0, src_in_guest, n),
        ...advance(1, !src_in_guest, n),
        ...local_get(2), 0x41, n, 0x6B, ...local_set(2), // count -= n
        0x0C, 0, // br 0
        0x0B, 0x0B, // end loop, end block
    ];
    return [
        // while(count >= 8): i32.const 8, i32.lt_u; i64.load, i64.store
        ...loop(8, [0x41, 8, 0x49], [0x29, ...src_memarg(0)], [0x37, ...dst_memarg(0)]),
        // while(count != 0): i32.eqz; i32.load8_u, i32.store8
        ...loop(1, [0x45], [0x2D, ...src_memarg(0)], [0x3A, ...dst_memarg(0)]),
    ];
}
const GUEST_FUNCTIONS = {
    v86_guest_load8: [[I64], [I32], [...local_get(0), 0x2D, ...memarg_m1(0)]],
    v86_guest_load16: [[I64], [I32], [...local_get(0), 0x2F, ...memarg_m1(0)]],
    v86_guest_load32: [[I64], [I32], [...local_get(0), 0x28, ...memarg_m1(0)]],
    v86_guest_load64: [[I64], [I64], [...local_get(0), 0x29, ...memarg_m1(0)]],
    v86_guest_store8: [[I64, I32], [], [...local_get(0), ...local_get(1), 0x3A, ...memarg_m1(0)]],
    v86_guest_store16: [[I64, I32], [], [...local_get(0), ...local_get(1), 0x3B, ...memarg_m1(0)]],
    v86_guest_store32: [[I64, I32], [], [...local_get(0), ...local_get(1), 0x36, ...memarg_m1(0)]],
    v86_guest_store64: [[I64, I64], [], [...local_get(0), ...local_get(1), 0x37, ...memarg_m1(0)]],
    // (dst, value, count): memory.fill 1
    v86_guest_fill: [[I64, I32, I64], [], [...local_get(0), ...local_get(1), ...local_get(2), 0xFC, 0x0B, 1]],
    // (src, dst, count): memory.copy 1 1 (operands: dst, src, count)
    v86_guest_copy: [[I64, I64, I64], [], [...local_get(1), ...local_get(0), ...local_get(2), 0xFC, 0x0A, 1, 1]],
    // (src in guest memory, dst in core memory, count)
    v86_guest_copy_to_core: [[I64, I32, I32], [], copy_loop(true)],
    // (src in core memory, dst in guest memory, count)
    v86_guest_copy_from_core: [[I32, I64, I32], [], copy_loop(false)],
};

const [input_path, output_path] = process.argv.slice(2);
if(!input_path || !output_path)
{
    console.error("usage: patch-mem64.mjs <input.wasm> <output.wasm>");
    process.exit(1);
}

const input = new Uint8Array(fs.readFileSync(input_path));

function fail(message)
{
    console.error("patch-mem64: " + message);
    process.exit(1);
}

class Reader
{
    constructor(bytes, offset = 0) { this.bytes = bytes; this.offset = offset; }
    u8() { return this.bytes[this.offset++]; }
    leb()
    {
        let result = 0n, shift = 0n, byte;
        do
        {
            byte = this.u8();
            result |= BigInt(byte & 0x7F) << shift;
            shift += 7n;
        }
        while(byte & 0x80);
        return Number(result);
    }
    bytes_n(n) { const b = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return b; }
    name() { return new TextDecoder().decode(this.bytes_n(this.leb())); }
    limits()
    {
        const flags = this.u8();
        this.leb();
        if(flags & 1) this.leb();
    }
}

function leb(n)
{
    const out = [];
    let value = BigInt(n);
    do
    {
        let byte = Number(value & 0x7Fn);
        value >>= 7n;
        if(value !== 0n) byte |= 0x80;
        out.push(byte);
    }
    while(value !== 0n);
    return out;
}

function name_bytes(s)
{
    const b = new TextEncoder().encode(s);
    return [...leb(b.length), ...b];
}

if(input[0] !== 0 || input[1] !== 0x61 || input[2] !== 0x73 || input[3] !== 0x6D)
{
    fail("not a wasm module");
}

// split into sections
const sections = [];
{
    const r = new Reader(input, 8);
    while(r.offset < input.length)
    {
        const id = r.u8();
        const size = r.leb();
        sections.push({ id, content: r.bytes_n(size) });
    }
}
const section = id => sections.find(s => s.id === id);

// types
const types = [];
{
    const r = new Reader(section(1).content);
    for(let n = r.leb(); n > 0; n--)
    {
        if(r.u8() !== 0x60) fail("unexpected type form");
        const params = [...r.bytes_n(r.leb())];
        const results = [...r.bytes_n(r.leb())];
        types.push({ params, results });
    }
}

// imported functions come first in the function index space
let imported_function_count = 0;
let imported_memory_count = 0;
if(section(2))
{
    const r = new Reader(section(2).content);
    for(let n = r.leb(); n > 0; n--)
    {
        r.name();
        r.name();
        const kind = r.u8();
        if(kind === 0) { r.leb(); imported_function_count++; }
        else if(kind === 1) { r.u8(); r.limits(); }
        else if(kind === 2) { r.limits(); imported_memory_count++; }
        else if(kind === 3) { r.u8(); r.u8(); }
        else if(kind === 4) { r.u8(); r.leb(); }
        else fail("unknown import kind " + kind);
    }
}
if(imported_memory_count !== 0) fail("expected the core memory to be defined, not imported");

const function_types = [];
{
    const r = new Reader(section(3).content);
    for(let n = r.leb(); n > 0; n--) function_types.push(r.leb());
}

// exports: find the placeholder functions
const exports = [];
{
    const r = new Reader(section(7).content);
    for(let n = r.leb(); n > 0; n--)
    {
        exports.push({ name: r.name(), kind: r.u8(), index: r.leb() });
    }
}
if(exports.some(e => e.name === "guest_memory")) fail("module already patched");

const replacements = new Map(); // defined function index -> body
for(const [name, [params, results, code]] of Object.entries(GUEST_FUNCTIONS))
{
    const exp = exports.find(e => e.name === name && e.kind === 0);
    if(!exp) fail("missing export " + name + " (built without the mem64 feature?)");
    const defined_index = exp.index - imported_function_count;
    if(defined_index < 0) fail(name + " is imported");
    if(replacements.has(defined_index)) fail(name + " shares its function with another placeholder");
    const type = types[function_types[defined_index]];
    if(type.params.join() !== params.join() || type.results.join() !== results.join())
    {
        fail(name + " has an unexpected signature: (" + type.params + ") -> (" + type.results + ")");
    }
    replacements.set(defined_index, [0, ...code, 0x0B]); // no locals, code, end
}

// code section: replace the bodies of the placeholders
{
    const r = new Reader(section(10).content);
    const count = r.leb();
    const out = [...leb(count)];
    for(let i = 0; i < count; i++)
    {
        const body = r.bytes_n(r.leb());
        const replacement = replacements.get(i);
        if(replacement)
        {
            out.push(...leb(replacement.length), ...replacement);
        }
        else
        {
            out.push(...leb(body.length));
            for(const b of body) out.push(b);
        }
    }
    section(10).content = new Uint8Array(out);
}

// memory section: add the guest memory (64-bit, no initial pages, with maximum)
let guest_memory_index;
{
    const r = new Reader(section(5).content);
    const count = r.leb();
    const rest = r.bytes_n(section(5).content.length - r.offset);
    guest_memory_index = count;
    section(5).content = new Uint8Array([
        ...leb(count + 1), ...rest,
        0x05, ...leb(0), ...leb(GUEST_MEMORY_MAX_PAGES),
    ]);
}

// export section: export the guest memory
{
    const r = new Reader(section(7).content);
    const count = r.leb();
    const rest = r.bytes_n(section(7).content.length - r.offset);
    section(7).content = new Uint8Array([
        ...leb(count + 1), ...rest,
        ...name_bytes("guest_memory"), 0x02, ...leb(guest_memory_index),
    ]);
}

const parts = [input.subarray(0, 8)];
for(const s of sections)
{
    parts.push(new Uint8Array([s.id, ...leb(s.content.length)]), s.content);
}
const output = Buffer.concat(parts);

if(!WebAssembly.validate(output))
{
    try { new WebAssembly.Module(output); }
    catch(e) { fail("patched module doesn't validate: " + e.message); }
    fail("patched module doesn't validate");
}

fs.writeFileSync(output_path, output);
console.log("patch-mem64: patched " + replacements.size + " functions, guest memory is memory " + guest_memory_index);
