; M1 validation: enter long mode from reset and exercise 64-bit instructions.
; Loaded as a 64 KiB BIOS image at 0xF0000; reset entry at 0xFFFF0.
;
; Results are stored as qwords at 0x90000 (via r15); a magic byte 'K' is
; written to the serial port when done.

org 0xF0000

%define RESULTS 0x90000

[bits 16]
start16:
    cli

    ; --- build page tables: PML4 @0x1000, PDPT @0x2000, PD @0x3000 ---
    mov edi, 0x1000
    mov ecx, 0x1000          ; clear 0x1000..0x4FFF (16 KiB)
zero_tables:
    mov dword [edi], 0
    add edi, 4
    dec ecx
    jnz zero_tables

    mov dword [0x1000], 0x2003   ; PML4[0] -> PDPT, present+rw
    mov dword [0x2000], 0x3003   ; PDPT[0] -> PD, present+rw

    ; PD: 2 MiB pages, identity map 0..256 MiB
    xor eax, eax
    mov edi, 0x3000
    mov ecx, 128
fill_pd:
    mov edx, eax
    shl edx, 21
    or  edx, 0x83              ; P|RW|PS
    mov [edi], edx
    mov dword [edi+4], 0
    inc eax
    add edi, 8
    dec ecx
    jnz fill_pd

    ; --- GDT at 0x800: null, 64-bit code (0x08), data (0x10) ---
    xor eax, eax
    mov edi, 0x800
    mov ecx, 6
zero_gdt:
    mov dword [edi], 0
    add edi, 4
    dec ecx
    jnz zero_gdt
    mov dword [0x808], 0x0000FFFF    ; code64: limit
    mov dword [0x80C], 0x00AF9A00    ; P|S|E|RW, G=1 L=1 D=0
    mov dword [0x810], 0x0000FFFF    ; data: limit
    mov dword [0x814], 0x00CF9200    ; P|S|RW, G=1 D=1

    a32 lgdt [gdt_ptr]           ; 32-bit addressing: label is above 64 KiB

    mov eax, cr4
    or  eax, 1 << 5              ; CR4.PAE
    mov cr4, eax

    mov ecx, 0xC0000080          ; IA32_EFER
    rdmsr
    or  eax, 0x100               ; EFER.LME
    wrmsr

    mov eax, 0x1000
    mov cr3, eax

    mov eax, cr0
    or  eax, 0x80000001          ; CR0.PE|CR0.PG
    mov cr0, eax

    ; far jump into 64-bit code segment (32-bit operand in 16-bit segment)
[bits 16]
    o32 jmp 0x08:longmode

[bits 64]
longmode:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov rsp, 0x80000
    mov r15, RESULTS

    ; ======== test 0: mov r64, imm64 (REX.W B8) ========
    mov rax, 0x1122334455667788
    mov [r15 + 0*8], rax

    ; ======== test 1: mov r8, imm64 + add r64 ========
    mov r8, 0x1111111111111111
    add rax, r8                  ; 0x2233445566778899
    mov [r15 + 1*8], rax

    ; ======== test 2: 32-bit op zero-extends ========
    mov rax, -1
    mov eax, 0x89ABCDEF          ; rax = 0x0000000089ABCDEF
    mov [r15 + 2*8], rax

    ; ======== test 3: add flags + jo ========
    mov rax, 0x7FFFFFFFFFFFFFFF
    add rax, 1                   ; OF=1, SF=1
    mov rax, 0
    jo  t3_of
    mov rax, 0xDEAD
t3_of:
    mov [r15 + 3*8], rax         ; expect 0xDEAD

    ; ======== test 4: sub + js ========
    mov rax, 5
    sub rax, 10                  ; negative
    mov rax, 0
    js  t4_neg
    mov rax, 0xFFFF
