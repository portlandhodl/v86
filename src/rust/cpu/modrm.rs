use crate::cpu::cpu::*;
use crate::cpu::global_pointers::instruction_pointer;
use crate::paging::OrPageFault;

pub unsafe fn resolve_modrm16(modrm_byte: i32) -> OrPageFault<u64> {
    match modrm_byte & !0o070 {
        0o000 => Ok(get_seg_prefix_ds((read_reg16(BX) + read_reg16(SI) & 0xFFFF) as u32 as u64)?),
        0o100 => Ok(get_seg_prefix_ds((read_reg16(BX) + read_reg16(SI) + read_imm8s()? & 0xFFFF) as u32 as u64)?),
        0o200 => Ok(get_seg_prefix_ds((read_reg16(BX) + read_reg16(SI) + read_imm16()? & 0xFFFF) as u32 as u64)?),
        0o001 => Ok(get_seg_prefix_ds((read_reg16(BX) + read_reg16(DI) & 0xFFFF) as u32 as u64)?),
        0o101 => Ok(get_seg_prefix_ds((read_reg16(BX) + read_reg16(DI) + read_imm8s()? & 0xFFFF) as u32 as u64)?),
        0o201 => Ok(get_seg_prefix_ds((read_reg16(BX) + read_reg16(DI) + read_imm16()? & 0xFFFF) as u32 as u64)?),
        0o002 => Ok(get_seg_prefix_ss((read_reg16(BP) + read_reg16(SI) & 0xFFFF) as u32 as u64)?),
        0o102 => Ok(get_seg_prefix_ss((read_reg16(BP) + read_reg16(SI) + read_imm8s()? & 0xFFFF) as u32 as u64)?),
        0o202 => Ok(get_seg_prefix_ss((read_reg16(BP) + read_reg16(SI) + read_imm16()? & 0xFFFF) as u32 as u64)?),
        0o003 => Ok(get_seg_prefix_ss((read_reg16(BP) + read_reg16(DI) & 0xFFFF) as u32 as u64)?),
        0o103 => Ok(get_seg_prefix_ss((read_reg16(BP) + read_reg16(DI) + read_imm8s()? & 0xFFFF) as u32 as u64)?),
        0o203 => Ok(get_seg_prefix_ss((read_reg16(BP) + read_reg16(DI) + read_imm16()? & 0xFFFF) as u32 as u64)?),
        0o004 => Ok(get_seg_prefix_ds((read_reg16(SI) & 0xFFFF) as u32 as u64)?),
        0o104 => Ok(get_seg_prefix_ds((read_reg16(SI) + read_imm8s()? & 0xFFFF) as u32 as u64)?),
        0o204 => Ok(get_seg_prefix_ds((read_reg16(SI) + read_imm16()? & 0xFFFF) as u32 as u64)?),
        0o005 => Ok(get_seg_prefix_ds((read_reg16(DI) & 0xFFFF) as u32 as u64)?),
        0o105 => Ok(get_seg_prefix_ds((read_reg16(DI) + read_imm8s()? & 0xFFFF) as u32 as u64)?),
        0o205 => Ok(get_seg_prefix_ds((read_reg16(DI) + read_imm16()? & 0xFFFF) as u32 as u64)?),
        0o006 => Ok(get_seg_prefix_ds((read_imm16()?) as u32 as u64)?),
        0o106 => Ok(get_seg_prefix_ss((read_reg16(BP) + read_imm8s()? & 0xFFFF) as u32 as u64)?),
        0o206 => Ok(get_seg_prefix_ss((read_reg16(BP) + read_imm16()? & 0xFFFF) as u32 as u64)?),
        0o007 => Ok(get_seg_prefix_ds((read_reg16(BX) & 0xFFFF) as u32 as u64)?),
        0o107 => Ok(get_seg_prefix_ds((read_reg16(BX) + read_imm8s()? & 0xFFFF) as u32 as u64)?),
        0o207 => Ok(get_seg_prefix_ds((read_reg16(BX) + read_imm16()? & 0xFFFF) as u32 as u64)?),
        _ => {
            dbg_assert!(false);
            std::hint::unreachable_unchecked()
        },
    }
}

