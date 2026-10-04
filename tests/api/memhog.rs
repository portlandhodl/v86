//! memhog: allocate <MiB> of anonymous memory via brk, fill every word with a
//! per-page pattern, then verify it. Freestanding (no_std, no libc) 32-bit
//! program, used by tests/api/2g-mem.js to stress guest RAM.
//!
//! Build (no cargo needed): make tests/api/memhog
//!   (two steps: rustc --emit=obj, then link with the bundled rust-lld —
//!   the stock musl target pulls a crt that conflicts with our _start)

#![no_std]
#![no_main]

use core::arch::asm;

const SYS_EXIT: u32 = 1;
const SYS_WRITE: u32 = 4;
const SYS_BRK: u32 = 45;

const PAGE: u32 = 4096;
const CHUNK: u32 = 16 * 1024 * 1024;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { exit(5) }

// C ABI intrinsics LLVM may emit (no libc to provide them with no_std)
#[no_mangle]
pub unsafe extern "C" fn strlen(mut s: *const u8) -> usize {
    let mut n = 0;
    while *s != 0 {
        s = s.add(1);
        n += 1;
    }
    n
}
#[no_mangle]
pub unsafe extern "C" fn memset(mut dst: *mut u8, v: i32, mut n: usize) -> *mut u8 {
    let start = dst;
    while n > 0 {
        *dst = v as u8;
        dst = dst.add(1);
        n -= 1;
    }
    start
}
#[no_mangle]
pub unsafe extern "C" fn memcpy(mut dst: *mut u8, mut src: *const u8, mut n: usize) -> *mut u8 {
    let start = dst;
    while n > 0 {
        *dst = *src;
        dst = dst.add(1);
        src = src.add(1);
        n -= 1;
    }
    start
}
#[no_mangle]
pub unsafe extern "C" fn memmove(dst: *mut u8, src: *const u8, n: usize) -> *mut u8 {
    // no overlapping copies in this program
    memcpy(dst, src, n)
}
#[no_mangle]
pub unsafe extern "C" fn memcmp(mut a: *const u8, mut b: *const u8, mut n: usize) -> i32 {
    while n > 0 {
        let (x, y) = (*a, *b);
        if x != y { return x as i32 - y as i32 }
        a = a.add(1);
        b = b.add(1);
        n -= 1;
    }
    0
}

#[inline(always)]
fn syscall2(nr: u32, a: u32, b: u32) -> i32 {
    let ret: i32;
    unsafe {
        asm!("int $$0x80",
             inout("eax") nr => ret,
             in("ebx") a,
             in("ecx") b,
             options(nostack));
    }
    ret
}

#[inline(always)]
fn syscall3(nr: u32, a: u32, b: u32, c: u32) -> i32 {
    let ret: i32;
    unsafe {
        asm!("int $$0x80",
             inout("eax") nr => ret,
             in("ebx") a,
             in("ecx") b,
             in("edx") c,
             options(nostack));
    }
    ret
}

fn exit(code: u32) -> ! {
    syscall2(SYS_EXIT, code, 0);
    // should not return; make sure we never fall through
    loop { syscall2(SYS_EXIT, code, 0); }
}

fn brk(p: u32) -> u32 { syscall2(SYS_BRK, p, 0) as u32 }

fn write_bytes(p: *const u8, n: usize) { syscall3(SYS_WRITE, 1, p as u32, n as u32); }

fn write_str(s: &str) { write_bytes(s.as_ptr(), s.len()); }

fn print_u32(mut v: u32) {
    let mut buf = [0u8; 10];
    let mut i = 10;
    if v == 0 {
        write_str("0");
        return;
    }
    while v != 0 {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    unsafe { write_bytes(buf.as_ptr().add(i), 10 - i) };
}

fn parse_u32(mut p: *const u8) -> Option<u32> {
    let mut v: u32 = 0;
    unsafe {
        if *p == 0 { return None }
        loop {
            let c = *p;
            if c == 0 { break }
            if !(b'0'..=b'9').contains(&c) { return None }
            v = v.checked_mul(10)?.checked_add((c - b'0') as u32)?;
            p = p.add(1);
        }
    }
    Some(v)
}

fn pattern(page_index: u32) -> u32 {
    page_index.wrapping_mul(2654435761) ^ 0xA5A5A5A5
}

fn c_start(argc: u32, argv: *const *const u8) -> ! {
    if argc < 2 {
        write_str("usage: memhog <MiB>\n");
        exit(2);
    }
    let target_mib = match parse_u32(unsafe { *argv.add(1) }) {
        Some(v) => v,
        None => {
            write_str("usage: memhog <MiB>\n");
            exit(2);
        },
    };
    if target_mib < 32 {
        write_str("too small\n");
        exit(2);
    }
    let target_bytes = target_mib << 20;

    let base = brk(0);
    let mut end = base;

    write_str("memhog: growing to MiB ");
    print_u32(target_mib);
    write_str("\n");
    while end - base < target_bytes {
        let mut want = end + CHUNK;
        let remain = target_bytes - (end - base);
        if remain < CHUNK { want = end + remain; }
        if brk(want) != want {
            write_str("brk failed at MiB ");
            print_u32((end - base) >> 20);
            write_str("\n");
            exit(3);
        }
        let mut p = end;
        while p < want {
            let w = p as *mut u32;
            let pat = pattern(p >> 12);
            const WORDS: usize = (PAGE / 4) as usize;
            let mut i = 0;
            while i < WORDS {
                unsafe { w.add(i).write_volatile(pat) };
                i += 1;
            }
            p += PAGE;
        }
        end = want;
        if (end - base) & 0x3FF_FFFF == 0 {
            // every 64 MiB
            write_str("filled MiB ");
            print_u32((end - base) >> 20);
            write_str("\n");
        }
    }

    let mut p = base;
    while p < end {
        let w = p as *const u32;
        let pat = pattern(p >> 12);
        const WORDS: usize = (PAGE / 4) as usize;
        let mut i = 0;
        while i < WORDS {
            if unsafe { w.add(i).read_volatile() } != pat {
                write_str("MISMATCH at byte ");
                print_u32(p - base);
                write_str("\n");
                exit(4);
            }
            i += 1;
        }
        p += PAGE;
    }

    write_str("verified MiB ");
    print_u32((end - base) >> 20);
    write_str("\nok\n");
    exit(0);
}

core::arch::global_asm!(
    ".global _start",
    "_start:",
    "  mov eax, [esp]",        // argc
    "  lea ebx, [esp + 4]",    // argv
    "  and esp, -16",
    "  push ebx",
    "  push eax",
    "  call c_start_entry",
);

#[no_mangle]
unsafe extern "C" fn c_start_entry(argc: u32, argv: *const *const u8) -> ! {
    c_start(argc, argv)
}
