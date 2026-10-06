mod ext {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn mmap_read8(addr: u32) -> i32;
        pub fn mmap_read32(addr: u32) -> i32;

        pub fn mmap_write8(addr: u32, value: i32);
        pub fn mmap_write16(addr: u32, value: i32);
        pub fn mmap_write32(addr: u32, value: i32);
        pub fn mmap_write64(addr: u32, v0: i32, v1: i32);
        pub fn mmap_write128(addr: u32, v0: i32, v1: i32, v2: i32, v3: i32);
    }
}

use crate::cpu::apic;
use crate::cpu::cpu::{
    handle_irqs_or_defer, reg128, APIC_MEM_ADDRESS, APIC_MEM_SIZE, IOAPIC_MEM_ADDRESS, IOAPIC_MEM_SIZE,
};
use crate::cpu::global_pointers::{high_memory_size, memory_size};
use crate::cpu::guest;
use crate::cpu::ioapic;
use crate::cpu::vga;
use crate::jit;
use crate::page::Page;

use std::alloc;
use std::ptr;

// Guest physical addresses are u64. Guest RAM is stored contiguously at host offsets (relative
// to mem8) given by phys_to_host; all accesses to it go through cpu::guest.
//
// Layout: RAM below the PCI hole is [0, memory_size); under mem64, RAM above 4 GiB is
// [HIGH_MEMORY_START, HIGH_MEMORY_START + high_memory_size) and is stored right after the low
// RAM, at host offset memory_size.
//
// phys_to_host must be a bijection on all physical addresses, not only on RAM: tlb entries
// encode the host address of every page (mmio pages included) and phys_of_tlb_entry decodes
// it with host_to_phys. Under mem64, the hole between the low RAM and 4 GiB is therefore
// moved out of the way of the high RAM, to HOLE_HOST_BIAS + phys (never accessed as RAM).

pub const HIGH_MEMORY_START: u64 = 0x1_0000_0000;
#[cfg(feature = "mem64")]
const HOLE_HOST_BIAS: u64 = 1 << 40;
#[cfg(feature = "mem64")]
const _: () = assert!(HOLE_HOST_BIAS >= 1 << crate::cpu::cpu::PHYSICAL_ADDRESS_BITS);

#[allow(non_upper_case_globals)]
pub static mut mem8: *mut u8 = ptr::null_mut();

/// The host offset (relative to mem8) of a physical address (only RAM may be accessed there)
#[cfg(not(feature = "mem64"))]
#[inline(always)]
pub fn phys_to_host(phys: u64) -> u64 { phys }
#[cfg(feature = "mem64")]
#[inline(always)]
pub fn phys_to_host(phys: u64) -> u64 {
    let low = unsafe { *memory_size } as u64;
    if phys < low {
        phys
    }
    else if phys >= HIGH_MEMORY_START {
        phys - HIGH_MEMORY_START + low
    }
    else {
        // the hole below 4 GiB (mmio)
        phys + HOLE_HOST_BIAS
    }
}

/// The physical address of a host offset (relative to mem8); the inverse of phys_to_host
#[cfg(not(feature = "mem64"))]
#[inline(always)]
pub fn host_to_phys(host: u64) -> u64 { host }
#[cfg(feature = "mem64")]
#[inline(always)]
pub fn host_to_phys(host: u64) -> u64 {
    let low = unsafe { *memory_size } as u64;
    if host < low {
        host
    }
    else if host >= HOLE_HOST_BIAS {
        host - HOLE_HOST_BIAS
    }
    else {
        host - low + HIGH_MEMORY_START
    }
}

/// The host address that is baked into tlb entries for the physical page at phys (see
/// do_page_walk); the fast paths compute the host address as (entry & !0xFFF) ^ virt_addr
#[inline(always)]
pub fn tlb_host_base(phys: u64) -> u64 { unsafe { phys_to_host(phys) + mem8 as u64 } }

/// The inverse of tlb_host_base
#[inline(always)]
pub fn phys_of_tlb_host_base(host: u64) -> u64 { unsafe { host_to_phys(host - mem8 as u64) } }