pub unsafe fn resolve_modrm32_(modrm_byte: i32) -> OrPageFault<u64> {
    let r = (modrm_byte & 7) as u8;
    dbg_assert!(modrm_byte < 192);
    Ok(if r as i32 == 4 {
        if modrm_byte < 64 {
            resolve_sib(false)?
        }
        else {
            (resolve_sib(true)? as i32
                + if modrm_byte < 128 { read_imm8s()? } else { read_imm32s()? })
                as u32 as u64
        }
    }
    else if r as i32 == 5 {
        if modrm_byte < 64 {
            get_seg_prefix_ds(read_imm32s()? as u32 as u64)?
        }
        else {
            get_seg_prefix_ss(
                (read_reg32(EBP)
                    + if modrm_byte < 128 { read_imm8s()? } else { read_imm32s()? })
                    as u32 as u64,
            )?
        }
    }
    else if modrm_byte < 64 {
        get_seg_prefix_ds(read_reg32(r as i32) as u32 as u64)?
    }
    else {
        get_seg_prefix_ds(
            (read_reg32(r as i32)
                + if modrm_byte < 128 { read_imm8s()? } else { read_imm32s()? })
                as u32 as u64,
        )?
    })
}
unsafe fn resolve_sib(with_imm: bool) -> OrPageFault<u64> {
    let sib_byte = read_imm8()?;
    let r = sib_byte & 7;
    let m = sib_byte >> 3 & 7;
    let base;
    let seg;
    if r == 4 {
        base = read_reg32(ESP);
        seg = SS
    }
    else if r == 5 {
        if with_imm {
            base = read_reg32(EBP);
            seg = SS
        }
        else {
            base = read_imm32s()?;
            seg = DS
        }
    }
    else {
        base = read_reg32(r);
        seg = DS
    }
    let offset;
    if m == 4 {
        offset = 0
    }
    else {
        let s = sib_byte >> 6 & 3;
        offset = read_reg32(m) << s
    }
    Ok((get_seg_prefix(seg)?).wrapping_add(base).wrapping_add(offset) as u32 as u64)
}

// 64-bit addressing (long mode, no 0x67 prefix). REX.B extends the base
// register, REX.X the SIB index; mod=00 rm=101 is RIP+disp32 relative.
// imm_len is the number of immediate bytes following the modrm/sib/disp
// (needed for RIP-relative addressing, which is relative to the end of the
// whole instruction).
pub unsafe fn resolve_modrm64(modrm_byte: i32, imm_len: i32) -> OrPageFault<u64> {
    dbg_assert!(modrm_byte < 192);
    let r = modrm_byte & 7;
    if r == 4 {
        // SIB byte
        let sib_byte = read_imm8()?;
        let base_field = sib_byte & 7;
        let index_field = sib_byte >> 3 & 7;
        let scale = sib_byte >> 6 & 3;

        let index_value = if index_field == 4 {
            // no index (rsp/r12 cannot be an index)
            0
        }
        else {
            read_reg64(index_field | rex_x()) << scale
        };

        let base;
        let seg;
        if base_field == 5 && modrm_byte < 64 {
            // disp32 with no base register; with REX.B this is r13 + disp32
            let disp32 = read_imm32s()? as i64 as u64;
            if rex_b() != 0 {
                base = read_reg64(13).wrapping_add(disp32);
                seg = SS;
            }
            else {
                base = disp32;
                seg = DS;
            }
        }
        else {
            base = read_reg64(base_field | rex_b());
            seg = if base_field == 4 || base_field == 5 { SS } else { DS };
        }

        let disp: i64 = if modrm_byte < 64 {
            0
        }
        else if modrm_byte < 128 {
            read_imm8s()? as i64
        }
        else {
            read_imm32s()? as i64
        };

        Ok((get_seg_prefix64(seg)?)
            .wrapping_add(base)
            .wrapping_add(index_value)
            .wrapping_add(disp as u64))
    }
    else if r == 5 && modrm_byte < 64 {
        // RIP + disp32 (relative to the end of the whole instruction)
        let disp = read_imm32s()? as i64 as u64;
        let rip = (*instruction_pointer).wrapping_add(imm_len as u64);
        Ok(get_seg_prefix64(DS)?.wrapping_add(rip).wrapping_add(disp))
    }
    else {
        let base = read_reg64(r | rex_b());
        let seg = if r == 5 { SS } else { DS };
        let disp: i64 = if modrm_byte < 64 {
            0
        }
        else if modrm_byte < 128 {
            read_imm8s()? as i64
        }
        else {
            read_imm32s()? as i64
        };
        Ok(get_seg_prefix64(seg)?.wrapping_add(base).wrapping_add(disp as u64))
    }
}

