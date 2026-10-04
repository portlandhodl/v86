//! memhog: allocate <MiB> of anonymous memory via brk, fill every word with a
//! per-page pattern, then verify it. Freestanding (no_std, no libc) program,
//! used by tests/api/2g-mem.js to stress guest RAM. Builds as a 32-bit (i686)
//! or a 64-bit (x86_64) Linux binary.
//!
//! Build (no cargo needed): make tests/api/memhog tests/api/memhog64
//!   (two steps: rustc --emit=obj, then link with the bundled rust-lld —
//!   the stock musl target pulls a crt that conflicts with our _start)

#![no_std]
#![no_main]

use core::arch::asm;

#[cfg(target_arch = "x86")]
mod nr {
    pub const EXIT: usize = 1;
    pub const WRITE: usize = 4;
    pub const BRK: usize = 45;
}
#[cfg(target_arch = "x86_64")]
mod nr {
    pub const EXIT: usize = 60;
    pub const WRITE: usize = 1;
    pub const BRK: usize = 12;
}

const PAGE: usize = 4096;
const CHUNK: usize = 16 * 1024 * 1024;

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

#[cfg(target_arch = "x86")]
#[inline(always)]
fn syscall3(nr: usize, a: usize, b: usize, c: usize) -> usize {
    let ret: usize;
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

#[cfg(target_arch = "x86_64")]
#[inline(always)]
fn syscall3(nr: usize, a: usize, b: usize, c: usize) -> usize {
    let ret: usize;
    unsafe {
        asm!("syscall",
             inout("rax") nr => ret,
             in("rdi") a,
             in("rsi") b,
             in("rdx") c,
             out("rcx") _,
             out("r11") _,
             options(nostack));
    }
    ret
}

fn exit(code: usize) -> ! {
    syscall3(nr::EXIT, code, 0, 0);
    // should not return; make sure we never fall through
    loop { syscall3(nr::EXIT, code, 0, 0); }
}

fn brk(p: usize) -> usize { syscall3(nr::BRK, p, 0, 0) }

fn write_bytes(p: *const u8, n: usize) { syscall3(nr::WRITE, 1, p as usize, n); }

fn write_str(s: &str) { write_bytes(s.as_ptr(), s.len()); }

fn print_usize(mut v: usize) {
    let mut buf = [0u8; 20];
    let mut i = 20;
    if v == 0 {
        write_str("0");
        return;
    }
    while v != 0 {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    unsafe { write_bytes(buf.as_ptr().add(i), 20 - i) };
}

fn print_hex(v: u32) {
    let mut buf = [0u8; 10];
    buf[0] = b'0';
    buf[1] = b'x';
    for i in 0..8 {
        let d = (v >> (28 - 4 * i)) & 0xF;
        buf[2 + i] = if d < 10 { b'0' + d as u8 } else { b'a' + d as u8 - 10 };
    }
    write_bytes(buf.as_ptr(), 10);
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

fn pattern(page_index: usize) -> u32 {
    (page_index as u32).wrapping_mul(2654435761) ^ 0xA5A5A5A5
}

fn c_start(argc: usize, argv: *const *const u8) -> ! {
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
    let target_bytes = (target_mib as usize) << 20;

    let base = brk(0);
    let mut end = base;

    write_str("memhog: growing to MiB ");
    print_usize(target_mib as usize);
    write_str("\n");
    while end - base < target_bytes {
        let mut want = end + CHUNK;
        let remain = target_bytes - (end - base);
        if remain < CHUNK { want = end + remain; }
        if brk(want) != want {
            write_str("brk failed at MiB ");
            print_usize((end - base) >> 20);
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
            print_usize((end - base) >> 20);
            write_str("\n");
        }
    }

    let mut p = base;
    let mut bad_pages = 0;
    while p < end {
        let w = p as *const u32;
        let pat = pattern(p >> 12);
        const WORDS: usize = (PAGE / 4) as usize;
        let mut i = 0;
        let mut bad_words = 0;
        let mut first_bad = 0;
        let mut last_bad = 0;
        let mut first_found = 0;
        while i < WORDS {
            let found = unsafe { w.add(i).read_volatile() };
            if found != pat {
                if bad_words == 0 {
                    first_bad = i;
                    first_found = found;
                }
                last_bad = i;
                bad_words += 1;
            }
            i += 1;
        }
        if bad_words != 0 {
            write_str("MISMATCH at byte ");
            print_usize(p - base + 4 * first_bad);
            write_str(" found ");
            print_hex(first_found);
            write_str(" expected ");
            print_hex(pat);
            // a value of another page of ours: a write landed in the wrong page
            let mut q = base;
            while q < end {
                if pattern(q >> 12) == first_found {
                    write_str(" (the pattern of byte ");
                    print_usize(q - base);
                    write_str(")");
                    break;
                }
                q += PAGE;
            }
            write_str("; bad words in page: ");
            print_usize(bad_words);
            write_str(" up to page offset ");
            print_usize(4 * last_bad);
            if bad_pages == 0 {
                write_str("; at");
                let mut j = 0;
                let mut n = 0;
                while j < WORDS && n < 32 {
                    if unsafe { w.add(j).read_volatile() } != pat {
                        write_str(" ");
                        print_usize(4 * j);
                        n += 1;
                    }
                    j += 1;
                }
            }
            write_str("\n");
            bad_pages += 1;
            if bad_pages == 8 {
                break;
            }
        }
        p += PAGE;
    }
    if bad_pages != 0 {
        exit(4);
    }

    write_str("verified MiB ");
    print_usize((end - base) >> 20);
    write_str("\nok\n");
    exit(0);
}

#[cfg(target_arch = "x86")]
core::arch::global_asm!(
    ".global _start",
    "_start:",
    "  mov eax, [esp]",        // argc
    "  lea ebx, [esp + 4]",    // argv
    "  and esp, -16",
    "  sub esp, 8",            // 16-byte aligned at the call (two pushes follow)
    "  push ebx",
    "  push eax",
    "  call c_start_entry",
);

#[cfg(target_arch = "x86_64")]
core::arch::global_asm!(
    ".global _start",
    "_start:",
    "  mov rdi, [rsp]",        // argc
    "  lea rsi, [rsp + 8]",    // argv
    "  and rsp, -16",
    "  call c_start_entry",
);

#[no_mangle]
unsafe extern "C" fn c_start_entry(argc: usize, argv: *const *const u8) -> ! {
    c_start(argc, argv)
}
