; Bare-metal multiboot kernel (ELF32) testing the virtio-gpu 2D device.
; Runs at CPL=0 with paging off (identity mapped), so physical addresses are
; literal. Drives the device through its PCI I/O port BARs:
;   BAR0 = virtio common cfg, BAR1 = notify, BAR2 = isr, BAR3 = device cfg
; Prints progress + "GPUTEST_DONE" to COM1; the framebuffer test pattern is
; verified host-side via the "virtio-gpu-frame" bus event.
;
; nasm -f bin virtio_gpu_kernel.asm

%define PBASE 0x100000

; fixed physical buffers
%define Q0_DESC   0x200000
%define Q0_AVAIL  0x201000
%define Q0_USED   0x202000
%define REQ       0x206000
%define RESP      0x207000
%define FB        0x400000
%define STACK     0x70000

; PCI config ports
%define PCI_ADDR  0xCF8
%define PCI_DATA  0xCFC

; virtio common cfg offsets (from BAR0)
%define C_DEVICE_FEATURE_SELECT 0
%define C_DEVICE_FEATURE        4
%define C_DRIVER_FEATURE_SELECT 8
%define C_DRIVER_FEATURE        12
%define C_NUM_QUEUES            18
%define C_DEVICE_STATUS         20
%define C_QUEUE_SELECT          22
%define C_QUEUE_SIZE            24
%define C_QUEUE_ENABLE          28
%define C_QUEUE_NOTIFY_OFF      30
%define C_QUEUE_DESC            32
%define C_QUEUE_AVAIL           40
%define C_QUEUE_USED            48

%define VIRTQ_DESC_F_NEXT  1
%define VIRTQ_DESC_F_WRITE 2

; virtio gpu
%define CMD_GET_DISPLAY_INFO        0x0100
%define CMD_RESOURCE_CREATE_2D      0x0101
%define CMD_SET_SCANOUT             0x0103
%define CMD_RESOURCE_FLUSH          0x0104
%define CMD_TRANSFER_TO_HOST_2D     0x0105
%define CMD_RESOURCE_ATTACH_BACKING 0x0106
%define RESP_OK_NODATA              0x1100
%define RESP_OK_DISPLAY_INFO        0x1101
%define VIRTIO_GPU_FLAG_FENCE       1
%define FORMAT_B8G8R8X8             2

[bits 32]
org PBASE

elf_header:
    db 0x7F, "ELF", 1, 1, 1, 0      ; 32-bit, little endian
    times 8 db 0
    dw 2                            ; executable
    dw 3                            ; i386
    dd 1
    dd start                        ; entry (== paddr, paging off)
    dd program_header - elf_header
    dd 0                            ; shoff
    dd 0                            ; flags
    dw 52                           ; ehsize
    dw 32                           ; phentsize
    dw 1                            ; phnum
    dw 0, 0, 0                      ; shentsize, shnum, shstrndx

program_header:
    dd 1                            ; PT_LOAD
    dd 0                            ; offset
    dd PBASE                        ; vaddr
    dd PBASE                        ; paddr
    dd file_end - PBASE             ; filesz
    dd file_end - PBASE             ; memsz
    dd 7                            ; rwx
    dd 0x1000                       ; align

align 4
multiboot_header:
    dd 0x1BADB002                   ; magic
    dd 0                            ; flags
    dd -(0x1BADB002)                ; checksum

start:
    mov esp, STACK
    ; zero descriptor/ring/request regions (0x200000..0x208000)
    mov edi, Q0_DESC
    mov ecx, 0x8000 / 4
    xor eax, eax
    rep stosd

    call serial_init

    mov al, 'P'
    call putc

    ; --- find the device on pci bus 0 (vendor 0x1AF4, device 0x1050)
    xor ebx, ebx                    ; dev = 0..31
.find_dev:
    mov eax, 0x80000000
    mov ah, bl
    shl ah, 3                       ; dev << 11 lands in bits 8..15
    call pci_read32
    cmp eax, 0x10501AF4
    je .found_dev
    inc ebx
    cmp ebx, 32
    jb .find_dev
    mov al, '1'
    jmp fail
.found_dev:
    ; command register: enable I/O + memory + busmaster
    mov eax, 0x80000004
    mov ah, bl
    shl ah, 3
    mov edx, PCI_ADDR
    out dx, eax
    mov edx, PCI_DATA
    in eax, dx
    or eax, 7
    out dx, eax

    ; read BAR0..BAR3 (I/O port bases)
    xor ecx, ecx
