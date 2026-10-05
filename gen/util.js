import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CYAN_FMT = "\x1b[36m%s\x1b[0m";

export function hex(n, pad)
{
    pad = pad || 0;
    let s = n.toString(16).toUpperCase();
    while(s.length < pad) s = "0" + s;
    return s;
}

export function get_switch_value(arg_switch)
{
    const argv = process.argv;
    const switch_i = argv.indexOf(arg_switch);
    const val_i = switch_i + 1;
    if(switch_i > -1 && val_i < argv.length)
    {
        return argv[switch_i + 1];
    }
    return null;
}

export function get_switch_exist(arg_switch)
{
    return process.argv.includes(arg_switch);
}

export function finalize_table_rust(out_dir, name, contents)
{
    const file_path = path.join(out_dir, name);
    fs.writeFileSync(file_path, contents);
    console.log(CYAN_FMT, `[+] Wrote table ${name}.`);
}

// The opcode maps of the x86 table: one-byte opcodes, 0F xx, 0F 38 xx and 0F 3A xx. Entries of the
// three-byte maps have a `map` property (0x38 or 0x3A) and are otherwise encoded like 0F entries
// (opcode: [66|F2|F3]0Fxx).
export const OPCODE_MAPS = ["", "0f", "0f38", "0f3a"];

export function opcode_map_of(encoding)
{
    if(encoding.map) return "0f" + hex(encoding.map, 2).toLowerCase();
    return (encoding.opcode & 0xFF00) === 0x0F00 ? "0f" : "";
}

// map -> low opcode byte -> encodings
export function group_by_opcode_map(table)
{
    const result = Object.create(null);
    for(const map of OPCODE_MAPS) result[map] = Object.create(null);
    for(const encoding of table)
    {
        const by_opcode = result[opcode_map_of(encoding)];
        const opcode = encoding.opcode & 0xFF;
        (by_opcode[opcode] = by_opcode[opcode] || []).push(encoding);
    }
    return result;
}

// The part of an instruction name after "0F" that names a three-byte map ("38" or "3A")
export function map_name_part(encoding)
{
    return encoding.map ? hex(encoding.map, 2) : "";
}