pub unsafe fn resolve_modrm32(modrm_byte: i32) -> OrPageFault<u64> {
    match modrm_byte & !0o070 {
        0o000 => Ok(get_seg_prefix_ds((read_reg32(EAX)) as u32 as u64)?),
        0o100 => Ok(get_seg_prefix_ds((read_reg32(EAX) + read_imm8s()?) as u32 as u64)?),
        0o200 => Ok(get_seg_prefix_ds((read_reg32(EAX) + read_imm32s()?) as u32 as u64)?),
        0o001 => Ok(get_seg_prefix_ds((read_reg32(ECX)) as u32 as u64)?),
        0o101 => Ok(get_seg_prefix_ds((read_reg32(ECX) + read_imm8s()?) as u32 as u64)?),
        0o201 => Ok(get_seg_prefix_ds((read_reg32(ECX) + read_imm32s()?) as u32 as u64)?),
        0o002 => Ok(get_seg_prefix_ds((read_reg32(EDX)) as u32 as u64)?),
        0o102 => Ok(get_seg_prefix_ds((read_reg32(EDX) + read_imm8s()?) as u32 as u64)?),
        0o202 => Ok(get_seg_prefix_ds((read_reg32(EDX) + read_imm32s()?) as u32 as u64)?),
        0o003 => Ok(get_seg_prefix_ds((read_reg32(EBX)) as u32 as u64)?),
        0o103 => Ok(get_seg_prefix_ds((read_reg32(EBX) + read_imm8s()?) as u32 as u64)?),
        0o203 => Ok(get_seg_prefix_ds((read_reg32(EBX) + read_imm32s()?) as u32 as u64)?),
        0o004 => resolve_sib(false),
        0o104 => Ok((resolve_sib(true)? as i32 + read_imm8s()?) as u32 as u64),
        0o204 => Ok((resolve_sib(true)? as i32 + read_imm32s()?) as u32 as u64),
        0o005 => Ok(get_seg_prefix_ds((read_imm32s()?) as u32 as u64)?),
        0o105 => Ok(get_seg_prefix_ss((read_reg32(EBP) + read_imm8s()?) as u32 as u64)?),
        0o205 => Ok(get_seg_prefix_ss((read_reg32(EBP) + read_imm32s()?) as u32 as u64)?),
        0o006 => Ok(get_seg_prefix_ds((read_reg32(ESI)) as u32 as u64)?),
        0o106 => Ok(get_seg_prefix_ds((read_reg32(ESI) + read_imm8s()?) as u32 as u64)?),
        0o206 => Ok(get_seg_prefix_ds((read_reg32(ESI) + read_imm32s()?) as u32 as u64)?),
        0o007 => Ok(get_seg_prefix_ds((read_reg32(EDI)) as u32 as u64)?),
        0o107 => Ok(get_seg_prefix_ds((read_reg32(EDI) + read_imm8s()?) as u32 as u64)?),
        0o207 => Ok(get_seg_prefix_ds((read_reg32(EDI) + read_imm32s()?) as u32 as u64)?),
        _ => {
            dbg_assert!(false);
            std::hint::unreachable_unchecked()
        },
    }
}
