#!/usr/bin/env node

// Generates the instruction tables of the 64-bit jit (src/rust/gen/jit64.rs, jit64_0f.rs) and
// the exported wrappers around the interpreter's instruction handlers that the compiled code
// calls (src/rust/gen/jit64_wrappers.rs). See src/rust/jit64.rs.
//
// The tables are indexed like the interpreter's: opcode | tier << 8, where the tier is the
// operand size (0: 16 bit, 1: 32 bit, 2: 64 bit).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import x86_table from "./x86_table.js";
import * as rust_ast from "./rust_ast.js";
import { hex, get_switch_value, get_switch_exist, finalize_table_rust } from "./util.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "src/rust/gen/");

fs.mkdirSync(OUT_DIR, { recursive: true });

const table_arg = get_switch_value("--table");
const gen_all = get_switch_exist("--all");
const to_generate = {
    jit64: gen_all || table_arg === "jit64",
    jit64_0f: gen_all || table_arg === "jit64_0f",
    jit64_wrappers: gen_all || table_arg === "jit64_wrappers",
};

assert(
    Object.keys(to_generate).some(k => to_generate[k]),
    "Pass --table [jit64|jit64_0f|jit64_wrappers] or --all to pick which tables to generate"
);

// name -> { module, params: [rust type], task_switch_test, sse }
const wrappers = new Map();

// Returns [rust expression, jit64::A variant] or undefined
function gen_read_imm(op, size_variant)
{
    const size = (op.os || op.opcode % 2 === 1) ? size_variant : 8;

    if(op.imm8) return ["ctx.cpu.read_imm8() as i32", "I32"];
    if(op.imm8s) return ["ctx.cpu.read_imm8s() as i32", "I32"];
    if(op.immaddr) return ["ctx.cpu.read_moffs64()", "I64"];
    if(op.imm16 || op.imm1632 && size === 16) return ["ctx.cpu.read_imm16() as i32", "I32"];
    if(op.imm3264 && size === 64) return ["ctx.cpu.read_imm64()", "I64"];
    if(op.imm32 || op.imm1632) return ["ctx.cpu.read_imm32() as i32", "I32"];
    return undefined;
}

function make_instruction_name(encoding, size)
{
    const suffix = encoding.os ? String(size) : "";
    const opcode_hex = hex(encoding.opcode & 0xFF, 2);
    const first_prefix = (encoding.opcode & 0xFF00) === 0 ? "" : hex(encoding.opcode >> 8 & 0xFF, 2);
    const second_prefix = (encoding.opcode & 0xFF0000) === 0 ? "" : hex(encoding.opcode >> 16 & 0xFF, 2);
    const fixed_g_suffix = encoding.fixed_g === undefined ? "" : `_${encoding.fixed_g}`;

    assert(first_prefix === "" || first_prefix === "0F" || first_prefix === "F2" || first_prefix === "F3");
    assert(second_prefix === "" || second_prefix === "66" || second_prefix === "F2" || second_prefix === "F3");

    return `instr${suffix}_${second_prefix}${first_prefix}${opcode_hex}${fixed_g_suffix}`;
}

function instruction_module(encoding)
{
    return (encoding.opcode & 0xFF00) === 0x0F00 || (encoding.opcode & 0xFF0000) === 0x0F0000 ?
        "instructions_0f" : "instructions";
}

function register_wrapper(encoding, handler, params)
{
    const name = "jit64_" + handler;
    const existing = wrappers.get(name);
    const wrapper = {
        handler: instruction_module(encoding) + "::" + handler,
        params,
        task_switch_test: !!encoding.task_switch_test,
        sse: !!encoding.sse,
    };
    if(existing)
    {
        assert.deepEqual(existing, wrapper, "conflicting wrapper " + name);
    }
    wrappers.set(name, wrapper);
    return name;
}

const RUST_TYPE = { I32: "i32", I64: "u64" };

