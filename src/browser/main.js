import { V86 } from "./starter.js";
import { LOG_NAMES } from "../const.js";
import { SyncBuffer, SyncFileBuffer } from "../buffer.js";
import { h, pad0, pads, hex_dump, dump_file, download, round_up_to_next_power_of_2 } from "../lib.js";
import { log_data, LOG_LEVEL, set_log_level } from "../log.js";
import * as iso9660 from "../iso9660.js";
import { init_manager } from "./manager.js";
import { load_catalogue, normalize_profile } from "./machines.js";


const ON_LOCALHOST = !location.hostname.endsWith("copy.sh");

const DEFAULT_NETWORKING_PROXIES = ["wss://relay.widgetry.org/", "ws://localhost:8080/"];
const DEFAULT_MEMORY_SIZE = 128;
const DEFAULT_VGA_MEMORY_SIZE = 8;
const DEFAULT_BOOT_ORDER = 0;
const DEFAULT_MTU = 1500;
const DEFAULT_NIC_TYPE = "ne2k";

const MAX_ARRAY_BUFFER_SIZE_MB = 2000;

function query_append()
{
    const version = $("version");
    return version ? "?" + version.textContent : "";
}

function set_title(text)
{
    document.title = text + " - v86" +  (DEBUG ? " - debug" : "");
    const description = document.querySelector("meta[name=description]");
    description && (description.content = "Running " + text);
}

function bool_arg(x)
{
    return !!x && x !== "0";
}

function format_timestamp(time)
{
    if(time < 60)
    {
        return time + "s";
    }
    else if(time < 3600)
    {
        return (time / 60 | 0) + "m " + pad0(time % 60, 2) + "s";
    }
    else
    {
        return (time / 3600 | 0) + "h " +
            pad0((time / 60 | 0) % 60, 2) + "m " +
            pad0(time % 60, 2) + "s";
    }
}

function read_file(file)
{
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = e => reject(e);
        fr.readAsArrayBuffer(file);
    });
}

let progress_ticks = 0;

function show_progress(e)
{
    const el = $("loading");
    el.style.display = "block";

    const file_name = e.file_name.split("?", 1)[0];

    if(file_name.endsWith(".wasm"))
    {
        const parts = file_name.split("/");
        el.textContent = "Fetching " + parts[parts.length - 1] + " ...";
        return;
    }

    if(e.file_index === e.file_count - 1 && e.loaded >= e.total - 2048)
    {
        // last file is (almost) loaded
        el.textContent = "Done downloading. Starting now ...";
        return;
    }

    let line = "Downloading images ";

    if(typeof e.file_index === "number" && e.file_count)
    {
        line += "[" + (e.file_index + 1) + "/" + e.file_count + "] ";
    }

    if(e.total && typeof e.loaded === "number")
    {
        var per100 = Math.floor(e.loaded / e.total * 100);
        per100 = Math.min(100, Math.max(0, per100));

        var per50 = Math.floor(per100 / 2);

        line += per100 + "% [";
        line += "#".repeat(per50);
        line += " ".repeat(50 - per50) + "]";
    }
    else
    {
        line += ".".repeat(progress_ticks++ % 50);
    }

    el.textContent = line;
}

function $(id)
{
    return document.getElementById(id);
}

// These values were previously stored in localStorage
const elements_to_restore = [
    "memory_size",
    "video_memory_size",
    "networking_proxy",
    "disable_audio",
    "enable_acpi",
    "boot_order",
];
for(const item of elements_to_restore)
{
    try
    {
        window.localStorage.removeItem(item);
    }
    catch(e) {}
}

function onload()
{
    if(!window.WebAssembly)
    {
        alert("Your browser is not supported because it doesn't support WebAssembly");
        return;
    }

    $("start_emulation").onclick = function(e)
    {
        start_emulation(null, null);
        $("start_emulation").blur();
        e.preventDefault();
    };

    if(DEBUG)
    {
        debug_onload();
    }

    if(DEBUG && ON_LOCALHOST)
    {
        // don't use online relay in debug mode
        $("relay_url").value = "ws://localhost:8080/";
    }

    const query_args = new URLSearchParams(location.search);
    const profile = query_args.get("profile");

    if(!profile && !DEBUG)
    {
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = "build/v86.wasm" + query_append();
        document.head.appendChild(link);
    }

    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = "build/xterm.js";
    document.head.appendChild(link);

    if(profile === "custom" && (query_args.has("hda.url") || query_args.has("cdrom.url") || query_args.has("fda.url")))
    {
        start_emulation(null, query_args);
        return;
    }

    if($("manager"))
    {
        init_manager({
            start: (os, from_link) => start_emulation(os, from_link ? query_args : null),
            query_args,
        });
    }
    else if(DEBUG)
    {
        init_debug_profiles(query_args);
    }

    if(query_args.has("m")) $("memory_size").value = query_args.get("m");
    if(query_args.has("vram")) $("vga_memory_size").value = query_args.get("vram");
    if(query_args.has("relay_url")) $("relay_url").value = query_args.get("relay_url");
    if(query_args.has("mute")) $("disable_audio").checked = bool_arg(query_args.get("mute"));
    if(query_args.has("acpi")) $("acpi").checked = bool_arg(query_args.get("acpi"));
    if(query_args.has("boot_order")) $("boot_order").value = query_args.get("boot_order");
    if(query_args.has("net_device_type")) $("net_device_type").value = query_args.get("net_device_type");
    if(query_args.has("mtu")) $("mtu").value = query_args.get("mtu");
    if(query_args.has("modem")) $("modem").value = query_args.get("modem");

    $("mtu_ui").style.display = $("net_device_type").value === "virtio" ? "table-row" : "none";
    $("net_device_type").onchange = function()
    {
        $("mtu_ui").style.display = $("net_device_type").value === "virtio" ? "table-row" : "none";
        $("net_device_type").blur();
    };

    for(const dev of ["fda", "fdb"])
    {
        const toggle = $(dev + "_toggle_empty_disk");
        if(!toggle) continue;

        toggle.onclick = function(e)
        {
            e.preventDefault();
            const select = document.createElement("select");
            select.id = dev + "_empty_size";
            for(const n_sect of [320, 360, 400, 640, 720, 800, 1440, 2400, 2880, 3444, 5760, 7680])
            {
                const n_bytes = n_sect * 512, kb = 1024, MB = kb * 1000;
                const option = document.createElement("option");
                if(n_bytes < MB)
                {
                    option.textContent = (n_bytes / kb) + " kB";
                }
                else
                {
                    option.textContent = (n_bytes / MB).toFixed(2) + " MB";
                }
                if(n_sect === 2880)
                {
                    option.selected = true;
                }
                option.value = n_bytes;
                select.appendChild(option);
            }
            // TODO (when closure compiler supports it): parent.parentNode.replaceChildren(...);
            const parent = toggle.parentNode;
            parent.innerHTML = "";
            parent.append("Empty disk of ", select);
        };
    }

    for(const dev of ["hda", "hdb"])
    {
        const toggle = $(dev + "_toggle_empty_disk");
        if(!toggle) continue;

        toggle.onclick = function(e)
        {
            e.preventDefault();
            const input = document.createElement("input");
            input.id = dev + "_empty_size";
            input.type = "number";
            input.min = "0";
            input.max = String(MAX_ARRAY_BUFFER_SIZE_MB);
            input.step = "100";
            input.value = "100";
            // TODO (when closure compiler supports it): parent.parentNode.replaceChildren(...);
            const parent = toggle.parentNode;
            parent.innerHTML = "";
            parent.append("Empty disk of ", input, " MB");
        };
    }

    function set_proxy_value(id, value)
    {
        const elem = $(id);
        if(elem)
        {
            elem.onclick = () => $("relay_url").value = value;
        }
    }
    set_proxy_value("network_none", "");
    set_proxy_value("network_inbrowser", "inbrowser");
    set_proxy_value("network_fetch", "fetch");
    set_proxy_value("network_relay", "wss://relay.widgetry.org/");
    set_proxy_value("network_wisp", "wisps://wisp.mercurywork.shop/v86/");
}

