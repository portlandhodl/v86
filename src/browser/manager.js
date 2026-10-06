// The machine manager: the start page listing the served and imported machine profiles
// (see machines.js), with details, settings, import/export and image availability checks.
//
// Profile contents are untrusted (they can be imported from anywhere), so they're only ever
// inserted into the page as text.

import { download } from "../lib.js";
import {
    PROFILE_SCHEMA, load_catalogue, load_imported, save_imported, load_overrides, save_overrides,
    parse_profile_text, validate_profile, normalize_profile, profile_media, probe_url, media_label,
    format_bytes, parse_boot_order, describe_boot_order, supports_wasm_mem64, expand_relay_url,
} from "./machines.js";

const MAX_LOW_MEMORY_MB = 3072;

// [match, badge text, colour]
const DISTRO_BADGES = [
    ["debian", "Db", "#e8366e"],
    ["ubuntu", "Ub", "#ff6a2b"],
    ["xubuntu", "Xu", "#2f8fff"],
    ["puppy", "Pu", "#8bd450"],
    ["alpine", "Al", "#2fa6e8"],
    ["arch", "Ar", "#1fa4e8"],
    ["fedora", "Fe", "#5aa7ff"],
    ["mint", "Mi", "#87cf3e"],
    ["kali", "Ka", "#4aa3ff"],
    ["tinycore", "Tc", "#3fd0c9"],
    ["freebsd", "Fb", "#ff4a4a"],
    ["openbsd", "Ob", "#f2c94c"],
    ["netbsd", "Nb", "#ff8c2b"],
    ["haiku", "Hk", "#4ab3ff"],
    ["reactos", "Ro", "#5cc0ff"],
    ["windows", "Wi", "#2fb6ff"],
    ["dos", "DO", "#c0c0c0"],
];

function $(id)
{
    return document.getElementById(id);
}

/**
 * @param {string} tag
 * @param {string=} class_name
 * @param {string=} text
 * @return {!Element}
 */
function el(tag, class_name, text)
{
    const e = document.createElement(tag);
    if(class_name) e.className = class_name;
    if(text !== undefined) e.textContent = text;
    return e;
}

function clone(obj)
{
    return JSON.parse(JSON.stringify(obj));
}

function str(value)
{
    return typeof value === "string" ? value : "";
}

function file_name_of(url)
{
    try
    {
        const path = new URL(url, location.href).pathname;
        return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || url;
    }
    catch(e)
    {
        return url;
    }
}

function badge_for(p)
{
    const icon = p["icon"];
    if(icon && typeof icon === "object" && typeof icon["text"] === "string")
    {
        const color = /^#[0-9a-f]{3,8}$/i.test(str(icon["color"])) ? icon["color"] : "#39ff88";
        return [icon["text"].slice(0, 2), color];
    }
    const os = p["os"] || {};
    const haystack = [os["distro"], os["family"], p["id"], p["name"]].map(str).join(" ").toLowerCase();
    for(const [match, text, color] of DISTRO_BADGES)
    {
        if(haystack.includes(match)) return [text, color];
    }
    const name = str(p["name"]).replace(/[^a-z0-9]/gi, "");
    return [(name.slice(0, 1).toUpperCase() + name.slice(1, 2).toLowerCase()) || "??", "#39ff88"];
}

function make_badge(p, big)
{
    const [text, color] = badge_for(p);
    const badge = el("span", big ? "vm-badge vm-badge-big" : "vm-badge", text);
    badge.style.setProperty("--badge", color);
    return badge;
}