const JUMP_OPCODES = new Set([
    ...Array.from({ length: 16 }, (_, i) => 0x70 | i),
    ...Array.from({ length: 16 }, (_, i) => 0x0F80 | i),
    0xE9, 0xEB,
]);

function gen_instruction_body(encodings, size)
{
    const encoding = encodings[0];

    let has_66 = [];
    let has_f2 = [];
    let has_f3 = [];
    let no_prefix = [];

    for(let e of encodings)
    {
        if((e.opcode >>> 16) === 0x66) has_66.push(e);
        else if((e.opcode >>> 8 & 0xFF) === 0xF2 || (e.opcode >>> 16) === 0xF2) has_f2.push(e);
        else if((e.opcode >>> 8 & 0xFF) === 0xF3 || (e.opcode >>> 16) === 0xF3) has_f3.push(e);
        else no_prefix.push(e);
    }

    const code = [];

    if(encoding.e)
    {
        code.push("let modrm_byte = ctx.cpu.read_imm8();");
    }

    if(has_66.length || has_f2.length || has_f3.length)
    {
        const if_blocks = [];

        if(has_66.length) {
            const body = gen_instruction_body_after_prefix(has_66, size);
            if_blocks.push({ condition: "ctx.cpu.prefixes & prefix::PREFIX_66 != 0", body, });
        }
        if(has_f2.length) {
            const body = gen_instruction_body_after_prefix(has_f2, size);
            if_blocks.push({ condition: "ctx.cpu.prefixes & prefix::PREFIX_F2 != 0", body, });
        }
        if(has_f3.length) {
            const body = gen_instruction_body_after_prefix(has_f3, size);
            if_blocks.push({ condition: "ctx.cpu.prefixes & prefix::PREFIX_F3 != 0", body, });
        }

        const else_block = {
            body: gen_instruction_body_after_prefix(no_prefix, size),
        };

        return [].concat(code, { type: "if-else", if_blocks, else_block });
    }
    else
    {
        return [].concat(code, gen_instruction_body_after_prefix(encodings, size));
    }
}

function gen_instruction_body_after_prefix(encodings, size)
{
    const encoding = encodings[0];

    if(encoding.fixed_g !== undefined)
    {
        assert(encoding.e);

        let cases = encodings.reduce((cases_by_opcode, case_) => {
            assert(typeof case_.fixed_g === "number");
            cases_by_opcode[case_.opcode & 0xFFFF | case_.fixed_g << 16] = case_;
            return cases_by_opcode;
        }, Object.create(null));
        cases = Object.values(cases).sort((e1, e2) => e1.fixed_g - e2.fixed_g);

        return [
            {
                type: "switch",
                condition: "modrm_byte >> 3 & 7",
                cases: cases.map(case_ => ({
                    conditions: [case_.fixed_g],
                    body: gen_instruction_body_after_fixed_g(case_, size),
                })),
                default_case: {
                    body: [
                        "jit64::skip_modrm(ctx.cpu, modrm_byte);",
                        `jit64::gen_generic(ctx, "jit64_trigger_ud", &[]);`,
                        "*instr_flags |= jit::JIT_INSTR_BLOCK_BOUNDARY_FLAG;",
                    ],
                },
            },
        ];
    }
    else
    {
        assert(encodings.length === 1);
        return gen_instruction_body_after_fixed_g(encodings[0], size);
    }
}