.read_bars:
    mov eax, 0x80000010
    mov ah, bl
    shl ah, 3
    lea eax, [eax + ecx * 4]
    call pci_read32
    and eax, 0xFFFC
    mov [bar0 + ecx * 4], eax
    inc ecx
    cmp ecx, 4
    jb .read_bars

    mov al, 'D'
    call putc

    ; --- virtio handshake
    mov edx, [bar0]
    add edx, C_DEVICE_STATUS
    xor eax, eax
    out dx, al                      ; reset
    mov al, 1
    out dx, al                      ; ACKNOWLEDGE
    mov al, 3
    out dx, al                      ; + DRIVER

    ; features: accept VERSION_1 only
    mov edx, [bar0]
    add edx, C_DEVICE_FEATURE_SELECT
    xor eax, eax
    out dx, eax
    mov edx, [bar0]
    add edx, C_DEVICE_FEATURE
    in eax, dx
    mov [dev_feat0], eax
    mov edx, [bar0]
    add edx, C_DEVICE_FEATURE_SELECT
    mov eax, 1
    out dx, eax
    mov edx, [bar0]
    add edx, C_DEVICE_FEATURE
    in eax, dx
    mov [dev_feat1], eax
    test eax, 1                     ; VIRTIO_F_VERSION_1
    jz near feat_fail

    mov edx, [bar0]
    add edx, C_DRIVER_FEATURE_SELECT
    mov eax, 1
    out dx, eax
    mov edx, [bar0]
    add edx, C_DRIVER_FEATURE
    mov eax, 1
    out dx, eax
    mov edx, [bar0]
    add edx, C_DRIVER_FEATURE_SELECT
    xor eax, eax
    out dx, eax
    mov edx, [bar0]
    add edx, C_DRIVER_FEATURE
    xor eax, eax
    out dx, eax

    mov edx, [bar0]
    add edx, C_DEVICE_STATUS
    mov al, 1 | 2 | 8
    out dx, al                      ; + FEATURES_OK
    in al, dx
    test al, 8
    jz near feat_fail_2

    ; --- set up control queue (index 0)
    xor ecx, ecx
    mov esi, Q0_DESC
    mov edi, Q0_AVAIL
    mov ebp, Q0_USED
    call setup_queue

    ; driver ok
    mov edx, [bar0]
    add edx, C_DEVICE_STATUS
    mov al, 1 | 2 | 8 | 4
    out dx, al

    mov al, 'V'
    call putc

    ; --- GET_DISPLAY_INFO
    mov dword [REQ], CMD_GET_DISPLAY_INFO
    mov ecx, 24
    mov edi, RESP
    mov ebx, 512
    mov ebp, RESP_OK_DISPLAY_INFO
    call ctrl_request

    mov eax, [RESP + 24 + 8]        ; pmodes[0].rect.width
    mov [fb_width], eax
    mov eax, [RESP + 24 + 12]       ; pmodes[0].rect.height
    mov [fb_height], eax
    mov eax, [RESP + 24 + 16]       ; enabled
    test eax, eax
    jz near display_fail

    mov al, 'I'
    call putc

    ; --- RESOURCE_CREATE_2D (id 1, B8G8R8X8)
    mov dword [REQ], CMD_RESOURCE_CREATE_2D
    mov dword [REQ + 24], 1
    mov dword [REQ + 28], FORMAT_B8G8R8X8
    mov eax, [fb_width]
    mov [REQ + 32], eax
    mov eax, [fb_height]
    mov [REQ + 36], eax
    mov ecx, 40
    mov edi, RESP
    mov ebx, 512
    mov ebp, RESP_OK_NODATA
    call ctrl_request

    mov al, 'C'
    call putc

    ; --- fill framebuffer with test pattern:
    ;     B = x & 0xFF, G = y & 0xFF, R = (x ^ y) & 0xFF, X = 0xAA
    xor ebx, ebx                    ; y
.fill_y:
    xor ecx, ecx                    ; x