/// Allocate guest RAM. It's placed in newly grown wasm memory pages instead of the rust heap,
/// whose allocations are limited to isize::MAX (2 GiB) bytes. Fresh pages are zeroed.
///
/// Under mem64, guest RAM is the separate 64-bit memory 1, grown from JS (create_memory);
/// mem8 stays null, so tlb_host_base is the identity (host offsets are the physical addresses).
#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(mem8.is_null());
    };
    dbg_log!("Allocate memory size={}m", size >> 20);
    const WASM_PAGE_SIZE: usize = 0x10000;
    dbg_assert!(size as usize % WASM_PAGE_SIZE == 0);
    #[cfg(all(target_arch = "wasm32", not(feature = "mem64")))]
    let ptr = {
        let previous_pages = core::arch::wasm32::memory_grow(0, size as usize / WASM_PAGE_SIZE);
        assert!(previous_pages != usize::MAX, "Failed to allocate guest memory");
        (previous_pages * WASM_PAGE_SIZE) as *mut u8
    };
    // guest RAM is memory 1 in this build; grown by JS (rust can't address a second memory)
    #[cfg(all(target_arch = "wasm32", feature = "mem64"))]
    let ptr = ptr::null_mut();
    #[cfg(not(target_arch = "wasm32"))]
    let ptr = unsafe {
        alloc::alloc_zeroed(alloc::Layout::from_size_align(size as usize, WASM_PAGE_SIZE).unwrap())
    };
    unsafe {
        mem8 = ptr;
    };
    ptr as u32
}

pub fn zero_memory(addr: u64, size: u64) { guest::fill(phys_to_host(addr), 0, size) }
#[export_name = "zero_memory"]
pub fn zero_memory_js(addr: u32, size: u32) { zero_memory(addr as u64, size as u64) }
#[export_name = "zero_memory_phys64"]
pub fn zero_memory_phys64_js(addr: f64, size: u32) { zero_memory(addr as u64, size as u64) }

#[allow(non_upper_case_globals)]
pub static mut vga_mem8: *mut u8 = ptr::null_mut();
#[allow(non_upper_case_globals)]
pub static mut vga_memory_size: u32 = 0;

#[no_mangle]
pub fn svga_allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(vga_mem8.is_null());
    };
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) };
    dbg_assert!(
        size & (1 << 12 << 6) == 0,
        "size not aligned to dirty_bitmap"
    );
    unsafe {
        vga_mem8 = ptr;
        vga_memory_size = size;
        vga::set_dirty_bitmap_size(size >> 12 >> 6);
    };
    ptr as u32
}

/// Whether accesses to the physical address go through mmio (or hit nothing) instead of RAM
pub fn in_mapped_range(addr: u64) -> bool {
    if addr < unsafe { *memory_size } as u64 {
        addr >= 0xA0000 && addr < 0xC0000
    }
    else {
        // high_memory_size is 0 in the default build
        addr.wrapping_sub(HIGH_MEMORY_START) >= unsafe { *high_memory_size }
    }
}
#[export_name = "in_mapped_range"]
pub fn in_mapped_range_js(addr: u32) -> bool { in_mapped_range(addr as u64) }
/// in_mapped_range for physical addresses that may be above 4 GiB (exact up to 2^53)
#[export_name = "in_mapped_range_phys64"]
pub fn in_mapped_range_phys64_js(addr: f64) -> bool { in_mapped_range(addr as u64) }

pub const VGA_LFB_ADDRESS: u32 = 0xE0000000;
pub fn in_svga_lfb(addr: u64) -> bool {
    addr >= VGA_LFB_ADDRESS as u64
        && addr <= unsafe { VGA_LFB_ADDRESS as u64 + (vga_memory_size as u64 - 1) }
}
fn in_apic(addr: u64) -> bool {
    addr >= APIC_MEM_ADDRESS as u64 && addr < APIC_MEM_ADDRESS as u64 + APIC_MEM_SIZE as u64
}
fn in_ioapic(addr: u64) -> bool {
    addr >= IOAPIC_MEM_ADDRESS as u64 && addr < IOAPIC_MEM_ADDRESS as u64 + IOAPIC_MEM_SIZE as u64
}
/// Mapped addresses above 4 GiB: there are no devices there, reads return all ones and writes
/// are dropped
fn above_mmio_space(addr: u64) -> bool { addr > u32::MAX as u64 }

fn lfb_ptr(addr: u64) -> *mut u8 {
    unsafe { vga_mem8.offset((addr - VGA_LFB_ADDRESS as u64) as isize) }
}

pub fn read8(addr: u64) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe { *lfb_ptr(addr) as i32 }
        }
        else if in_apic(addr) {
            apic::read32((addr as u32 - APIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
        }
        else if in_ioapic(addr) {
            ioapic::read32((addr as u32 - IOAPIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
        }
        else if above_mmio_space(addr) {
            0xFF
        }
        else {
            unsafe { ext::mmap_read8(addr as u32) }
        }
    }
    else {
        read8_no_mmap_check(addr)
    }
}
#[export_name = "read8"]
pub fn read8_js(addr: u32) -> i32 { read8(addr as u64) }
pub fn read8_no_mmap_check(addr: u64) -> i32 { guest::load8(phys_to_host(addr)) as i32 }

pub fn read16(addr: u64) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe { ptr::read_unaligned(lfb_ptr(addr) as *const u16) as i32 }
        }
        else {
            read8(addr) | read8(addr + 1) << 8
        }
    }
    else {
        read16_no_mmap_check(addr)
    }
}
#[export_name = "read16"]
pub fn read16_js(addr: u32) -> i32 { read16(addr as u64) }
#[export_name = "read16_phys64"]
pub fn read16_phys64_js(addr: f64) -> i32 { read16(addr as u64) }
pub fn read16_no_mmap_check(addr: u64) -> i32 { guest::load16(phys_to_host(addr)) as i32 }