function gen_instruction_body_after_fixed_g(encoding, size)
{
    const name = make_instruction_name(encoding, size);
    const postfix = [];

    if(encoding.block_boundary && !(JUMP_OPCODES.has(encoding.opcode) && size !== 16))
    {
        postfix.push("*instr_flags |= jit::JIT_INSTR_BLOCK_BOUNDARY_FLAG;");
    }

    if(encoding.prefix)
    {
        // prefixes and 0x0F
        return [`jit64::${name}_jit64(ctx, instr_flags);`];
    }

    const imm = gen_read_imm(encoding, size);

    // relative jumps with 32/64-bit operand size: generated by the block glue in jit.rs
    if(JUMP_OPCODES.has(encoding.opcode) && size !== 16)
    {
        assert(imm);
        return [`let _ = ${imm[0]};`];
    }
    if(encoding.opcode === 0xE8 && size === 64)
    {
        return [`let imm = ${imm[0]};`, "jit64::instr64_E8_jit64(ctx, imm);"].concat(postfix);
    }
    if(encoding.opcode === 0xFB)
    {
        return ["jit64::instr_FB_jit64(ctx);"];
    }
    if(encoding.opcode === 0x8D)
    {
        return [`jit64::instr_8D_jit64(ctx, modrm_byte, ${size});`];
    }
    if(encoding.opcode === 0x8F)
    {
        return ["jit64::instr_8F_jit64(ctx, modrm_byte, instr_flags);"];
    }
    assert(!encoding.custom_modrm_resolve, "unhandled custom_modrm_resolve: " + name);

    // generic: call the interpreter's handler through a wrapper

    if(encoding.e)
    {
        const reg_args = ["jit64::A::I32((modrm_byte & 7) as i32 | ctx.cpu.rex_b() as i32)"];
        const reg_params = ["i32"];
        const mem_args = [];
        const mem_params = ["u64"];

        if(encoding.ignore_mod)
        {
            assert(!imm);
            const wrapper = register_wrapper(encoding, name, ["i32", "i32"]);
            return [].concat(
                `jit64::gen_generic(ctx, "${wrapper}", &[` +
                    "jit64::A::I32((modrm_byte & 7) as i32 | ctx.cpu.rex_b() as i32), " +
                    "jit64::A::I32((modrm_byte >> 3 & 7) as i32 | ctx.cpu.rex_r() as i32)]);",
                postfix
            );
        }

        if(encoding.fixed_g === undefined)
        {
            const r = "jit64::A::I32((modrm_byte >> 3 & 7) as i32 | ctx.cpu.rex_r() as i32)";
            reg_args.push(r);
            reg_params.push("i32");
            mem_args.push(r);
            mem_params.push("i32");
        }

        const imm_binding = [];
        if(imm)
        {
            imm_binding.push(`let imm = jit64::A::${imm[1]}(${imm[0]});`);
            reg_args.push("imm");
            reg_params.push(RUST_TYPE[imm[1]]);
            mem_args.push("imm");
            mem_params.push(RUST_TYPE[imm[1]]);
        }

        const mem_wrapper = register_wrapper(encoding, name + "_mem", mem_params);
        const reg_wrapper = register_wrapper(encoding, name + "_reg", reg_params);

        return [].concat(
            {
                type: "if-else",
                if_blocks: [{
                    condition: "modrm_byte < 0xC0",
                    body: [].concat(
                        "let addr = jit64::decode_modrm(ctx.cpu, modrm_byte);",
                        imm_binding,
                        `jit64::gen_generic_mem(ctx, "${mem_wrapper}", &addr, &[${mem_args.join(", ")}]);`
                    ),
                }],
                else_block: {
                    body: [].concat(
                        imm_binding,
                        `jit64::gen_generic(ctx, "${reg_wrapper}", &[${reg_args.join(", ")}]);`
                    ),
                },
            },
            postfix
        );
    }
    else
    {
        const args = [];
        const params = [];
        const bindings = [];

        if(imm)
        {
            bindings.push(`let imm = jit64::A::${imm[1]}(${imm[0]});`);
            args.push("imm");
            params.push(RUST_TYPE[imm[1]]);
        }
        if(encoding.extra_imm16)
        {
            assert(imm);
            bindings.push("let imm2 = jit64::A::I32(ctx.cpu.read_imm16() as i32);");
            args.push("imm2");
            params.push("i32");
        }
        else if(encoding.extra_imm8)
        {
            assert(imm);
            bindings.push("let imm2 = jit64::A::I32(ctx.cpu.read_imm8() as i32);");
            args.push("imm2");
            params.push("i32");
        }

        const wrapper = register_wrapper(encoding, name, params);
        return [].concat(
            bindings,
            `jit64::gen_generic(ctx, "${wrapper}", &[${args.join(", ")}]);`,
            postfix
        );
    }
}