// debug.html: a button per served machine, plus kvm-unit-tests
function init_debug_profiles(query_args)
{
    const container = $("debug_profiles");
    const wanted = query_args.get("profile");

    function add(os)
    {
        if(wanted === os.id)
        {
            start_emulation(os, query_args);
            return true;
        }
        if(container)
        {
            const button = document.createElement("button");
            button.textContent = os.name;
            button.onclick = () => start_emulation(os, null);
            container.appendChild(button);
        }
        return false;
    }

    load_catalogue(query_args.get("cdn")).then(({ image_base, profiles }) =>
    {
        for(const p of profiles)
        {
            if(add(normalize_profile(p, image_base))) return;
        }

        if(container) container.appendChild(document.createElement("br"));

        // see tests/kvm-unit-tests/x86/
        const tests = [
            "realmode",
            // All tests below require an APIC
            "cmpxchg8b",
            "port80",
            "setjmp",
            "sieve",
            "hypercall", // crashes
            "init", // stops execution
            "msr", // TODO: Expects 64 bit msrs
            "smap", // test stops, SMAP not enabled
            "tsc_adjust", // TODO: IA32_TSC_ADJUST
            "tsc", // TODO: rdtscp
            "rmap_chain", // crashes
            "memory", // missing mfence (uninteresting)
            "taskswitch", // TODO: Jump
            "taskswitch2", // TODO: Call TSS
            "eventinj", // Missing #nt
            "ioapic",
            "apic",
        ];

        for(const test of tests)
        {
            const started = add({
                name: "Test case: " + test,
                id: "test-" + test,
                memory_size: 128 * 1024 * 1024,
                multiboot: { url: "tests/kvm-unit-tests/x86/" + test + ".flat" }
            });
            if(started) return;
        }
    });
}

function debug_onload()
{
    // called on window.onload, in debug mode

    const log_levels = $("log_levels");

    if(!log_levels)
    {
        return;
    }

    for(let i = 0; i < LOG_NAMES.length; i++)
    {
        const mask = LOG_NAMES[i][0];

        if(mask === 1)
            continue;

        const name = LOG_NAMES[i][1].toLowerCase();
        const input = document.createElement("input");
        const label = document.createElement("label");

        input.type = "checkbox";

        label.htmlFor = input.id = "log_" + name;

        if(LOG_LEVEL & mask)
        {
            input.checked = true;
        }
        input.mask = mask;

        label.append(input, pads(name, 4) + " ");
        log_levels.appendChild(label);

        if(i === Math.floor(LOG_NAMES.length / 2))
        {
            log_levels.append("\n");
        }
    }

    log_levels.onchange = function(e)
    {
        const target = e.target;
        const mask = target.mask;

        if(target.checked)
        {
            set_log_level(LOG_LEVEL | mask);
        }
        else
        {
            set_log_level(LOG_LEVEL & ~mask);
        }

        target.blur();
    };
}

window.addEventListener("load", onload, false);

// old webkit fires popstate on every load, fuck webkit
// https://code.google.com/p/chromium/issues/detail?id=63040
window.addEventListener("load", function()
{
    setTimeout(function()
    {
        window.addEventListener("popstate", onpopstate);
    }, 0);
});

// works in firefox and chromium
if(document.readyState === "complete")
{
    onload();
}