function safe_http_url(url)
{
    return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function os_summary(p)
{
    const os = p["os"] || {};
    return [os["family"], os["distro"] && os["distro"] !== os["family"] ? os["distro"] : null, os["version"]]
        .map(str).filter(s => s).join(" ");
}

function memory_mb(p)
{
    const machine = p["machine"] || {};
    return machine["memory_mb"] || 128;
}

/**
 * @param {{ start: function(!Object, boolean), query_args: !URLSearchParams }} options
 */
export function init_manager(options)
{
    const query_args = options.query_args;
    const has_mem64 = supports_wasm_mem64();

    /** @type {!Array<!Object>} */
    let machines = [];
    let image_base = "images/";
    let selected = null;
    let filter = "";
    const probe_cache = new Map();
    // id -> { type -> File }, local images replacing the served ones (this session only)
    const local_files = new Map();

    const list = $("vm_list");
    const details = $("vm_details");

    /**
     * @param {string} message
     * @param {string=} kind "info", "ok" or "error"
     */
    function toast(message, kind)
    {
        const container = $("mgr_toasts");
        const t = el("div", "toast toast-" + (kind || "info"), message);
        container.appendChild(t);
        setTimeout(() => t.classList.add("toast-out"), kind === "error" ? 9000 : 4000);
        setTimeout(() => t.remove(), kind === "error" ? 9500 : 4500);
    }

    function set_status(text)
    {
        $("mgr_status").textContent = text;
    }

    function rebuild(catalogue_profiles)
    {
        const overrides = load_overrides();
        const served_ids = new Set();
        const result = [];
        for(const p of catalogue_profiles)
        {
            served_ids.add(p["id"]);
            const override = overrides[p["id"]];
            const edited = !!override && !validate_profile(override).length;
            result.push({ id: p["id"], raw: edited ? override : p, served: p, source: "served", edited });
        }
        for(const p of load_imported())
        {
            if(served_ids.has(p["id"])) continue;
            result.push({ id: p["id"], raw: p, served: null, source: "imported", edited: false });
        }
        return result;
    }

    let catalogue = [];

    function refresh(keep_selection)
    {
        const previous = keep_selection && selected ? selected.id : null;
        machines = rebuild(catalogue);
        selected = machines.find(m => m.id === previous) || selected && machines.find(m => m.id === selected.id) || machines[0] || null;
        render_list();
        render_details();
        probe_all();
    }

    // ---- availability ----

    function media_of(machine)
    {
        return profile_media(machine.raw, image_base);
    }

    function probe(url)
    {
        if(!probe_cache.has(url))
        {
            probe_cache.set(url, probe_url(url));
        }
        return probe_cache.get(url);
    }

    function machine_state(machine)
    {
        const local = local_files.get(machine.id) || {};
        let state = "ok";
        for(const m of media_of(machine))
        {
            if(local[m.type]) continue;
            const result = machine.probes && machine.probes[m.url];
            if(!result) return "probing";
            if(!result.ok) state = "missing";
        }
        return state;
    }

    function probe_all()
    {
        for(const machine of machines)
        {
            const probes = machine.probes = machine.probes || {};
            for(const m of media_of(machine))
            {
                if(probes[m.url]) continue;
                probe(m.url).then(result =>
                {
                    probes[m.url] = result;
                    update_machine_status(machine);
                });
            }
        }
        update_footer();
    }

    function update_machine_status(machine)
    {
        const item = Array.from(list.querySelectorAll(".vm-item")).find(item => item.dataset["id"] === machine.id);
        if(item)
        {
            const dot = item.querySelector(".vm-dot");
            dot.className = "vm-dot vm-dot-" + machine_state(machine);
        }
        if(selected === machine)
        {
            render_details();
        }
        update_footer();
    }

    function update_footer()
    {
        let online = 0;
        for(const machine of machines)
        {
            if(machine_state(machine) === "ok") online++;
        }
        $("mgr_count").textContent = `[${machines.length}]`;
        set_status(`${online}/${machines.length} machines ready  ::  images ${image_base}  ::  ` +
            `mem64 ${has_mem64 ? "available" : "unavailable"}  ::  ${navigator.hardwareConcurrency || "?"} host threads`);
    }

    // ---- list ----

    function visible_machines()
    {
        if(!filter) return machines;
        const needle = filter.toLowerCase();
        return machines.filter(m =>
            [m.raw["name"], m.raw["id"], os_summary(m.raw), m.raw["description"]].map(str).join(" ").toLowerCase().includes(needle));
    }

    function render_list()
    {
        list.textContent = "";
        const visible = visible_machines();
        for(const machine of visible)
        {
            const p = machine.raw;
            const item = el("li", "vm-item" + (machine === selected ? " selected" : ""));
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(machine === selected));
            item.dataset["id"] = machine.id;

            item.appendChild(make_badge(p, false));

            const text = el("div", "vm-item-text");
            text.appendChild(el("div", "vm-item-name", p["name"]));
            const os = p["os"] || {};
            const sub = [str(os["arch"]) || "x86", format_bytes(memory_mb(p) * 1024 * 1024)];
            if(machine.source === "imported") sub.push("imported");
            if(machine.edited) sub.push("edited");
            text.appendChild(el("div", "vm-item-sub", sub.join(" · ")));
            item.appendChild(text);

            item.appendChild(el("span", "vm-dot vm-dot-" + machine_state(machine)));

            item.onclick = () => select(machine);
            item.ondblclick = () => start(machine);
            list.appendChild(item);
        }

        if(!visible.length)
        {
            const empty = el("li", "vm-empty");
            empty.textContent = machines.length ? `no machine matches "${filter}"` : "no machines loaded";
            list.appendChild(empty);
        }

        update_toolbar();
    }

    function select(machine)
    {
        if(selected === machine) return;
        selected = machine;
        for(const item of list.querySelectorAll(".vm-item"))
        {
            const is_selected = item.dataset["id"] === machine.id;
            item.classList.toggle("selected", is_selected);
            item.setAttribute("aria-selected", String(is_selected));
            if(is_selected) item.scrollIntoView({ block: "nearest" });
        }
        render_details();
        update_toolbar();
    }

    function update_toolbar()
    {
        const has = !!selected;
        $("tb_start").disabled = !has;
        $("tb_settings").disabled = !has;
        $("tb_export").disabled = !has;
        $("tb_remove").disabled = !has || selected.source !== "imported";
        $("tb_remove").title = has && selected.source !== "imported" ?
            "Served machines can't be removed (edits can be reverted in Settings)" : "Remove imported machine";
    }

    // ---- details ----

    function section(title, icon, rows)
    {
        const box = el("section", "detail-box");
        const head = el("h3", "detail-head");
        head.appendChild(el("span", "detail-icon", icon));
        head.appendChild(document.createTextNode(title));
        box.appendChild(head);
        const table = el("dl", "detail-rows");
        for(const [key, value] of rows)
        {
            if(value === null || value === undefined || value === "") continue;
            table.appendChild(el("dt", "", key));
            const dd = el("dd");
            if(typeof value === "object") dd.appendChild(/** @type {!Node} */ (value));
            else dd.textContent = String(value);
            table.appendChild(dd);
        }
        box.appendChild(table);
        return box;
    }

    function render_details()
    {
        details.textContent = "";
        if(!selected)
        {
            const empty = el("div", "details-empty");
            empty.appendChild(el("pre", "ascii-logo", ASCII_LOGO));
            empty.appendChild(el("p", "", "No machine selected. Import a machine profile (*.json) to get started."));
            details.appendChild(empty);
            return;
        }

        const machine = selected;
        const p = machine.raw;
        const os = p["os"] || {};
        const m = p["machine"] || {};
        const state = machine_state(machine);
        const local = local_files.get(machine.id) || {};
        const media = media_of(machine);
        const mem = memory_mb(p);

        // header
        const header = el("div", "details-header");
        header.appendChild(make_badge(p, true));
        const title = el("div", "details-title");
        title.appendChild(el("h2", "glow", p["name"]));
        title.appendChild(el("div", "details-subtitle", [os_summary(p), str(os["arch"])].filter(s => s).join("  ·  ") || p["id"]));
        const pills = el("div", "pills");
        const state_text = { "ok": "READY", "probing": "PROBING", "missing": "IMAGE MISSING" }[state];
        pills.appendChild(el("span", "pill pill-" + state, state_text));
        pills.appendChild(el("span", "pill", machine.source === "served" ? "SERVED" : "IMPORTED"));
        if(machine.edited) pills.appendChild(el("span", "pill pill-warn", "EDITED"));
        if(Object.keys(local).length) pills.appendChild(el("span", "pill pill-info", "LOCAL IMAGE"));
        if(mem > MAX_LOW_MEMORY_MB) pills.appendChild(el("span", "pill" + (has_mem64 ? "" : " pill-missing"), "MEM64"));
        title.appendChild(pills);
        header.appendChild(title);

        const start_button = el("button", "big-start");
        start_button.appendChild(el("span", "big-start-icon", "▶"));
        start_button.appendChild(document.createTextNode("Start"));
        start_button.onclick = () => start(machine);
        header.appendChild(start_button);
        details.appendChild(header);

        // terminal preview
        const term = el("div", "term-preview");
        const lines = [["$ ", "v86 inspect " + p["id"]]];
        lines.push(["  ", "arch    " + (str(os["arch"]) || "x86") + (str(os["arch"]).includes("64") ? " (long mode)" : "")]);
        const boot = p["media"]["bzimage"] ? "direct kernel boot" : p["media"]["cdrom"] ? "cdrom (el torito)" : p["media"]["hda"] ? "hard disk" : p["media"]["fda"] ? "floppy" : "custom";
        lines.push(["  ", "boot    " + boot]);
        lines.push(["  ", `ram     ${mem} MiB   vram ${m["vram_mb"] || 8} MiB`]);
        for(const item of media)
        {
            const result = machine.probes && machine.probes[item.url];
            const status = local[item.type] ? "LOCAL" : !result ? "...." : result.ok ? "ONLINE" : "MISSING";
            lines.push(["  ", `${item.type.padEnd(7)} ${file_name_of(item.url)} [${status}]`]);
        }
        lines.push(["$ ", ""]);
        lines.forEach(([prompt, text], i) =>
        {
            const line = el("div", "term-line");
            line.style.setProperty("--i", String(i));
            line.appendChild(el("span", prompt.trim() ? "term-prompt" : "", prompt));
            line.appendChild(el("span", "", text));
            if(i === lines.length - 1) line.appendChild(el("span", "blinking-cursor term-cursor", " "));
            term.appendChild(line);
        });
        details.appendChild(term);

        // detail boxes
        const grid = el("div", "detail-grid");

        grid.appendChild(section("General", "◆", [
            ["Name", p["name"]],
            ["ID", p["id"]],
            ["Operating System", os_summary(p) || "Unknown"],
            ["Architecture", str(os["arch"]) || "x86"],
            ["Interface", str(os["ui"])],
        ]));

        let mem_text = `${mem} MiB`;
        if(mem > MAX_LOW_MEMORY_MB)
        {
            mem_text += has_mem64 ? " (mem64 build)" : " (needs wasm memory64: unsupported here)";
        }
        grid.appendChild(section("System", "▣", [
            ["Base Memory", mem_text],
            ["Boot Order", describe_boot_order(parse_boot_order(m["boot_order"]))],
            ["ACPI", m["acpi"] ? "Enabled" : "Disabled"],
            ["Floppy drives", m["floppy_drives"] === false ? "Disconnected" : null],
        ]));

        grid.appendChild(section("Display", "▤", [
            ["Video Memory", `${m["vram_mb"] || 8} MiB`],
            ["Graphics Controller", m["virtio_gpu"] ? "virtio-gpu (WebGPU)" : "VGA (Bochs VBE)"],
        ]));

        const storage_rows = [];
        for(const item of media)
        {
            const value = el("span", "media-value");
            const file = local[item.type];
            if(file)
            {
                value.appendChild(el("span", "media-name", file.name));
                value.appendChild(el("span", "media-meta", ` ${format_bytes(file.size)} · local file`));
            }
            else
            {
                const result = machine.probes && machine.probes[item.url];
                const size = item.size !== undefined ? item.size : result && result.size;
                value.appendChild(el("span", "media-name", file_name_of(item.url)));
                value.appendChild(el("span", "media-meta", " " + (size !== undefined ? format_bytes(size) : "")));
                const status = !result ? "probing" : result.ok ? "ok" : "missing";
                value.appendChild(el("span", "media-status media-status-" + status,
                    { "probing": " [probing]", "ok": " [online]", "missing": ` [missing${result && result.status ? ": HTTP " + result.status : ""}]` }[status]));
                value.title = item.url;
            }
            storage_rows.push([media_label(item.type), value]);
        }
        if(typeof p["cmdline"] === "string")
        {
            storage_rows.push(["Kernel command line", el("code", "cmdline", p["cmdline"])]);
        }
        const storage = section("Storage", "▥", storage_rows);
        storage.classList.add("detail-span2");
        grid.appendChild(storage);

        const nic = m["net_device_type"] || "ne2k";
        grid.appendChild(section("Network", "⇄", [
            ["Adapter", nic === "none" ? "Not attached" : nic === "virtio" ? "virtio-net" : "NE2000 (ne2k)"],
            ["Relay", m["relay_url"] !== undefined ? (expand_relay_url(str(m["relay_url"])) || "None") : "Default (see manual setup)"],
        ]));

        grid.appendChild(section("Audio", "♪", [
            ["Controller", m["disable_audio"] ? "Disabled" : "SB16 + PC speaker"],
        ]));

        const homepage = safe_http_url(p["homepage"]);
        const download_url = safe_http_url(p["download"]);
        const desc_rows = [];
        if(p["description"]) desc_rows.push(["", el("p", "description-text", str(p["description"]))]);
        if(homepage)
        {
            const a = el("a", "", homepage);
            a.href = homepage;
            a.target = "_blank";
            a.rel = "noopener";
            desc_rows.push(["Homepage", a]);
        }
        if(download_url)
        {
            const a = el("a", "", file_name_of(download_url));
            a.href = download_url;
            a.target = "_blank";
            a.rel = "noopener";
            a.title = download_url;
            desc_rows.push(["Upstream image", a]);
        }
        if(p["notes"]) desc_rows.push(["Notes", el("p", "description-text", str(p["notes"]))]);
        if(desc_rows.length)
        {
            const box = section("Description", "¶", desc_rows);
            box.classList.add("detail-wide");
            grid.appendChild(box);
        }

        details.appendChild(grid);

        if(state === "missing")
        {
            const warn = el("div", "details-warning");
            warn.textContent = "One or more images aren't available on this host. Place them under " +
                image_base + ", attach a local file in Settings → Storage, or fix the url in the profile.";
            details.insertBefore(warn, grid);
        }
    }

    // ---- actions ----

    function start(machine)
    {
        if(!machine) return;
        const state = machine_state(machine);
        if(state === "missing" &&
            !window.confirm(`Some images for "${machine.raw["name"]}" were not found on the server. Start anyway?`))
        {
            return;
        }
        const mem = memory_mb(machine.raw);
        if(mem > MAX_LOW_MEMORY_MB && !has_mem64)
        {
            toast(`${mem} MiB of RAM need WebAssembly memory64 + multi-memory (e.g. Chrome 133+). ` +
                `Lower the memory to ${MAX_LOW_MEMORY_MB} MiB in Settings.`, "error");
            return;
        }

        const profile = normalize_profile(machine.raw, image_base);
        const local = local_files.get(machine.id) || {};
        for(const type of Object.keys(local))
        {
            const image = { buffer: local[type] };
            switch(type)
            {
                case "cdrom": profile.cdrom = image; break;
                case "hda": profile.hda = image; break;
                case "hdb": profile.hdb = image; break;
                case "fda": profile.fda = image; break;
                case "bzimage": profile.bzimage = image; break;
                case "initrd": profile.initrd = image; break;
            }
        }

        for(const dialog of document.querySelectorAll("dialog[open]"))
        {
            dialog.close();
        }
        $("manager").classList.add("booting");
        options.start(profile, false);
    }

    function export_machine(machine)
    {
        const text = JSON.stringify(machine.raw, null, 4) + "\n";
        download(new Blob([text], { type: "application/json" }), machine.id + ".json");
    }

    function remove_machine(machine)
    {
        if(!machine || machine.source !== "imported") return;
        if(!window.confirm(`Remove "${machine.raw["name"]}"? The profile is deleted from this browser.`)) return;
        save_imported(load_imported().filter(p => p["id"] !== machine.id));
        local_files.delete(machine.id);
        selected = null;
        toast(`Removed ${machine.raw["name"]}`);
        refresh(false);
    }

    /**
     * Add profiles (already validated) to the imported list
     * @param {!Array<!Object>} profiles
     */
    function import_profiles(profiles)
    {
        const imported = load_imported();
        const served_ids = new Set(catalogue.map(p => p["id"]));
        let last_id = null;
        for(const original of profiles)
        {
            const p = clone(original);
            if(served_ids.has(p["id"]))
            {
                let n = 2;
                while(served_ids.has(`${p["id"]}-${n}`) || imported.some(q => q["id"] === `${p["id"]}-${n}`)) n++;
                p["id"] = `${p["id"]}-${n}`;
            }
            const existing = imported.findIndex(q => q["id"] === p["id"]);
            if(existing >= 0)
            {
                imported[existing] = p;
                toast(`Updated ${p["name"]}`, "ok");
            }
            else
            {
                imported.push(p);
                toast(`Loaded ${p["name"]}`, "ok");
            }
            last_id = p["id"];
        }
        save_imported(imported);
        machines = rebuild(catalogue);
        selected = machines.find(m => m.id === last_id) || selected;
        render_list();
        render_details();
        probe_all();
    }

    /**
     * Parse text that is a profile, an array of profiles or a { profiles: [...] } bundle
     * @param {string} text
     * @param {string} source
     * @return {!Array<!Object>}
     */
    function profiles_from_text(text, source)
    {
        let data;
        try
        {
            data = JSON.parse(text);
        }
        catch(e)
        {
            throw new Error(`${source}: invalid JSON (${e.message})`);
        }
        const items = Array.isArray(data) ? data :
            data && Array.isArray(data["profiles"]) && typeof data["profiles"][0] === "object" ? data["profiles"] :
            [data];
        return items.map((item, i) =>
        {
            try
            {
                return parse_profile_text(JSON.stringify(item));
            }
            catch(e)
            {
                throw new Error(`${source}${items.length > 1 ? " #" + (i + 1) : ""}: ${e.message}`);
            }
        });
    }

    async function import_files(files)
    {
        const profiles = [];
        const errors = [];
        for(const file of files)
        {
            try
            {
                if(file.size > 1024 * 1024) throw new Error(`${file.name}: too large for a machine profile`);
                profiles.push(...profiles_from_text(await file.text(), file.name));
            }
            catch(e)
            {
                errors.push(e.message);
            }
        }
        if(profiles.length) import_profiles(profiles);
        return errors;
    }

    // ---- import dialog ----

    function open_import()
    {
        $("import_error").textContent = "";
        $("import_paste").value = "";
        show_import_tab("file");
        $("import_dialog").showModal();
    }

    function show_import_tab(name)
    {
        for(const tab of document.querySelectorAll("#import_dialog [data-tab]"))
        {
            tab.classList.toggle("active", tab.dataset["tab"] === name);
        }
        for(const pane of document.querySelectorAll("#import_dialog [data-pane]"))
        {
            pane.hidden = pane.dataset["pane"] !== name;
        }
    }

    function import_finished(errors)
    {
        if(errors.length)
        {
            $("import_error").textContent = errors.join("\n");
        }
        else
        {
            $("import_dialog").close();
        }
    }

    for(const tab of document.querySelectorAll("#import_dialog [data-tab]"))
    {
        tab.onclick = () => show_import_tab(tab.dataset["tab"]);
    }

    $("import_file").onchange = async function()
    {
        const files = Array.from($("import_file").files);
        $("import_file").value = "";
        import_finished(await import_files(files));
    };

    $("import_url_go").onclick = async function()
    {
        const url = $("import_url").value.trim();
        if(!url) return;
        $("import_error").textContent = "fetching...";
        try
        {
            const response = await fetch(new URL(url, location.href).href);
            if(!response.ok) throw new Error("HTTP " + response.status);
            const profiles = profiles_from_text(await response.text(), file_name_of(url));
            for(const p of profiles)
            {
                // images given relative to the profile are relative to where it came from
                if(!p["image_base"]) p["image_base"] = new URL(".", new URL(url, location.href)).href;
            }
            import_profiles(profiles);
            import_finished([]);
        }
        catch(e)
        {
            import_finished([`${url}: ${e.message}`]);
        }
    };

    $("import_paste_go").onclick = function()
    {
        try
        {
            import_profiles(profiles_from_text($("import_paste").value, "pasted text"));
            import_finished([]);
        }
        catch(e)
        {
            import_finished([e.message]);
        }
    };

    $("import_template").onclick = function()
    {
        $("import_paste").value = JSON.stringify(TEMPLATE, null, 4);
    };

    $("import_cancel").onclick = () => $("import_dialog").close();

    // ---- drag and drop ----

    let drag_depth = 0;
    const is_file_drag = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");

    document.addEventListener("dragenter", e =>
    {
        if(!is_file_drag(e) || $("manager").offsetParent === null) return;
        drag_depth++;
        $("drop_overlay").classList.add("visible");
        e.preventDefault();
    });
    document.addEventListener("dragover", e =>
    {
        if(!is_file_drag(e) || $("manager").offsetParent === null) return;
        e.preventDefault();
    });
    document.addEventListener("dragleave", e =>
    {
        if(!is_file_drag(e)) return;
        drag_depth = Math.max(0, drag_depth - 1);
        if(!drag_depth) $("drop_overlay").classList.remove("visible");
    });
    document.addEventListener("drop", async e =>
    {
        if(!is_file_drag(e) || $("manager").offsetParent === null) return;
        e.preventDefault();
        drag_depth = 0;
        $("drop_overlay").classList.remove("visible");
        const files = Array.from(e.dataTransfer.files);
        const json = files.filter(f => /\.json$/i.test(f.name) || f.type === "application/json");
        const images = files.filter(f => !json.includes(f));
        const errors = await import_files(json);
        for(const error of errors) toast(error, "error");
        if(images.length && selected)
        {
            attach_local_image(selected, images[0]);
        }
    });

    function guess_media_type(machine, file)
    {
        const name = file.name.toLowerCase();
        if(/\.iso$/.test(name)) return "cdrom";
        if(/\.(img|ima|flp)$/.test(name) && file.size <= 2949120) return "fda";
        if(/vmlinuz|bzimage/.test(name)) return "bzimage";
        if(/initrd|initramfs/.test(name)) return "initrd";
        if(/\.(img|bin|raw|hdd)$/.test(name)) return "hda";
        return machine.raw["media"]["cdrom"] ? "cdrom" : "hda";
    }

    /**
     * @param {string=} type media type, guessed from the file name if not given
     */
    function attach_local_image(machine, file, type)
    {
        type = type || guess_media_type(machine, file);
        const local = local_files.get(machine.id) || {};
        local[type] = file;
        local_files.set(machine.id, local);
        toast(`${file.name} attached to ${machine.raw["name"]} as ${media_label(type)} (this session only)`, "ok");
        render_list();
        render_details();
    }

    // ---- settings dialog ----

    let editing = null;
    let working = null;
    let settings_tab = "general";

    function form_from_working()
    {
        const p = working;
        const m = p["machine"] || {};
        const media = p["media"] || {};
        $("set_name").value = str(p["name"]);
        $("set_id").textContent = p["id"];
        $("set_description").value = str(p["description"]);
        $("set_memory").value = memory_mb(p);
        $("set_memory_range").value = Math.min(16384, memory_mb(p));
        $("set_acpi").checked = !!m["acpi"];
        const order = parse_boot_order(m["boot_order"]).toString(16);
        $("set_boot_order").value = Array.from($("set_boot_order").options).some(o => o.value === order) ? order : "0";
        $("set_vram").value = m["vram_mb"] || 8;
        $("set_virtio_gpu").checked = !!m["virtio_gpu"];
        $("set_floppy").checked = m["floppy_drives"] !== false;
        const cdrom = media["cdrom"];
        $("set_cdrom_url").value = typeof cdrom === "string" ? cdrom : cdrom ? str(cdrom["url"]) : "";
        $("set_cmdline").value = str(p["cmdline"]);
        $("set_nic").value = m["net_device_type"] || "ne2k";
        $("set_relay_default").checked = m["relay_url"] === undefined;
        $("set_relay").value = str(m["relay_url"]);
        $("set_relay").disabled = m["relay_url"] === undefined;
        $("set_mute").checked = !!m["disable_audio"];
        update_memory_hint();
        render_local_files();
    }

    function working_from_form()
    {
        const p = working;
        const m = p["machine"] = p["machine"] || {};
        const media = p["media"] = p["media"] || {};
        p["name"] = $("set_name").value.trim() || p["name"];
        const description = $("set_description").value.trim();
        if(description) p["description"] = description;
        else delete p["description"];
        m["memory_mb"] = Math.max(16, parseInt($("set_memory").value, 10) || 128);
        m["acpi"] = $("set_acpi").checked;
        const order = parseInt($("set_boot_order").value, 16);
        if(order) m["boot_order"] = order;
        else delete m["boot_order"];
        m["vram_mb"] = Math.max(1, parseInt($("set_vram").value, 10) || 8);
        if($("set_virtio_gpu").checked) m["virtio_gpu"] = true;
        else delete m["virtio_gpu"];
        if($("set_floppy").checked) delete m["floppy_drives"];
        else m["floppy_drives"] = false;
        const cdrom_url = $("set_cdrom_url").value.trim();
        if(cdrom_url)
        {
            if(typeof media["cdrom"] === "object" && media["cdrom"])
            {
                if(media["cdrom"]["url"] !== cdrom_url)
                {
                    media["cdrom"] = { "url": cdrom_url };
                }
            }
            else
            {
                media["cdrom"] = cdrom_url;
            }
        }
        else
        {
            delete media["cdrom"];
        }
        const cmdline = $("set_cmdline").value.trim();
        if(cmdline) p["cmdline"] = cmdline;
        else delete p["cmdline"];
        m["net_device_type"] = $("set_nic").value;
        if($("set_relay_default").checked) delete m["relay_url"];
        else m["relay_url"] = $("set_relay").value.trim();
        if($("set_mute").checked) m["disable_audio"] = true;
        else delete m["disable_audio"];
    }

    function update_memory_hint()
    {
        const mem = parseInt($("set_memory").value, 10) || 0;
        const hint = $("set_memory_hint");
        if(mem > MAX_LOW_MEMORY_MB)
        {
            hint.textContent = has_mem64 ? "> 3 GiB: uses the mem64 build" : "> 3 GiB needs wasm memory64, which this browser lacks";
            hint.className = "hint" + (has_mem64 ? "" : " hint-error");
        }
        else
        {
            hint.textContent = "";
        }
    }

    function render_local_files()
    {
        const container = $("set_local_files");
        container.textContent = "";
        const local = local_files.get(editing.id) || {};
        for(const type of Object.keys(local))
        {
            const row = el("div", "local-file");
            row.appendChild(el("span", "", `${media_label(type)}: ${local[type].name} (${format_bytes(local[type].size)})`));
            const detach = el("button", "small", "detach");
            detach.onclick = () =>
            {
                delete local[type];
                render_local_files();
            };
            row.appendChild(detach);
            container.appendChild(row);
        }
    }

    function show_settings_tab(name)
    {
        if(settings_tab === "json" && name !== "json")
        {
            if(!apply_json()) return;
            form_from_working();
        }
        if(name === "json" && settings_tab !== "json")
        {
            working_from_form();
            $("set_json").value = JSON.stringify(working, null, 4);
        }
        settings_tab = name;
        for(const tab of document.querySelectorAll("#settings_dialog [data-tab]"))
        {
            tab.classList.toggle("active", tab.dataset["tab"] === name);
        }
        for(const pane of document.querySelectorAll("#settings_dialog [data-pane]"))
        {
            pane.hidden = pane.dataset["pane"] !== name;
        }
        $("set_error").textContent = "";
    }

    function apply_json()
    {
        try
        {
            const p = parse_profile_text($("set_json").value);
            if(p["id"] !== editing.id)
            {
                throw new Error("the id can't be changed here (export, edit and import instead)");
            }
            working = p;
            return true;
        }
        catch(e)
        {
            $("set_error").textContent = e.message;
            return false;
        }
    }

    function open_settings(machine)
    {
        if(!machine) return;
        editing = machine;
        working = clone(machine.raw);
        settings_tab = "general";
        $("settings_title").textContent = machine.raw["name"] + " - Settings";
        $("set_revert").hidden = !machine.edited;
        form_from_working();
        show_settings_tab("general");
        $("settings_dialog").showModal();
    }

    for(const tab of document.querySelectorAll("#settings_dialog [data-tab]"))
    {
        tab.onclick = () => show_settings_tab(tab.dataset["tab"]);
    }

    $("set_memory").oninput = function()
    {
        $("set_memory_range").value = $("set_memory").value;
        update_memory_hint();
    };
    $("set_memory_range").oninput = function()
    {
        $("set_memory").value = $("set_memory_range").value;
        update_memory_hint();
    };
    $("set_relay_default").onchange = function()
    {
        $("set_relay").disabled = $("set_relay_default").checked;
    };
    for(const preset of document.querySelectorAll("#settings_dialog [data-relay]"))
    {
        preset.onclick = function()
        {
            const value = preset.dataset["relay"];
            $("set_relay_default").checked = false;
            $("set_relay").disabled = false;
            $("set_relay").value = value;
        };
    }
    $("set_local_file").onchange = function()
    {
        const file = $("set_local_file").files[0];
        $("set_local_file").value = "";
        if(file)
        {
            attach_local_image(editing, file, $("set_local_type").value);
            render_local_files();
        }
    };

    $("set_cancel").onclick = () => $("settings_dialog").close();

    $("set_ok").onclick = function()
    {
        if(settings_tab === "json")
        {
            if(!apply_json()) return;
        }
        else
        {
            working_from_form();
        }
        const errors = validate_profile(working);
        if(errors.length)
        {
            $("set_error").textContent = errors.join("\n");
            return;
        }
        if(editing.source === "imported")
        {
            save_imported(load_imported().map(p => p["id"] === editing.id ? working : p));
        }
        else
        {
            const overrides = load_overrides();
            if(JSON.stringify(working) === JSON.stringify(editing.served))
            {
                delete overrides[editing.id];
            }
            else
            {
                overrides[editing.id] = working;
            }
            save_overrides(overrides);
        }
        $("settings_dialog").close();
        refresh(true);
    };

    $("set_revert").onclick = function()
    {
        const overrides = load_overrides();
        delete overrides[editing.id];
        save_overrides(overrides);
        $("settings_dialog").close();
        toast(`Restored the served settings of ${editing.served["name"]}`);
        refresh(true);
    };

    // ---- toolbar and keyboard ----

    $("tb_import").onclick = open_import;
    $("tb_manual").onclick = () => $("manual_dialog").showModal();
    $("manual_cancel").onclick = () => $("manual_dialog").close();
    $("tb_start").onclick = () => start(selected);
    $("tb_settings").onclick = () => open_settings(selected);
    $("tb_export").onclick = () => selected && export_machine(selected);
    $("tb_remove").onclick = () => remove_machine(selected);
    $("mgr_search").oninput = function()
    {
        filter = $("mgr_search").value.trim();
        render_list();
    };

    document.addEventListener("keydown", e =>
    {
        if($("manager").offsetParent === null || document.querySelector("dialog[open]")) return;
        const target = /** @type {Element} */ (e.target);
        if(target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
        {
            if(e.key === "Escape") target.blur();
            return;
        }
        const visible = visible_machines();
        const index = visible.indexOf(selected);
        if(e.key === "ArrowDown" || e.key === "j")
        {
            if(visible.length) select(visible[Math.min(visible.length - 1, index + 1)]);
            e.preventDefault();
        }
        else if(e.key === "ArrowUp" || e.key === "k")
        {
            if(visible.length) select(visible[Math.max(0, index - 1)]);
            e.preventDefault();
        }
        else if(e.key === "Enter")
        {
            start(selected);
            e.preventDefault();
        }
        else if(e.key === "/")
        {
            $("mgr_search").focus();
            e.preventDefault();
        }
        else if(e.key === "Delete")
        {
            remove_machine(selected);
        }
        else if(e.key === "i" && (e.ctrlKey || e.metaKey))
        {
            open_import();
            e.preventDefault();
        }
        else if(e.key === "s" && (e.ctrlKey || e.metaKey))
        {
            open_settings(selected);
            e.preventDefault();
        }
    });

    // ---- startup ----

    const clock = $("mgr_clock");
    const tick = () => clock.textContent = new Date().toISOString().slice(11, 19);
    tick();
    setInterval(tick, 1000);

    set_status("loading machine catalogue...");
    render_details();

    return load_catalogue(query_args.get("cdn")).then(result =>
    {
        catalogue = result.profiles;
        image_base = result.image_base;
        for(const error of result.errors)
        {
            toast(error, "error");
        }
        machines = rebuild(catalogue);

        const wanted = query_args.get("profile");
        const machine = wanted && machines.find(m => m.id === wanted);
        if(machine)
        {
            // started from a link: boot straight away
            selected = machine;
            options.start(normalize_profile(machine.raw, image_base), true);
            return true;
        }
        if(wanted && wanted !== "custom")
        {
            toast(`Unknown machine "${wanted}"`, "error");
        }

        selected = machines[0] || null;
        render_list();
        render_details();
        probe_all();
        return false;
    });
}

const ASCII_LOGO = String.raw`
        ___    __     _____ __ __
 _   __/ _ \  / /_   / ___// // /
| | / / (_) |/ __ \ / __ \/ // /_
| |/ /\__, // /_/ // /_/ /__  __/
|___//____/ \____/ \____/  /_/
`;

const TEMPLATE = {
    "schema": PROFILE_SCHEMA,
    "id": "my-distro",
    "name": "My Distro 1.0",
    "os": { "family": "Linux", "distro": "mydistro", "version": "1.0", "arch": "x86_64", "ui": "graphical" },
    "description": "A short description shown in the machine details.",
    "homepage": "https://example.org/",
    "machine": {
        "memory_mb": 2048,
        "vram_mb": 16,
        "acpi": true,
        "boot_order": "cd,hd,fd",
        "net_device_type": "ne2k",
    },
    "media": {
        "cdrom": { "url": "my-distro-1.0-amd64.iso", "async": true },
    },
};