function gen_cases(by_opcode)
{
    const cases = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        const encoding = by_opcode[opcode];
        assert(encoding && encoding.length);

        if(encoding[0].os)
        {
            for(const [tier, size] of [[0, 16], [1, 32], [2, 64]])
            {
                cases.push({
                    conditions: [`0x${hex(opcode | tier << 8, 2)}`],
                    body: gen_instruction_body(encoding, size),
                });
            }
        }
        else
        {
            cases.push({
                conditions: [0, 1, 2].map(tier => `0x${hex(opcode | tier << 8, 2)}`),
                body: gen_instruction_body(encoding, undefined),
            });
        }
    }
    return {
        type: "switch",
        condition: "opcode",
        cases,
        default_case: {
            body: ["assert!(false);"]
        },
    };
}

function gen_wrappers()
{
    const code = [
        "#![allow(unused_variables)]",
        "use crate::cpu::cpu::{task_switch_test, task_switch_test_mmx, trigger_ud};",
        "use crate::cpu::instructions;",
        "use crate::cpu::instructions_0f;",
        "use crate::jit64::{jit64_enter, jit64_leave};",
        "",
        "#[no_mangle]",
        "pub unsafe fn jit64_trigger_ud(ips: i32, prefixes: i32) -> i32 { jit64_enter(ips, prefixes); trigger_ud(); jit64_leave() }",
    ];

    const names = Array.from(wrappers.keys()).sort();
    for(const name of names)
    {
        const w = wrappers.get(name);
        const params = w.params.map((t, i) => `a${i}: ${t}`);
        const args = w.params.map((t, i) => `a${i}`);
        const check = w.sse ? "if !task_switch_test_mmx() { return jit64_leave(); } " :
            w.task_switch_test ? "if !task_switch_test() { return jit64_leave(); } " : "";
        code.push("#[no_mangle]");
        code.push(
            `pub unsafe fn ${name}(${["ips: i32", "prefixes: i32"].concat(params).join(", ")}) -> i32 { ` +
            `jit64_enter(ips, prefixes); ${check}${w.handler}(${args.join(", ")}); jit64_leave() }`
        );
    }
    return code.join("\n") + "\n";
}

function gen_table()
{
    let by_opcode = Object.create(null);
    let by_opcode0f = Object.create(null);

    for(let o of x86_table)
    {
        let opcode = o.opcode;

        if((opcode & 0xFF00) === 0x0F00)
        {
            opcode &= 0xFF;
            by_opcode0f[opcode] = by_opcode0f[opcode] || [];
            by_opcode0f[opcode].push(o);
        }
        else
        {
            opcode &= 0xFF;
            by_opcode[opcode] = by_opcode[opcode] || [];
            by_opcode[opcode].push(o);
        }
    }

    const header = [
        "#![allow(unused)]",
        "#[cfg_attr(rustfmt, rustfmt_skip)]",
        "use crate::prefix;",
        "use crate::jit;",
        "use crate::jit64;",
        "pub fn jit(opcode: u32, ctx: &mut jit::JitContext, instr_flags: &mut u32) {",
    ];

    // both tables are always generated, as the wrappers are collected from them
    const table = gen_cases(by_opcode);
    const table0f = gen_cases(by_opcode0f);

    if(to_generate.jit64)
    {
        finalize_table_rust(
            OUT_DIR,
            "jit64.rs",
            rust_ast.print_syntax_tree([].concat(header, table, "}")).join("\n") + "\n"
        );
    }
    if(to_generate.jit64_0f)
    {
        finalize_table_rust(
            OUT_DIR,
            "jit64_0f.rs",
            rust_ast.print_syntax_tree([].concat(header, table0f, "}")).join("\n") + "\n"
        );
    }
    if(to_generate.jit64_wrappers)
    {
        finalize_table_rust(OUT_DIR, "jit64_wrappers.rs", gen_wrappers());
    }
}

gen_table();