// we can get here in various ways:
// - the user clicked on the "start emulation" button
// - the user clicked on a profile
// - the ?profile= query parameter specified a valid profile
// - the ?profile= query parameter was set to "custom" and at least one disk image was given
function start_emulation(profile, query_args)
{
    for(const dialog of document.querySelectorAll("dialog[open]"))
    {
        dialog.close();
    }
    $("boot_options").style.display = "none";

    const new_query_args = new Map();
    new_query_args.set("profile", profile?.id || "custom");

    const settings = {};

    if(profile)
    {
        if(profile.state)
        {
            $("reset").style.display = "none";
        }

        set_title(profile.name);

        settings.initial_state = profile.state;
        settings.filesystem = profile.filesystem;
        settings.fda = profile.fda;
        settings.fdb = profile.fdb;
        settings.cdrom = profile.cdrom;
        settings.hda = profile.hda;
        settings.hdb = profile.hdb;
        settings.multiboot = profile.multiboot;
        settings.bzimage = profile.bzimage;
        settings.initrd = profile.initrd;
        settings.cmdline = profile.cmdline;
        settings.bzimage_initrd_from_filesystem = profile.bzimage_initrd_from_filesystem;
        settings.mac_address_translation = profile.mac_address_translation;
        settings.cpuid_level = profile.cpuid_level;
        settings.acpi = profile.acpi;
        settings.memory_size = profile.memory_size;
        settings.vga_memory_size = profile.vga_memory_size;
        settings.boot_order = profile.boot_order;
        settings.net_device_type = profile.net_device_type;
        settings.modem = profile.modem;
        settings.mtu = profile.mtu;
        settings.virtio_gpu = profile.virtio_gpu;
        settings.fdc = profile.fdc;
        settings.relay_url = profile.relay_url;
        settings.disable_audio = profile.disable_audio;

        if($("vm_title"))
        {
            $("vm_title").textContent = profile.name;
        }

        // profiles can be imported from anywhere: only link to web pages
        if(!DEBUG && profile.homepage && /^https?:\/\//i.test(profile.homepage))
        {
            $("description").style.display = "block";
            const link = document.createElement("a");
            link.href = profile.homepage;
            link.textContent = profile.name;
            link.target = "_blank";
            $("description").append(document.createTextNode("Running "), link);
        }
    }

    if(query_args)
    {
        // ignore certain settings when using a state image
        if(!settings.initial_state)
        {
            let chunk_size = parseInt(query_args.get("chunk_size"), 10);
            if(chunk_size >= 0)
            {
                chunk_size = Math.min(4 * 1024 * 1024, Math.max(512, chunk_size));
                chunk_size = round_up_to_next_power_of_2(chunk_size);
            }
            else
            {
                chunk_size = 256 * 1024;
            }

            if(query_args.has("hda.url"))
            {
                settings.hda = {
                    size: parseInt(query_args.get("hda.size"), 10) || undefined,
                    // TODO: synchronous if small?
                    url: query_args.get("hda.url"),
                    fixed_chunk_size: chunk_size,
                    async: true,
                };
            }
            else if(query_args.has("hda.empty"))
            {
                const empty_size = parseInt(query_args.get("hda.empty"), 10);
                if(empty_size > 0)
                {
                    settings.hda = { buffer: new ArrayBuffer(empty_size) };
                }
            }

            if(query_args.has("hdb.url"))
            {
                settings.hdb = {
                    size: parseInt(query_args.get("hdb.size"), 10) || undefined,
                    // TODO: synchronous if small?
                    url: query_args.get("hdb.url"),
                    fixed_chunk_size: chunk_size,
                    async: true,
                };
            }
            else if(query_args.has("hdb.empty"))
            {
                const empty_size = parseInt(query_args.get("hdb.empty"), 10);
                if(empty_size > 0)
                {
                    settings.hdb = { buffer: new ArrayBuffer(empty_size) };
                }
            }

            if(query_args.has("cdrom.url"))
            {
                settings.cdrom = {
                    size: parseInt(query_args.get("cdrom.size"), 10) || undefined,
                    url: query_args.get("cdrom.url"),
                    fixed_chunk_size: chunk_size,
                    async: true,
                };
            }

            if(query_args.has("fda.url"))
            {
                settings.fda = {
                    size: parseInt(query_args.get("fda.size"), 10) || undefined,
                    url: query_args.get("fda.url"),
                    async: false,
                };
            }

            const m = parseInt(query_args.get("m"), 10);
            if(m > 0)
            {
                settings.memory_size = Math.max(16, m) * 1024 * 1024;
            }

            const vram = parseInt(query_args.get("vram"), 10);
            if(vram > 0)
            {
                settings.vga_memory_size = vram * 1024 * 1024;
            }

            settings.acpi = query_args.has("acpi") ? bool_arg(query_args.get("acpi")) : settings.acpi;
            settings.use_bochs_bios = query_args.get("bios") === "bochs";
            settings.net_device_type = query_args.get("net_device_type") || settings.net_device_type;
            settings.mtu = parseInt(query_args.get("mtu"), 10) || settings.mtu;
        }

        if(query_args.has("relay_url")) settings.relay_url = query_args.get("relay_url");
        settings.disable_jit = bool_arg(query_args.get("disable_jit"));
        settings.disable_audio = bool_arg(query_args.get("mute")) || settings.disable_audio;

        if(query_args.has("modem"))
        {
            const modem = parseInt(query_args.get("modem"), 10);
            if(!Number.isNaN(modem) && modem >= 0 && modem < 4)
            {
                settings.modem = {uart: modem};
            }
        }
    }

    if(settings.relay_url === undefined)
    {
        settings.relay_url = $("relay_url").value;
        if(!DEFAULT_NETWORKING_PROXIES.includes(settings.relay_url)) new_query_args.set("relay_url", settings.relay_url);
    }
    if(settings.relay_url.startsWith("fetch:"))
    {
        settings.cors_proxy = settings.relay_url.slice(6);
        settings.relay_url = "fetch";
    }
    settings.disable_audio = $("disable_audio").checked || settings.disable_audio;
    if(settings.disable_audio) new_query_args.set("mute", "1");

    // some settings cannot be overridden when a state image is used
    if(!settings.initial_state)
    {
        const bios = $("bios").files[0];
        if(bios)
        {
            settings.bios = { buffer: bios };
        }
        const vga_bios = $("vga_bios").files[0];
        if(vga_bios)
        {
            settings.vga_bios = { buffer: vga_bios };
        }
        const fda = $("fda_image")?.files[0];
        if(fda)
        {
            settings.fda = { buffer: fda };
        }
        const fda_empty_size = +$("fda_empty_size")?.value;
        if(fda_empty_size)
        {
            settings.fda = { buffer: new ArrayBuffer(fda_empty_size) };
        }
        const fdb = $("fdb_image")?.files[0];
        if(fdb)
        {
            settings.fdb = { buffer: fdb };
        }
        const fdb_empty_size = +$("fdb_empty_size")?.value;
        if(fdb_empty_size)
        {
            settings.fdb = { buffer: new ArrayBuffer(fdb_empty_size) };
        }
        const cdrom = $("cdrom_image").files[0];
        if(cdrom)
        {
            settings.cdrom = { buffer: cdrom };
        }
        const hda = $("hda_image")?.files[0];
        if(hda)
        {
            settings.hda = { buffer: hda };
        }
        const hda_empty_size = +$("hda_empty_size")?.value;
        if(hda_empty_size)
        {
            const size = Math.max(1, Math.min(MAX_ARRAY_BUFFER_SIZE_MB, hda_empty_size)) * 1024 * 1024;
            settings.hda = { buffer: new ArrayBuffer(size) };
            new_query_args.set("hda.empty", String(size));
        }
        const hdb = $("hdb_image")?.files[0];
        if(hdb)
        {
            settings.hdb = { buffer: hdb };
        }
        const hdb_empty_size = +$("hdb_empty_size")?.value;
        if(hdb_empty_size)
        {
            const size = Math.max(1, Math.min(MAX_ARRAY_BUFFER_SIZE_MB, hdb_empty_size)) * 1024 * 1024;
            settings.hdb = { buffer: new ArrayBuffer(size) };
            new_query_args.set("hdb.empty", String(size));
        }
        const multiboot = $("multiboot_image")?.files[0];
        if(multiboot)
        {
            settings.multiboot = { buffer: multiboot };
        }
        const bzimage = $("bzimage").files[0];
        if(bzimage)
        {
            settings.bzimage = { buffer: bzimage };
        }
        const initrd = $("initrd").files[0];
        if(initrd)
        {
            settings.initrd = { buffer: initrd };
        }

        const title = multiboot?.name || hda?.name || cdrom?.name || hdb?.name || fda?.name || bios?.name;
        if(title)
        {
            set_title(title);
        }

        const MB = 1024 * 1024;

        const memory_size = parseInt($("memory_size").value, 10) || DEFAULT_MEMORY_SIZE;
        if(!settings.memory_size || memory_size !== DEFAULT_MEMORY_SIZE)
        {
            settings.memory_size = memory_size * MB;
        }
        if(memory_size !== DEFAULT_MEMORY_SIZE) new_query_args.set("m", String(memory_size));

        const vga_memory_size = parseInt($("vga_memory_size").value, 10) || DEFAULT_VGA_MEMORY_SIZE;
        if(!settings.vga_memory_size || vga_memory_size !== DEFAULT_VGA_MEMORY_SIZE)
        {
            settings.vga_memory_size = vga_memory_size * MB;
        }
        if(vga_memory_size !== DEFAULT_VGA_MEMORY_SIZE) new_query_args.set("vram", String(vga_memory_size));

        const boot_order = parseInt($("boot_order").value, 16) || DEFAULT_BOOT_ORDER;
        if(!settings.boot_order || boot_order !== DEFAULT_BOOT_ORDER)
        {
            settings.boot_order = boot_order;
        }
        if(settings.boot_order !== DEFAULT_BOOT_ORDER) new_query_args.set("boot_order", settings.boot_order.toString(16));

        if(settings.acpi === undefined)
        {
            settings.acpi = $("acpi").checked;
            if(settings.acpi) new_query_args.set("acpi", "1");
        }

        const BIOSPATH = "bios/";

        if(!settings.bios)
        {
            settings.bios = { url: BIOSPATH + (DEBUG ? "seabios-debug.bin" : "seabios.bin") };
        }
        if(!settings.vga_bios)
        {
            settings.vga_bios = { url: BIOSPATH + (DEBUG ? "vgabios-debug.bin" : "vgabios.bin") };
        }
        if(settings.use_bochs_bios)
        {
            settings.bios = { url: BIOSPATH + "bochs-bios.bin" };
            settings.vga_bios = { url: BIOSPATH + "bochs-vgabios.bin" };
        }

        const nic_type = $("net_device_type").value || DEFAULT_NIC_TYPE;
        if(!settings.net_device_type || nic_type !== DEFAULT_NIC_TYPE)
        {
            settings.net_device_type = nic_type;
        }
        if(settings.net_device_type !== DEFAULT_NIC_TYPE) new_query_args.set("net_device_type", settings.net_device_type);

        const mtu = parseInt($("mtu").value, 10) || DEFAULT_MTU;
        if(!settings.mtu || mtu !== DEFAULT_MTU)
        {
            settings.mtu = mtu;
        }
        if(settings.mtu !== DEFAULT_MTU) new_query_args.set("mtu", settings.mtu.toString());

        const modem = parseInt($("modem").value, 10);
        if(!Number.isNaN(modem) && modem >= 0 && modem < 4)
        {
            settings.modem = {uart: modem};
            new_query_args.set("modem", modem.toString());
        }
    }

    if(!query_args)
    {
        push_state(new_query_args);
    }

    // guest RAM above 3 GiB needs the mem64 build
    const mem64 = settings.memory_size > 3 * 1024 * 1024 * 1024;
    const wasm_file = (mem64 ? "v86-mem64" : "v86") + (DEBUG ? "-debug" : "") + ".wasm";

    const emulator = new V86({
        wasm_path: "build/" + wasm_file + query_append(),
        screen: {
            container: $("screen_container"),
            use_graphical_text: false,
        },
        net_device: {
            type: settings.net_device_type || DEFAULT_NIC_TYPE,
            relay_url: settings.relay_url,
            cors_proxy: settings.cors_proxy,
            mtu: settings.mtu
        },
        modem: settings.modem,
        autostart: true,

        memory_size: settings.memory_size,
        vga_memory_size: settings.vga_memory_size,
        boot_order: settings.boot_order,

        bios: settings.bios,
        vga_bios: settings.vga_bios,
        fda: settings.fda,
        fdb: settings.fdb,
        hda: settings.hda,
        hdb: settings.hdb,
        cdrom: settings.cdrom,
        multiboot: settings.multiboot,
        bzimage: settings.bzimage,
        initrd: settings.initrd,
        fdc: settings.fdc,
        virtio_gpu: settings.virtio_gpu,

        cmdline: settings.cmdline,
        bzimage_initrd_from_filesystem: settings.bzimage_initrd_from_filesystem,
        acpi: settings.acpi,
        disable_jit: settings.disable_jit,
        initial_state: settings.initial_state,
        filesystem: settings.filesystem || {},
        disable_speaker: settings.disable_audio,
        mac_address_translation: settings.mac_address_translation,
        cpuid_level: settings.cpuid_level,
    });

    if(DEBUG) window.emulator = emulator;

    emulator.add_listener("emulator-ready", function()
    {
        if(DEBUG)
        {
            debug_start(emulator);
        }

        if(emulator.v86.cpu.wm.exports["profiler_is_enabled"]())
        {
            const CLEAR_STATS = false;

            const panel = document.createElement("pre");
            document.body.appendChild(panel);

            setInterval(function()
                {
                    if(!emulator.is_running())
                    {
                        return;
                    }

                    panel.textContent = emulator.get_instruction_stats();

                    CLEAR_STATS && emulator.v86.cpu.clear_opstats();
                }, CLEAR_STATS ? 5000 : 1000);
        }

        if(profile?.autotype)
        {
            // e.g. to get past a boot menu
            setTimeout(() => emulator.keyboard_send_text(profile.autotype.text), profile.autotype.delay);
        }

        init_ui(profile, settings, emulator);

        if(query_args?.has("c"))
        {
            setTimeout(function()
            {
                emulator.keyboard_send_text(query_args.get("c") + "\n");
            }, 25);
        }

        if(query_args?.has("s"))
        {
            setTimeout(function()
            {
                emulator.serial0_send(query_args.get("s") + "\n");
            }, 25);
        }

        if(query_args?.has("theatre") && bool_arg(query_args?.get("theatre")))
        {
            $("toggle_theatre").click();
        }
    });

    emulator.add_listener("emulator-loaded", function()
    {
        if(!emulator.v86.cpu.devices.cdrom)
        {
            $("change_cdrom_image").style.display = "none";
        }
    });

    emulator.add_listener("download-progress", function(e)
    {
        show_progress(e);
    });

    emulator.add_listener("download-error", function(e)
    {
        const el = $("loading");
        el.style.display = "block";
        el.textContent = `Loading ${e.file_name} failed. Check your connection and reload the page to try again.`;
    });
}

/**
 * @param {Object} settings
 * @param {V86} emulator
 */
function init_ui(profile, settings, emulator)
{
    $("loading").style.display = "none";
    $("runtime_options").style.display = "block";
    $("runtime_infos").style.display = "block";
    $("screen_container").style.display = "block";

    var filesystem_is_enabled = false;

    if(settings.filesystem)
    {
        filesystem_is_enabled = true;
        init_filesystem_panel(emulator);
    }
    else
    {
        emulator.add_listener("9p-attach", function()
        {
            filesystem_is_enabled = true;
            init_filesystem_panel(emulator);
        });
    }

    $("run").onclick = function()
    {
        if(emulator.is_running())
        {
            $("run").textContent = "Run";
            emulator.stop();
        }
        else
        {
            $("run").textContent = "Pause";
            emulator.run();
        }

        $("run").blur();
    };

    $("exit").onclick = function()
    {
        emulator.destroy();
        const params = new URLSearchParams(location.search);
        params.delete("profile");
        location.href = location.pathname + format_query_args(params);
    };

    $("lock_mouse").onclick = function()
    {
        if(!mouse_is_enabled)
        {
            $("toggle_mouse").onclick();
        }

        emulator.lock_mouse();
        $("lock_mouse").blur();
    };

    var mouse_is_enabled = true;

    $("toggle_mouse").onclick = function()
    {
        mouse_is_enabled = !mouse_is_enabled;

        emulator.mouse_set_enabled(mouse_is_enabled);
        $("toggle_mouse").textContent = (mouse_is_enabled ? "Dis" : "En") + "able mouse";
        $("toggle_mouse").blur();
    };

    if(profile?.mouse_disabled_default)
    {
        $("toggle_mouse").onclick();
    }

    var theatre_mode = false;
    var theatre_ui = true;
    var theatre_zoom_to_fit = false;

    function zoom_to_fit()
    {
        // reset size
        emulator.screen_set_scale(1, 1);

        const emulator_screen = $("screen_container").getBoundingClientRect();
        const emulator_screen_width = emulator_screen.width;
        const emulator_screen_height = emulator_screen.height;

        const viewport_screen_width = window.innerWidth;
        const viewport_screen_height = window.innerHeight;

        const n = Math.min(viewport_screen_width / emulator_screen_width, viewport_screen_height / emulator_screen_height);
        emulator.screen_set_scale(n, n);
    }

    /**
     * @param {boolean} enabled
     */
    function enable_theatre_ui(enabled)
    {
        theatre_ui = enabled;

        $("runtime_options").style.display = theatre_ui ? "block" : "none";
        $("runtime_infos").style.display = theatre_ui ? "block" : "none";
        $("filesystem_panel").style.display = (filesystem_is_enabled && theatre_ui) ? "block" : "none";

        $("toggle_ui").textContent = (theatre_ui ? "Hide" : "Show") + " UI";
    }

    /**
     * @param {boolean} enabled
     */
    function enable_zoom_to_fit(enabled)
    {
        theatre_zoom_to_fit = enabled;
        $("scale").disabled = theatre_zoom_to_fit;

        if(theatre_zoom_to_fit)
        {
            window.addEventListener("resize", zoom_to_fit, true);
            emulator.add_listener("screen-set-size", zoom_to_fit);

            zoom_to_fit();
        }
        else
        {
            window.removeEventListener("resize", zoom_to_fit, true);
            emulator.remove_listener("screen-set-size", zoom_to_fit);

            const n = parseFloat($("scale").value) || 1;
            emulator.screen_set_scale(n, n);
        }

        $("toggle_zoom_to_fit").textContent = (theatre_zoom_to_fit ? "Dis" : "En") + "able zoom to fit";
    }

    /**
     * @param {boolean} enabled
     */
    function enable_theatre_mode(enabled)
    {
        theatre_mode = enabled;

        if(!theatre_ui)
        {
            enable_theatre_ui(true);
        }

        if(!theatre_mode && theatre_zoom_to_fit)
        {
            enable_zoom_to_fit(false);
        }

        for(const el of ["screen_container", "runtime_options", "runtime_infos", "filesystem_panel"])
        {
            $(el).classList.toggle("theatre_" + el);
        }

        $("theatre_background").style.display = theatre_mode ? "block" : "none";
        $("toggle_zoom_to_fit").style.display = theatre_mode ? "inline" : "none";
        $("toggle_ui").style.display = theatre_mode ? "block" : "none";

        // hide scrolling
        document.body.style.overflow = theatre_mode ? "hidden" : "visible";

        $("toggle_theatre").textContent = (theatre_mode ? "Dis" : "En") + "able theatre mode";
    }

    $("toggle_ui").onclick = function()
    {
        enable_theatre_ui(!theatre_ui);
        $("toggle_ui").blur();
    };

    $("toggle_theatre").onclick = function()
    {
        enable_theatre_mode(!theatre_mode);
        $("toggle_theatre").blur();
    };

    $("toggle_zoom_to_fit").onclick = function()
    {
        enable_zoom_to_fit(!theatre_zoom_to_fit);
        $("toggle_zoom_to_fit").blur();
    };

    var last_tick = 0;
    var running_time = 0;
    var last_instr_counter = 0;
    var interval = null;
    var os_uses_mouse = false;
    var os_uses_absolute_mouse = false;
    var total_instructions = 0;

    function update_info()
    {
        var now = Date.now();

        var instruction_counter = emulator.get_instruction_counter();

        if(instruction_counter < last_instr_counter)
        {
            // 32-bit wrap-around
            last_instr_counter -= 0x100000000;
        }

        var last_ips = instruction_counter - last_instr_counter;
        last_instr_counter = instruction_counter;
        total_instructions += last_ips;

        var delta_time = now - last_tick;

        if(delta_time)
        {
            running_time += delta_time;
            last_tick = now;

            $("speed").textContent = (last_ips / 1000 / delta_time).toFixed(1);
            $("avg_speed").textContent = (total_instructions / 1000 / running_time).toFixed(1);
            $("running_time").textContent = format_timestamp(running_time / 1000 | 0);
        }
    }

    emulator.add_listener("emulator-started", function()
    {
        last_tick = Date.now();
        interval = setInterval(update_info, 1000);
    });

    emulator.add_listener("emulator-stopped", function()
    {
        update_info();
        if(interval !== null)
        {
            clearInterval(interval);
        }
    });

    var stats_9p = {
        read: 0,
        write: 0,
        files: [],
    };

    emulator.add_listener("9p-read-start", function(args)
    {
        const file = args[0];
        stats_9p.files.push(file);
        $("info_filesystem").style.display = "block";
        $("info_filesystem_status").textContent = "Loading ...";
        $("info_filesystem_last_file").textContent = file;
    });
    emulator.add_listener("9p-read-end", function(args)
    {
        stats_9p.read += args[1];
        $("info_filesystem_bytes_read").textContent = stats_9p.read;

        const file = args[0];
        stats_9p.files = stats_9p.files.filter(f => f !== file);

        if(stats_9p.files[0])
        {
            $("info_filesystem_last_file").textContent = stats_9p.files[0];
        }
        else
        {
            $("info_filesystem_status").textContent = "Idle";
        }
    });
    emulator.add_listener("9p-write-end", function(args)
    {
        stats_9p.write += args[1];
        $("info_filesystem_bytes_written").textContent = stats_9p.write;

        if(!stats_9p.files[0])
        {
            $("info_filesystem_last_file").textContent = args[0];
        }
    });

    var stats_storage = {
        read: 0,
        read_sectors: 0,
        write: 0,
        write_sectors: 0,
    };

    $("ide_type").textContent = settings.cdrom ? " (CD-ROM)" : " (hard disk)";

    emulator.add_listener("ide-read-start", function()
    {
        $("info_storage").style.display = "block";
        $("info_storage_status").textContent = "Loading ...";
    });
    emulator.add_listener("ide-read-end", function(args)
    {
        stats_storage.read += args[1];
        stats_storage.read_sectors += args[2];

        $("info_storage_status").textContent = "Idle";
        $("info_storage_bytes_read").textContent = stats_storage.read;
        $("info_storage_sectors_read").textContent = stats_storage.read_sectors;
    });
    emulator.add_listener("ide-write-end", function(args)
    {
        stats_storage.write += args[1];
        stats_storage.write_sectors += args[2];

        $("info_storage_bytes_written").textContent = stats_storage.write;
        $("info_storage_sectors_written").textContent = stats_storage.write_sectors;
    });

    var stats_net = {
        bytes_transmitted: 0,
        bytes_received: 0,
    };

    emulator.add_listener("eth-receive-end", function(args)
    {
        stats_net.bytes_received += args[0];

        $("info_network").style.display = "block";
        $("info_network_bytes_received").textContent = stats_net.bytes_received;
    });
    emulator.add_listener("eth-transmit-end", function(args)
    {
        stats_net.bytes_transmitted += args[0];

        $("info_network").style.display = "block";
        $("info_network_bytes_transmitted").textContent = stats_net.bytes_transmitted;
    });


    emulator.add_listener("mouse-enable", function(is_enabled)
    {
        os_uses_mouse = is_enabled;
        $("info_mouse_enabled").textContent = is_enabled ? "Yes" : "No";
    });

    emulator.add_listener("vmware-absolute-mouse", function(is_enabled)
    {
        os_uses_absolute_mouse = is_enabled;
    });

    emulator.add_listener("screen-set-size", function(args)
    {
        const [w, h, bpp] = args;
        $("info_res").textContent = w + "x" + h + (bpp ? "x" + bpp : "");
        $("info_vga_mode").textContent = bpp ? "Graphical" : "Text";
    });


    $("reset").onclick = function()
    {
        emulator.restart();
        $("reset").blur();
    };

    add_image_download_button(settings.hda, () => emulator.v86.cpu.devices.ide.primary.master.buffer, "hda");
    add_image_download_button(settings.hdb, () => emulator.v86.cpu.devices.ide.primary.slave.buffer, "hdb");
    add_image_download_button(settings.fda, () => emulator.v86.cpu.devices.fdc.drives[0].buffer, "fda");
    add_image_download_button(settings.fdb, () => emulator.v86.cpu.devices.fdc.drives[1].buffer, "fdb");
    add_image_download_button(settings.cdrom, () => emulator.v86.cpu.devices.cdrom.buffer, "cdrom");

    function add_image_download_button(obj, get_buffer, type)
    {
        var elem = $("get_" + type + "_image");

        if(!obj || obj.async)
        {
            elem.style.display = "none";
        }

        elem.onclick = function(e)
        {
            const buffer = get_buffer();
            const filename = buffer.file && buffer.file.name || ((profile?.id || "v86") + "-" + type + (type === "cdrom" ? ".iso" : ".img"));

            if(buffer.get_as_file)
            {
                var file = buffer.get_as_file(filename);
                download(file, filename);
            }
            else
            {
                buffer.get_buffer(function(b)
                {
                    if(b)
                    {
                        dump_file(b, filename);
                    }
                    else
                    {
                        alert("The file could not be loaded. Maybe it's too big?");
                    }
                });
            }

            elem.blur();
        };
    }

    function pick_file(multiple)
    {
        return new Promise(resolve => {
            const file_input = document.createElement("input");
            file_input.type = "file";
            file_input.multiple = multiple;
            file_input.onchange = function()
            {
                resolve(file_input.files);
            };
            file_input.oncancel = function()
            {
                resolve([]);
            };
            file_input.click();
        });
    }

    $("change_fda_image").textContent = settings.fda ? "Eject floppy image" : "Insert floppy image";
    $("change_fda_image").ondragover = function(e)
    {
        e.preventDefault();
    };
    async function insert_fda(files)
    {
        const file = files[0];
        if(file)
        {
            await emulator.set_fda({ buffer: file });
            $("change_fda_image").textContent = "Eject floppy image";
            $("get_fda_image").style.display = "block";
        }
    }
    $("change_fda_image").ondrop = function(e)
    {
        e.preventDefault();
        if(emulator.get_disk_fda())
        {
            emulator.eject_fda();
        }
        insert_fda(e.dataTransfer.files);
    };
    $("change_fda_image").onclick = async function()
    {
        if(emulator.get_disk_fda())
        {
            emulator.eject_fda();
            $("change_fda_image").textContent = "Insert floppy image";
            $("get_fda_image").style.display = "none";
        }
        else
        {
            const files = await pick_file(false);
            insert_fda(files);
        }
        $("change_fda_image").blur();
    };

    $("change_fdb_image").textContent = settings.fdb ? "Eject second floppy image" : "Insert second floppy image";
    $("change_fdb_image").ondragover = function(e)
    {
        e.preventDefault();
    };
    async function insert_fdb(files)
    {
        const file = files[0];
        if(file)
        {
            await emulator.set_fdb({ buffer: file });
            $("change_fdb_image").textContent = "Eject second floppy image";
            $("get_fdb_image").style.display = "block";
        }
    }
    $("change_fdb_image").ondrop = function(e)
    {
        e.preventDefault();
        if(emulator.get_disk_fdb())
        {
            emulator.eject_fdb();
        }
        insert_fdb(e.dataTransfer.files);
    };
    $("change_fdb_image").onclick = async function()
    {
        if(emulator.get_disk_fdb())
        {
            emulator.eject_fdb();
            $("change_fdb_image").textContent = "Insert second floppy image";
            $("get_fdb_image").style.display = "none";
        }
        else
        {
            const files = await pick_file(false);
            insert_fdb(files);
        }
        $("change_fdb_image").blur();
    };

    $("change_cdrom_image").textContent = settings.cdrom ? "Eject CD image" : "Insert CD image";
    $("change_cdrom_image").ondragover = function(e)
    {
        e.preventDefault();
    };
    async function insert_cdrom(files)
    {
        let buffer;

        if(files.length === 1 && /\.(iso(9660|img)?|cdr)$/i.test(files[0].name))
        {
            buffer = files[0];
        }
        else if(files.length)
        {
            const files2 = [];
            for(const file of files)
            {
                files2.push({
                    name: file.name,
                    contents: new Uint8Array(await read_file(file)),
                });

            }
            buffer = iso9660.generate(files2).buffer;
        }

        if(buffer)
        {
            await emulator.set_cdrom({ buffer });
            $("change_cdrom_image").textContent = "Eject CD image";
            $("get_cdrom_image").style.display = "block";
        }
    }
    $("change_cdrom_image").ondrop = function(e)
    {
        e.preventDefault();
        if(emulator.v86.cpu.devices.cdrom.has_disk())
        {
            emulator.eject_cdrom();
        }
        insert_cdrom(e.dataTransfer.files);
    };
    $("change_cdrom_image").onclick = async function()
    {
        if(emulator.v86.cpu.devices.cdrom.has_disk())
        {
            emulator.eject_cdrom();
            $("change_cdrom_image").textContent = "Insert CD image";
            $("get_cdrom_image").style.display = "none";
        }
        else
        {
            const files = await pick_file(true);
            insert_cdrom(files);
        }
        $("change_cdrom_image").blur();
    };

    $("memory_dump").onclick = function()
    {
        const mem8 = emulator.v86.cpu.mem8;
        dump_file(new Uint8Array(mem8.buffer, mem8.byteOffset, mem8.length), "v86memory.bin");
        $("memory_dump").blur();
    };

    //$("memory_dump_dmp").onclick = function()
    //{
    //    var memory = emulator.v86.cpu.mem8;
    //    var memory_size = memory.length;
    //    var page_size = 4096;
    //    var header = new Uint8Array(4096);
    //    var header32 = new Int32Array(header.buffer);

    //    header32[0] = 0x45474150; // 'PAGE'
    //    header32[1] = 0x504D5544; // 'DUMP'

    //    header32[0x10 >> 2] = emulator.v86.cpu.cr[3]; // DirectoryTableBase
    //    header32[0x24 >> 2] = 1; // NumberProcessors
    //    header32[0xf88 >> 2] = 1; // DumpType: full dump
    //    header32[0xfa0 >> 2] = header.length + memory_size; // RequiredDumpSpace

    //    header32[0x064 + 0 >> 2] = 1; // NumberOfRuns
    //    header32[0x064 + 4 >> 2] = memory_size / page_size; // NumberOfPages
    //    header32[0x064 + 8 >> 2] = 0; // BasePage
    //    header32[0x064 + 12 >> 2] = memory_size / page_size; // PageCount

    //    dump_file([header, memory], "v86memory.dmp");

    //    $("memory_dump_dmp").blur();
    //};

    /**
     * @this HTMLElement
     */
    $("capture_network_traffic").onclick = function()
    {
        this.textContent = "0 packets";

        let capture = [];

        function do_capture(direction, data)
        {
            capture.push({ direction, time: performance.now() / 1000, hex_dump: hex_dump(data) });
            $("capture_network_traffic").textContent = capture.length + " packets";
        }

        emulator.emulator_bus.register("net0-receive", do_capture.bind(this, "I"));
        emulator.add_listener("net0-send", do_capture.bind(this, "O"));

        this.onclick = function()
        {
            const capture_raw = capture.map(({ direction, time, hex_dump }) => {
                // https://www.wireshark.org/docs/wsug_html_chunked/ChIOImportSection.html
                // In wireshark: file -> import from hex -> tick direction indication, timestamp %s.%f
                return direction + " " + time.toFixed(6) + hex_dump + "\n";
            }).join("");
            dump_file(capture_raw, "traffic.hex");
            capture = [];
            this.textContent = "0 packets";
        };
    };


    $("save_state").onclick = async function()
    {
        const result = await emulator.save_state();
        dump_file(result, "v86state.bin");

        $("save_state").blur();
    };

    $("load_state").onclick = async function()
    {
        $("load_state").blur();

        const files = await pick_file(false);
        const file = files[0];

        if(!file)
        {
            return;
        }

        const was_running = emulator.is_running();

        if(was_running)
        {
            await emulator.stop();
        }

        const filereader = new FileReader();
        filereader.onload = async function(e)
        {
            try
            {
                await emulator.restore_state(e.target.result);
            }
            catch(err)
            {
                alert("Something bad happened while restoring the state:\n" + err + "\n\n" +
                      "Note that the current configuration must be the same as the original");
                throw err;
            }

            if(was_running)
            {
                emulator.run();
            }
        };
        filereader.readAsArrayBuffer(file);
    };

    $("ctrlaltdel").onclick = function()
    {
        emulator.keyboard_send_scancodes([
            0x1D, // ctrl
            0x38, // alt
            0x53, // delete

            // break codes
            0x1D | 0x80,
            0x38 | 0x80,
            0x53 | 0x80,
        ]);

        $("ctrlaltdel").blur();
    };

    $("alttab").onclick = function()
    {
        emulator.keyboard_send_scancodes([
            0x38, // alt
            0x0F, // tab
        ]);

        setTimeout(function()
        {
            emulator.keyboard_send_scancodes([
                0x38 | 0x80,
                0x0F | 0x80,
            ]);
        }, 100);

        $("alttab").blur();
    };

    /**
     * @this HTMLElement
     */
    $("scale").onchange = function()
    {
        var n = parseFloat(this.value);

        if(n || n > 0)
        {
            emulator.screen_set_scale(n, n);
        }
    };

    $("fullscreen").onclick = function()
    {
        emulator.screen_go_fullscreen();
    };

    $("screen_container").onclick = function(e)
    {
        if(emulator.is_running() && emulator.speaker_adapter?.audio_context?.state === "suspended")
        {
            emulator.speaker_adapter.audio_context.resume();
        }

        // No need to lock the mouse if the guest tracks the host cursor
        // through the absolute pointing device. The "Lock mouse" button can
        // still be used, e.g. for games (movement is then sent as relative
        // deltas).
        if(mouse_is_enabled && os_uses_mouse && !os_uses_absolute_mouse)
        {
            emulator.lock_mouse();
        }

        // allow text selection
        if(window.getSelection().isCollapsed)
        {
            const phone_keyboard = document.getElementsByClassName("phone_keyboard")[0];

            phone_keyboard.style.top = window.scrollY + e.clientY + 20 + "px";
            phone_keyboard.style.left = window.scrollX + e.clientX + "px";

            // clean after previous input
            phone_keyboard.value = "";
            phone_keyboard.focus();
        }
    };

    const phone_keyboard = document.getElementsByClassName("phone_keyboard")[0];

    phone_keyboard.setAttribute("autocorrect", "off");
    phone_keyboard.setAttribute("autocapitalize", "off");
    phone_keyboard.setAttribute("spellcheck", "false");
    phone_keyboard.tabIndex = 0;

    $("take_screenshot").onclick = function()
    {
        const image = emulator.screen_make_screenshot();
        try {
            const w = window.open("");
            w.document.write(image.outerHTML);
        }
        catch(e) {}
        $("take_screenshot").blur();
    };

    if(emulator.speaker_adapter)
    {
        let is_muted = false;

        $("mute").onclick = function()
        {
            if(is_muted)
            {
                emulator.speaker_adapter.mixer.set_volume(1, undefined);
                is_muted = false;
                $("mute").textContent = "Mute";
            }
            else
            {
                emulator.speaker_adapter.mixer.set_volume(0, undefined);
                is_muted = true;
                $("mute").textContent = "Unmute";
            }

            $("mute").blur();
        };
    }
    else
    {
        $("mute").remove();
    }

    window.addEventListener("keydown", ctrl_w_rescue, false);
    window.addEventListener("keyup", ctrl_w_rescue, false);
    window.addEventListener("blur", ctrl_w_rescue, false);

    function ctrl_w_rescue(e)
    {
        if(e.ctrlKey)
        {
            window.onbeforeunload = function()
            {
                window.onbeforeunload = null;
                return "CTRL-W cannot be sent to the emulator.";
            };
        }
        else
        {
            window.onbeforeunload = null;
        }
    }

    const script = document.createElement("script");
    script.src = "build/xterm.js";
    script.async = true;
    script.onload = function()
    {
        emulator.set_serial_container_xtermjs($("terminal"));
        emulator.serial_adapter.term.write("This is the serial console. Whatever you type or paste here will be sent to COM1");
    };
    document.body.appendChild(script);
}

function init_filesystem_panel(emulator)
{
    $("filesystem_panel").style.display = "block";

    /**
     * @this HTMLElement
     */
    $("filesystem_send_file").onchange = function()
    {
        Array.prototype.forEach.call(this.files, function(file)
        {
            var loader = new SyncFileBuffer(file);
            loader.onload = function()
            {
                loader.get_buffer(async function(buffer)
                {
                    await emulator.create_file("/" + file.name, new Uint8Array(buffer));
                });
            };
            loader.load();
        }, this);

        this.value = "";
        this.blur();
    };

    /**
     * @this HTMLElement
     */
    $("filesystem_get_file").onkeypress = async function(e)
    {
        if(e.which !== 13)
        {
            return;
        }

        this.disabled = true;

        let result;
        try
        {
             result = await emulator.read_file(this.value);
        }
        catch(err)
        {
            console.log(err);
        }

        this.disabled = false;

        if(result)
        {
            var filename = this.value.replace(/\/$/, "").split("/");
            filename = filename[filename.length - 1] || "root";

            dump_file(result, filename);
            this.value = "";
        }
        else
        {
            alert("Can't read file");
        }
    };
}

function debug_start(emulator)
{
    if(!emulator.v86)
    {
        return;
    }

    // called as soon as soon as emulation is started, in debug mode
    const cpu = emulator.v86.cpu;

    $("dump_gdt").onclick = cpu.dump_gdt_ldt.bind(cpu);
    $("dump_idt").onclick = cpu.dump_idt.bind(cpu);
    $("dump_regs").onclick = () => { cpu.dump_regs_short(); cpu.dump_state(); };
    $("dump_pt").onclick = cpu.dump_page_structures.bind(cpu);

    $("dump_log").onclick = function()
    {
        dump_file(log_data.join(""), "v86.log");
    };

    $("debug_panel").style.display = "block";
    setInterval(function()
    {
        $("debug_panel").textContent =
            cpu.get_regs_short().join("\n") + "\n" + cpu.debug_get_state();

        $("dump_log").textContent = "Dump log" + (log_data.length ? " (" + log_data.length + " lines)" : "");
    }, 1000);

    // helps debugging
    window.cpu = cpu;
    window.h = h;
    window.dump_file = dump_file;
}

function onpopstate(e)
{
    location.reload();
}

function format_query_args(params)
{
    const entries = Array.from(params.entries());
    if(entries.length)
    {
        return "?" + entries.map(([key, value]) => key + "=" + value.replace(/[?&=#+]/g, encodeURIComponent)).join("&");
    }
    else
    {
        return "";
    }
}

function push_state(params)
{
    if(window.history.pushState)
    {
        const search = format_query_args(params);
        window.history.pushState({ search }, "", search);
    }
}