t4_neg:
    mov [r15 + 4*8], rax         ; expect 0

    ; ======== test 5/6: 8-bit REX registers (sil, r8b) ========
    mov rsi, 0x4142434445464748
    mov r8, 0xFF
    mov sil, 0x00                ; low byte of rsi
    mov r8b, 0x42
    mov [r15 + 5*8], rsi         ; 0x4142434445464700
    mov [r15 + 6*8], r8          ; 0x42

    ; ======== test 7: RIP-relative load/store ========
    mov rax, 0xCAFEBABEDEADBEEF
    mov [rel scratch], rax
    mov rax, 0
    mov rax, [rel scratch]
    mov [r15 + 7*8], rax

    ; ======== test 8: SIB with r8 base, r9 index ========
    mov r8, 0x90000
    mov r9, 2
    mov rax, 0x0123456789ABCDEF
    mov [r8 + r9*8 + 0x100], rax ; -> 0x90110
    mov rax, 0
    mov rax, [r8 + r9*8 + 0x100]
    mov [r15 + 8*8], rax

    ; ======== test 9/10: push/pop + call/ret ========
    mov rax, 0x1234567890ABCDEF
    push rax
    mov rax, 0
    pop  rax
    mov [r15 + 9*8], rax
    call sub1
    mov [r15 + 10*8], rax        ; expect 0x42

    ; ======== test 11-14: shifts ========
    mov rax, 1
    shl rax, 63
    mov [r15 + 11*8], rax        ; 0x8000000000000000
    shr rax, 60
    mov [r15 + 12*8], rax        ; 8
    mov rax, 0x8000000000000000
    sar rax, 63
    mov [r15 + 13*8], rax        ; -1
    mov rax, 0x0123456789ABCDEF
    mov cl, 8
    shl rax, cl
    mov [r15 + 14*8], rax        ; 0x23456789ABCDEF00

    ; ======== test 15-18: imul/mul/div ========
    mov rax, 0x100000000
    mov rbx, 0x100000000
    imul rax, rbx                ; 2^64 wraps to 0, OF=1
    mov [r15 + 15*8], rax        ; 0
    mov rax, 0x100000000
    mul  rbx                     ; rdx:rax = 2^64 -> rdx=1 rax=0
    mov [r15 + 16*8], rdx        ; 1
    mov rdx, 0
    mov rax, 0x123456789ABCDEF0
    mov rbx, 0x100
    div  rbx
    mov [r15 + 17*8], rax        ; 0x123456789ABCDE
    mov [r15 + 18*8], rdx        ; 0xF0

    ; ======== test 19-21: movsxd / movzx / movsx ========
    mov dword [rel scratch], 0x80000001
    movsxd rax, dword [rel scratch]
    mov [r15 + 19*8], rax        ; 0xFFFFFFFF80000001
    movzx rax, byte [rel scratch]
    mov [r15 + 20*8], rax        ; 1
    movsx rax, byte [rel scratch]
    mov [r15 + 21*8], rax        ; 1

    ; ======== test 22-25: xchg + bswap + inc/dec ========
    mov rax, 0x1111
    mov rbx, 0x2222
    xchg rax, rbx
    mov [r15 + 22*8], rax        ; 0x2222
    mov rax, 0x0123456789ABCDEF
    bswap rax
    mov [r15 + 23*8], rax        ; 0xEFCDAB8967452301
    mov rax, 0xFFFFFFFFFFFFFFFF
    inc rax                      ; 0, ZF=1
    mov rbx, 0
    jz t23_z
    mov rbx, 1
t23_z:
    mov [r15 + 24*8], rbx        ; 0
    mov eax, 0xFFFFFFFF
    inc eax                      ; 32-bit inc in long mode
    mov [r15 + 25*8], rax        ; 0

    ; ======== test 26: lea64 RIP-relative ========
    lea rax, [rel scratch]
    mov rbx, [rel scratch_ptr]   ; absolute address of scratch
    sub rax, rbx
    mov [r15 + 26*8], rax        ; expect 0

    ; ======== test 27: loop (RCX) ========
    mov rcx, 5
    xor rax, rax
t27_loop:
    add rax, 3
    loop t27_loop
    mov [r15 + 27*8], rax        ; 15

    ; ======== test 28: fs base via MSR ========
    mov r10, 0x70000
    mov rax, 0xAABBCCDD
    mov [r10], rax
    mov ecx, 0xC0000100          ; IA32_FS_BASE
    mov eax, 0x70000
    xor edx, edx
    wrmsr
    xor r10d, r10d
    mov rax, fs:[r10]
    mov [r15 + 28*8], rax        ; 0xAABBCCDD

    ; ======== test 29-32: and/or/xor/not/neg ========
    mov rax, 0xFF00FF00FF00FF00
    mov rbx, 0x0FF00FF00FF00FF0
    and rax, rbx
    mov [r15 + 29*8], rax        ; 0x0F000F000F000F00
    mov rbx, 0xF00000000000000F
    or  rax, rbx
    mov [r15 + 30*8], rax        ; 0xFF000F000F000F0F
    xor rax, rax
    not rax
    mov [r15 + 31*8], rax        ; -1
    neg rax
    mov [r15 + 32*8], rax        ; 1

    ; ======== test 33/34: cmp + setcc + cmov ========
    mov rax, 100
    mov rbx, 200
    cmp rax, rbx
    setl al                      ; 1
    movzx rax, al
    mov [r15 + 33*8], rax        ; 1
    mov rax, 10
    cmovl rax, rbx               ; rax = 200
    mov [r15 + 34*8], rax        ; 200

    ; ======== test 35-38: cdqe/cqo, adc/sbb ========
    mov eax, 0x80000000
    cdqe
    mov [r15 + 35*8], rax        ; 0xFFFFFFFF80000000
    cqo                          ; rdx = -1
    mov [r15 + 36*8], rdx
    mov rax, 0xFFFFFFFFFFFFFFFF
    add rax, 1                   ; CF=1
    mov rax, 5
    adc rax, 0                   ; 6
    mov [r15 + 37*8], rax
    mov rax, 0
    stc
    sbb rax, -1                  ; 0 - (-1) - 1 = 0
    mov [r15 + 38*8], rax

    ; done
    mov al, 'K'
    mov dx, 0x3F8
    out dx, al
hang:
    hlt
    jmp hang

sub1:
    push rbp
    mov rbp, rsp
    mov rax, 0x42
    pop rbp
    ret

scratch: dq 0
scratch_ptr: dq scratch

gdt_ptr:
    dw 0x17                      ; 3 entries - 1
    dd 0x800

[bits 16]
    ; reset vector at file offset 0xFFF0
    times 0xFFF0 - ($ - $$) db 0x90
reset_vector:
    jmp 0xF000:start16 - 0xF0000   ; far jump to the start (cs=0xF000, ip=0)
    times 16 - 5 db 0x90