.fill_x:
    mov eax, ebx
    mul dword [fb_width]
    add eax, ecx
    lea edi, [FB + eax * 4]
    mov esi, ecx
    xor esi, ebx                    ; R = x ^ y
    mov eax, ecx                    ; B = x
    mov [edi], al
    mov eax, ebx                    ; G = y
    mov [edi + 1], al
    mov eax, esi                    ; R
    mov [edi + 2], al
    mov byte [edi + 3], 0xAA        ; X
    inc ecx
    cmp ecx, [fb_width]
    jb .fill_x
    inc ebx
    cmp ebx, [fb_height]
    jb .fill_y

    mov al, 'F'
    call putc

    ; --- RESOURCE_ATTACH_BACKING (single contiguous entry)
    mov dword [REQ], CMD_RESOURCE_ATTACH_BACKING
    mov dword [REQ + 24], 1         ; resource_id
    mov dword [REQ + 28], 1         ; nr_entries
    mov dword [REQ + 32], FB        ; entry.addr (low)
    mov dword [REQ + 36], 0         ; entry.addr (high)
    mov eax, [fb_width]
    mul dword [fb_height]
    shl eax, 2
    mov [REQ + 40], eax             ; entry.length
    mov dword [REQ + 44], 0         ; padding
    mov ecx, 48
    mov edi, RESP
    mov ebx, 512
    mov ebp, RESP_OK_NODATA
    call ctrl_request

    mov al, 'A'
    call putc

    ; --- SET_SCANOUT (0,0,w,h) scanout 0 resource 1
    mov dword [REQ], CMD_SET_SCANOUT
    mov dword [REQ + 24], 0         ; r.x
    mov dword [REQ + 28], 0         ; r.y
    mov eax, [fb_width]
    mov [REQ + 32], eax
    mov eax, [fb_height]
    mov [REQ + 36], eax
    mov dword [REQ + 40], 0         ; scanout_id
    mov dword [REQ + 44], 1         ; resource_id
    mov ecx, 48
    mov edi, RESP
    mov ebx, 512
    mov ebp, RESP_OK_NODATA
    call ctrl_request

    mov al, 'S'
    call putc

    ; --- TRANSFER_TO_HOST_2D (full resource)
    mov dword [REQ], CMD_TRANSFER_TO_HOST_2D
    mov dword [REQ + 24], 0         ; r.x
    mov dword [REQ + 28], 0         ; r.y
    mov eax, [fb_width]
    mov [REQ + 32], eax
    mov eax, [fb_height]
    mov [REQ + 36], eax
    mov dword [REQ + 40], 0         ; offset (u64)
    mov dword [REQ + 44], 0
    mov dword [REQ + 48], 1         ; resource_id
    mov dword [REQ + 52], 0
    mov ecx, 56
    mov edi, RESP
    mov ebx, 512
    mov ebp, RESP_OK_NODATA
    call ctrl_request

    mov al, 'T'
    call putc

    ; --- RESOURCE_FLUSH
    mov dword [REQ], CMD_RESOURCE_FLUSH
    mov dword [REQ + 24], 0
    mov dword [REQ + 28], 0
    mov eax, [fb_width]
    mov [REQ + 32], eax
    mov eax, [fb_height]
    mov [REQ + 36], eax
    mov dword [REQ + 40], 1         ; resource_id
    mov dword [REQ + 44], 0
    mov ecx, 48
    mov edi, RESP
    mov ebx, 512
    mov ebp, RESP_OK_NODATA
    call ctrl_request

    mov al, 'L'
    call putc

    ; success
    mov esi, msg_done
    call puts
halt_loop:
    cli
    hlt
    jmp halt_loop

feat_fail:
    mov al, '2'
    jmp fail
feat_fail_2:
    mov al, '3'
    jmp fail
display_fail:
    mov al, '4'
    jmp fail

fail:
    push eax
    mov esi, msg_fail
    call puts
    pop eax
    call putc
    mov al, 10
    call putc
    cli
    hlt
    jmp $