pub fn read32s(addr: u64) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe { ptr::read_unaligned(lfb_ptr(addr) as *const i32) } // XXX
        }
        else if in_apic(addr) {
            apic::read32(addr as u32 - APIC_MEM_ADDRESS) as i32
        }
        else if in_ioapic(addr) {
            ioapic::read32(addr as u32 - IOAPIC_MEM_ADDRESS) as i32
        }
        else if above_mmio_space(addr) {
            -1
        }
        else {
            unsafe { ext::mmap_read32(addr as u32) }
        }
    }
    else {
        read32_no_mmap_check(addr)
    }
}
#[export_name = "read32s"]
pub fn read32s_js(addr: u32) -> i32 { read32s(addr as u64) }
#[export_name = "read32s_phys64"]
pub fn read32s_phys64_js(addr: f64) -> i32 { read32s(addr as u64) }
pub fn read32_no_mmap_check(addr: u64) -> i32 { guest::load32(phys_to_host(addr)) as i32 }

pub unsafe fn read64s(addr: u64) -> i64 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            ptr::read_unaligned(lfb_ptr(addr) as *const i64)
        }
        else {
            read32s(addr) as u32 as i64 | (read32s(addr + 4) as i64) << 32
        }
    }
    else {
        guest::load64(phys_to_host(addr)) as i64
    }
}

pub unsafe fn read128(addr: u64) -> reg128 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            ptr::read_unaligned(lfb_ptr(addr) as *const reg128)
        }
        else {
            reg128 {
                i32: [
                    read32s(addr + 0),
                    read32s(addr + 4),
                    read32s(addr + 8),
                    read32s(addr + 12),
                ],
            }
        }
    }
    else {
        guest::load128(phys_to_host(addr))
    }
}

pub unsafe fn write8(addr: u64, value: i32) {
    if in_mapped_range(addr) {
        mmap_write8(addr, value & 0xFF);
    }
    else {
        jit::jit_dirty_page(Page::page_of(addr));
        write8_no_mmap_or_dirty_check(addr, value);
    };
}
#[export_name = "write8"]
pub unsafe fn write8_js(addr: u32, value: i32) { write8(addr as u64, value) }

pub unsafe fn write8_no_mmap_or_dirty_check(addr: u64, value: i32) {
    guest::store8(phys_to_host(addr), value as u8)
}

pub unsafe fn write16(addr: u64, value: i32) {
    if in_mapped_range(addr) {
        mmap_write16(addr, value & 0xFFFF);
    }
    else {
        jit::jit_dirty_cache_small(addr, addr + 2);
        write16_no_mmap_or_dirty_check(addr, value);
    };
}
#[export_name = "write16"]
pub unsafe fn write16_js(addr: u32, value: i32) { write16(addr as u64, value) }
#[export_name = "write16_phys64"]
pub unsafe fn write16_phys64_js(addr: f64, value: i32) { write16(addr as u64, value) }
pub unsafe fn write16_no_mmap_or_dirty_check(addr: u64, value: i32) {
    guest::store16(phys_to_host(addr), value as u16)
}

pub unsafe fn write32(addr: u64, value: i32) {
    if in_mapped_range(addr) {
        mmap_write32(addr, value);
    }
    else {
        jit::jit_dirty_cache_small(addr, addr + 4);
        write32_no_mmap_or_dirty_check(addr, value);
    }
}
#[export_name = "write32"]
pub unsafe fn write32_js(addr: u32, value: i32) { write32(addr as u64, value) }
#[export_name = "write32_phys64"]
pub unsafe fn write32_phys64_js(addr: f64, value: i32) { write32(addr as u64, value) }

pub unsafe fn write32_no_mmap_or_dirty_check(addr: u64, value: i32) {
    guest::store32(phys_to_host(addr), value as u32)
}

pub unsafe fn write64_no_mmap_or_dirty_check(addr: u64, value: u64) {
    guest::store64(phys_to_host(addr), value)
}

pub unsafe fn write128_no_mmap_or_dirty_check(addr: u64, value: reg128) {
    guest::store128(phys_to_host(addr), value)
}

pub unsafe fn memset_no_mmap_or_dirty_check(addr: u64, value: u8, count: u32) {
    guest::fill(phys_to_host(addr), value, count as u64)
}

/// Fill with the little-endian repetition of a 16/32/64-bit value (rep stosw/d/q): the
/// splat is position-independent, so 64-bit stores plus a tail suffice (the address is
/// size-aligned; store64 doesn't require 8-byte alignment)
pub unsafe fn memset_pattern_no_mmap_or_dirty_check(
    addr: u64,
    value: u64,
    size: u32,
    count: u32,
) {
    let v = match size {
        2 => (value & 0xFFFF) * 0x0001_0001_0001_0001,
        4 => (value & 0xFFFF_FFFF) * 0x0000_0001_0000_0001,
        _ => value,
    };
    let mut addr = phys_to_host(addr);
    let mut n = count as u64 * size as u64;
    while n >= 8 {
        guest::store64(addr, v);
        addr += 8;
        n -= 8;
    }
    if n >= 4 {
        guest::store32(addr, v as u32);
        addr += 4;
        n -= 4;
    }
    if n >= 2 {
        guest::store16(addr, v as u16);
        addr += 2;
        n -= 2;
    }
    if n != 0 {
        guest::store8(addr, v as u8);
    }
}

pub unsafe fn memcpy_no_mmap_or_dirty_check(src_addr: u64, dst_addr: u64, count: u32) {
    dbg_assert!(!in_mapped_range(src_addr));
    dbg_assert!(!in_mapped_range(dst_addr));
    guest::copy(phys_to_host(src_addr), phys_to_host(dst_addr), count as u64)
}

pub unsafe fn memcpy_into_svga_lfb(src_addr: u64, dst_addr: u64, count: u32) {
    dbg_assert!(!in_mapped_range(src_addr));
    dbg_assert!(in_svga_lfb(dst_addr));
    dbg_assert!(Page::page_of(dst_addr) == Page::page_of(dst_addr + count as u64 - 1));
    vga::mark_dirty(dst_addr as u32);
    guest::copy_to_core(phys_to_host(src_addr), lfb_ptr(dst_addr), count)
}

pub unsafe fn mmap_write8(addr: u64, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr as u32);
        *lfb_ptr(addr) = value as u8
    }
    else if above_mmio_space(addr) {
    }
    else {
        ext::mmap_write8(addr as u32, value)
    }
}
pub unsafe fn mmap_write16(addr: u64, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr as u32);
        ptr::write_unaligned(lfb_ptr(addr) as *mut u16, value as u16)
    }
    else if above_mmio_space(addr) {
    }
    else {
        ext::mmap_write16(addr as u32, value)
    }
}
pub unsafe fn mmap_write32(addr: u64, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr as u32);
        ptr::write_unaligned(lfb_ptr(addr) as *mut i32, value)
    }
    else if in_apic(addr) {
        apic::write32(addr as u32 - APIC_MEM_ADDRESS, value as u32);
        handle_irqs_or_defer();
    }
    else if in_ioapic(addr) {
        ioapic::write32(addr as u32 - IOAPIC_MEM_ADDRESS, value as u32);
        handle_irqs_or_defer();
    }
    else if above_mmio_space(addr) {
    }
    else {
        ext::mmap_write32(addr as u32, value)
    }
}
pub unsafe fn mmap_write64(addr: u64, value: u64) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr as u32);
        ptr::write_unaligned(lfb_ptr(addr) as *mut u64, value)
    }
    else if above_mmio_space(addr) {
    }
    else {
        ext::mmap_write64(addr as u32, value as i32, (value >> 32) as i32)
    }
}
pub unsafe fn mmap_write128(addr: u64, v0: u64, v1: u64) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr as u32);
        ptr::write_unaligned(lfb_ptr(addr) as *mut u64, v0);
        ptr::write_unaligned(lfb_ptr(addr + 8) as *mut u64, v1)
    }
    else if above_mmio_space(addr) {
    }
    else {
        ext::mmap_write128(
            addr as u32,
            v0 as i32,
            (v0 >> 32) as i32,
            v1 as i32,
            (v1 >> 32) as i32,
        )
    }
}

pub unsafe fn is_memory_zeroed(addr: u64, length: u64) -> bool {
    dbg_assert!(addr % 8 == 0);
    dbg_assert!(length % 8 == 0);
    let host = phys_to_host(addr);
    for i in (host..host + length).step_by(8) {
        if guest::load64(i) != 0 {
            return false;
        }
    }
    return true;
}
#[export_name = "is_memory_zeroed"]
pub unsafe fn is_memory_zeroed_js(addr: u32, length: u32) -> bool {
    is_memory_zeroed(addr as u64, length as u64)
}