; ---------------------------------------------------------------------------
; setup_queue: configure queue ecx with desc/avail/used at esi/edi/ebp
setup_queue:
    push eax
    push edx
    ; select queue
    mov edx, [bar0]
    add edx, C_QUEUE_SELECT
    mov eax, ecx
    out dx, ax
    ; size check
    mov edx, [bar0]
    add edx, C_QUEUE_SIZE
    in ax, dx
    test ax, ax
    jz near fail                    ; 'P' already printed; hang with failure
    ; notify port = bar1 + notify_off * 2
    push ecx
    mov edx, [bar0]
    add edx, C_QUEUE_NOTIFY_OFF
    in ax, dx
    movzx eax, ax
    add eax, eax
    add eax, [bar1]
    mov [q0_notify + ecx * 4], eax
    pop ecx
    ; program addresses (high dwords are 0)
    mov edx, [bar0]
    add edx, C_QUEUE_DESC
    mov eax, esi
    out dx, eax
    add edx, 4
    xor eax, eax
    out dx, eax
    mov edx, [bar0]
    add edx, C_QUEUE_AVAIL
    mov eax, edi
    out dx, eax
    add edx, 4
    xor eax, eax
    out dx, eax
    mov edx, [bar0]
    add edx, C_QUEUE_USED
    mov eax, ebp
    out dx, eax
    add edx, 4
    xor eax, eax
    out dx, eax
    ; enable
    mov edx, [bar0]
    add edx, C_QUEUE_ENABLE
    mov eax, 1
    out dx, ax
    pop edx
    pop eax
    ret

; ---------------------------------------------------------------------------
; ctrl_request: submit request at REQ (ecx bytes) + response buffer edi
; (ebx bytes writable) on the control queue, wait for completion, verify the
; response type (dword at [edi]) equals ebp.
ctrl_request:
    ; fence header
    mov eax, [fence_ctr]
    inc eax
    mov [fence_ctr], eax
    mov dword [REQ + 4], VIRTIO_GPU_FLAG_FENCE
    mov [REQ + 8], eax
    mov dword [REQ + 12], 0
    mov dword [REQ + 16], 0
    mov dword [REQ + 20], 0

    ; desc 0: request (out)
    mov dword [Q0_DESC + 0], REQ
    mov dword [Q0_DESC + 4], 0
    mov [Q0_DESC + 8], ecx
    mov word [Q0_DESC + 12], VIRTQ_DESC_F_NEXT
    mov word [Q0_DESC + 14], 1
    ; desc 1: response (in)
    mov [Q0_DESC + 16 + 0], edi
    mov dword [Q0_DESC + 16 + 4], 0
    mov [Q0_DESC + 16 + 8], ebx
    mov word [Q0_DESC + 16 + 12], VIRTQ_DESC_F_WRITE
    mov word [Q0_DESC + 16 + 14], 0

    ; avail: ring[idx % 32] = 0; idx++
    movzx eax, word [Q0_AVAIL + 2]
    mov ecx, eax
    and ecx, 31
    mov word [Q0_AVAIL + 4 + ecx * 2], 0
    inc eax
    mov [Q0_AVAIL + 2], ax

    ; notify
    mov edx, [q0_notify]
    xor eax, eax
    out dx, ax

    ; wait for used.idx to advance
    mov ecx, [used_ctr]
    inc ecx
.wait_used:
    movzx eax, word [Q0_USED + 2]
    cmp eax, ecx
    jne .wait_used
    mov [used_ctr], ecx

    ; check response type
    cmp [edi], ebp
    jne .bad_resp
    ret
.bad_resp:
    mov al, '6'
    jmp fail

; ---------------------------------------------------------------------------
pci_read32:
    mov edx, PCI_ADDR
    out dx, eax
    mov edx, PCI_DATA
    in eax, dx
    ret

serial_init:
    push eax
    push edx
    mov edx, 0x3F8 + 3
    mov al, 0x03                    ; 8n1
    out dx, al
    mov edx, 0x3F8 + 2
    mov al, 0x01                    ; enable fifo
    out dx, al
    pop edx
    pop eax
    ret

; putc: al = char; preserves eax/edx
putc:
    push edx
    push eax
.wait:
    mov edx, 0x3FD
    in al, dx
    test al, 0x20
    jz .wait
    mov edx, 0x3F8
    pop eax
    out dx, al
    pop edx
    ret

; puts: esi = zero-terminated string
puts:
    push eax
.loop:
    lodsb
    test al, al
    jz .done
    call putc
    jmp .loop
.done:
    pop eax
    ret

msg_done: db "GPUTEST_DONE", 10, 0
msg_fail:  db "GPUTEST_FAIL:", 0

align 4
bar0:        dd 0
bar1:        dd 0
bar2:        dd 0
bar3:        dd 0
q0_notify:   dd 0
used_ctr:    dd 0
fence_ctr:   dd 0
fb_width:    dd 0
fb_height:   dd 0
dev_feat0:   dd 0
dev_feat1:   dd 0

file_end:
