// Machine profiles: JSON documents describing an OS and the images it boots from.
//
// The served catalogue is profiles/index.json, which lists one JSON file per machine (see
// profiles/README.md for the format). Users can import further profiles (file, URL or pasted
// text); those and any per-machine settings edits are kept in localStorage.
//
// Note: profiles are parsed JSON, so their properties must only be read with bracket
// notation (closure compiler renames dotted property accesses). normalize_profile converts a
// profile into the internal object that start_emulation consumes.

export const PROFILE_SCHEMA = "v86-machine/1";
export const MANIFEST_URL = "profiles/index.json";

const STORAGE_IMPORTED = "v86_machines_imported";
const STORAGE_OVERRIDES = "v86_machines_overrides";

const MB = 1024 * 1024;

// image types the emulator accepts, in the order they're shown in the storage section
export const MEDIA_TYPES = ["cdrom", "hda", "hdb", "fda", "fdb", "bzimage", "initrd", "multiboot", "state"];

const MEDIA_LABELS = {
    "cdrom": "CD/DVD (IDE 1:0)",
    "hda": "Disk (IDE 0:0)",
    "hdb": "Disk (IDE 0:1)",
    "fda": "Floppy A:",
    "fdb": "Floppy B:",
    "bzimage": "Kernel",
    "initrd": "Initrd",
    "multiboot": "Multiboot kernel",
    "state": "Saved state",
};

export function media_label(type)
{
    return MEDIA_LABELS[type] || type;
}

// large media is streamed with range requests, small media downloaded up front
const ASYNC_BY_DEFAULT = new Set(["cdrom", "hda", "hdb"]);

const BOOT_DEVICES = { "fd": 1, "floppy": 1, "hd": 2, "disk": 2, "cd": 3, "cdrom": 3 };
const BOOT_DEVICE_NAMES = { 1: "Floppy", 2: "Hard Disk", 3: "Optical" };

/**
 * "cd,hd,fd" or a number (as used by the boot order setting, e.g. 0x123) -> number
 * @return {number}
 */
export function parse_boot_order(value)
{
    if(typeof value === "number") return value;
    if(typeof value !== "string" || !value) return 0;
    if(/^(0x)?[0-9a-f]+$/i.test(value)) return parseInt(value, 16);

    let order = 0;
    let shift = 0;
    for(const name of value.split(/[\s,>/]+/))
    {
        const device = BOOT_DEVICES[name.toLowerCase()];
        if(device)
        {
            order |= device << shift;
            shift += 4;
        }
    }
    return order;
}

/** @return {string} */
export function describe_boot_order(order)
{
    if(!order) return "Auto";
    const names = [];
    for(let n = order; n; n >>>= 4)
    {
        names.push(BOOT_DEVICE_NAMES[n & 15] || "?");
    }
    return names.join(", ");
}

/** @return {string} */
export function format_bytes(bytes)
{
    if(!(bytes >= 0)) return "?";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0;
    while(bytes >= 1024 && i < units.length - 1)
    {
        bytes /= 1024;
        i++;
    }
    return (i === 0 ? String(bytes) : bytes.toFixed(bytes < 10 ? 2 : 1)) + " " + units[i];
}

/** @return {boolean} */
function is_absolute_url(url)
{
    return /^([a-z][a-z0-9+.-]*:|\/)/i.test(url);
}

/**
 * @param {string} url
 * @param {string} base
 * @return {string}
 */
export function resolve_url(url, base)
{
    if(is_absolute_url(url) || !base) return url;
    return new URL(url, new URL(base, location.href)).href;
}

/**
 * Validate a parsed profile, returning a list of problems (empty if it's usable)
 * @return {!Array<string>}
 */
export function validate_profile(p)
{
    const errors = [];
    if(!p || typeof p !== "object" || Array.isArray(p))
    {
        return ["not a JSON object"];
    }
    if(typeof p["id"] !== "string" || !/^[a-zA-Z0-9._-]+$/.test(p["id"]))
    {
        errors.push("\"id\" must be a string of letters, digits, '.', '_' or '-'");
    }
    if(typeof p["name"] !== "string" || !p["name"])
    {
        errors.push("\"name\" must be a non-empty string");
    }
    const media = p["media"];
    if(!media || typeof media !== "object")
    {
        errors.push("\"media\" must be an object (e.g. { \"cdrom\": \"distro.iso\" })");
    }
    else
    {
        let any = false;
        for(const type of Object.keys(/** @type {!Object} */ (media)))
        {
            if(!MEDIA_TYPES.includes(type))
            {
                errors.push(`unknown media type "${type}" (expected one of ${MEDIA_TYPES.join(", ")})`);
                continue;
            }
            const m = media[type];
            const url = typeof m === "string" ? m : m && m["url"];
            if(typeof url !== "string" || !url)
            {
                errors.push(`media.${type} needs a url`);
            }
            any = true;
        }
        if(!any && !(p["filesystem"] && p["filesystem"]["baseurl"]))
        {
            errors.push("no boot media given");
        }
    }
    const machine = p["machine"];
    if(machine !== undefined && (typeof machine !== "object" || !machine))
    {
        errors.push("\"machine\" must be an object");
    }
    else if(machine)
    {
        if(machine["memory_mb"] !== undefined && !(machine["memory_mb"] >= 16))
        {
            errors.push("machine.memory_mb must be a number >= 16");
        }
        if(machine["vram_mb"] !== undefined && !(machine["vram_mb"] >= 1))
        {
            errors.push("machine.vram_mb must be a number >= 1");
        }
    }
    return errors;
}

/**
 * Parse profile JSON text, throwing an Error with a readable message on failure
 */
export function parse_profile_text(text)
{
    let p;
    try
    {
        p = JSON.parse(text);
    }
    catch(e)
    {
        throw new Error("Invalid JSON: " + e.message);
    }
    const errors = validate_profile(p);
    if(errors.length)
    {
        throw new Error("Invalid machine profile:\n  - " + errors.join("\n  - "));
    }
    return p;
}

/**
 * The media of a profile with urls resolved: [{ type, url, size, async, ... }]
 * @param {string} image_base
 * @return {!Array<!Object>}
 */
export function profile_media(p, image_base)
{
    const result = [];
    const media = p["media"] || {};
    const base = p["image_base"] ? resolve_url(p["image_base"], image_base) : image_base;
    for(const type of MEDIA_TYPES)
    {
        let m = media[type];
        if(!m) continue;
        if(typeof m === "string") m = { "url": m };
        result.push({
            type,
            url: resolve_url(m["url"], base),
            size: typeof m["size"] === "number" ? m["size"] : undefined,
            async: typeof m["async"] === "boolean" ? m["async"] : ASYNC_BY_DEFAULT.has(type),
            fixed_chunk_size: m["fixed_chunk_size"],
            use_parts: !!m["use_parts"],
        });
    }
    return result;
}

/**
 * "{host}" in a relay url stands for the host serving this page, so that a profile can use
 * the wisp proxy of tools/serve.mjs (wisp://{host}/wisp/); wisp:// becomes wisps:// on https
 * @param {string} url
 * @return {string}
 */
export function expand_relay_url(url)
{
    if(!url.includes("{host}")) return url;
    url = url.replace("{host}", location.host);
    if(location.protocol === "https:") url = url.replace(/^wisp:/, "wisps:").replace(/^ws:/, "wss:");
    return url;
}

/**
 * Convert a profile into the object consumed by start_emulation
 * @param {string} image_base
 */
export function normalize_profile(p, image_base)
{
    const machine = p["machine"] || {};
    const profile = {};

    profile.id = p["id"];
    profile.name = p["name"];
    profile.homepage = p["homepage"];

    for(const m of profile_media(p, image_base))
    {
        const image = { url: m.url, async: m.async };
        if(m.size !== undefined) image.size = m.size;
        if(m.fixed_chunk_size) image.fixed_chunk_size = m.fixed_chunk_size;
        if(m.use_parts) image.use_parts = true;
        switch(m.type)
        {
            case "cdrom": profile.cdrom = image; break;
            case "hda": profile.hda = image; break;
            case "hdb": profile.hdb = image; break;
            case "fda": profile.fda = image; break;
            case "fdb": profile.fdb = image; break;
            case "bzimage": profile.bzimage = image; break;
            case "initrd": profile.initrd = image; break;
            case "multiboot": profile.multiboot = image; break;
            case "state": profile.state = image; break;
        }
    }

    if(typeof p["cmdline"] === "string") profile.cmdline = p["cmdline"];

    const fs = p["filesystem"];
    if(fs && fs["baseurl"])
    {
        profile.filesystem = { baseurl: resolve_url(fs["baseurl"], image_base) };
        if(fs["basefs"]) profile.filesystem.basefs = { url: resolve_url(fs["basefs"], image_base) };
        profile.bzimage_initrd_from_filesystem = !!p["bzimage_initrd_from_filesystem"];
    }

    if(machine["memory_mb"]) profile.memory_size = machine["memory_mb"] * MB;
    if(machine["vram_mb"]) profile.vga_memory_size = machine["vram_mb"] * MB;
    if(typeof machine["acpi"] === "boolean") profile.acpi = machine["acpi"];
    if(machine["boot_order"]) profile.boot_order = parse_boot_order(machine["boot_order"]);
    if(machine["net_device_type"]) profile.net_device_type = machine["net_device_type"];
    if(typeof machine["relay_url"] === "string") profile.relay_url = expand_relay_url(machine["relay_url"]);
    if(machine["mtu"]) profile.mtu = machine["mtu"];
    if(machine["cpuid_level"]) profile.cpuid_level = machine["cpuid_level"];
    if(machine["virtio_gpu"]) profile.virtio_gpu = true;
    if(machine["disable_audio"]) profile.disable_audio = true;
    if(machine["mac_address_translation"]) profile.mac_address_translation = true;
    if(machine["floppy_drives"] === false)
    {
        // otherwise linux probes two empty drives and logs i/o errors
        profile.fdc = { fda: { drive_type: 0 }, fdb: { drive_type: 0 } };
    }

    const autotype = p["autotype"];
    if(autotype && typeof autotype["text"] === "string")
    {
        profile.autotype = { text: autotype["text"], delay: autotype["delay_ms"] || 3000 };
    }

    return profile;
}

function storage_get(key, fallback)
{
    try
    {
        const value = window.localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    }
    catch(e)
    {
        return fallback;
    }
}

function storage_set(key, value)
{
    try
    {
        window.localStorage.setItem(key, JSON.stringify(value));
    }
    catch(e)
    {
        console.warn("Could not save to localStorage", e);
    }
}

/** @return {!Array<!Object>} profiles the user imported */
export function load_imported()
{
    const list = storage_get(STORAGE_IMPORTED, []);
    return Array.isArray(list) ? list.filter(p => !validate_profile(p).length) : [];
}

export function save_imported(list)
{
    storage_set(STORAGE_IMPORTED, list);
}

/** id -> edited profile, for served machines whose settings were changed */
export function load_overrides()
{
    const overrides = storage_get(STORAGE_OVERRIDES, {});
    return overrides && typeof overrides === "object" ? overrides : {};
}

export function save_overrides(overrides)
{
    storage_set(STORAGE_OVERRIDES, overrides);
}

/**
 * Where the machine catalogue comes from: the urls in a <meta name="v86-catalogue"> tag (set by
 * a deployment, e.g. a static page using a separate image server; several separated by spaces
 * are tried in order), otherwise profiles/ next to this page
 * @return {!Array<string>}
 */
export function catalogue_urls()
{
    const meta = document.querySelector("meta[name=v86-catalogue]");
    const content = (meta && meta.getAttribute("content") || "").trim();
    const urls = content ? content.split(/\s+/) : [MANIFEST_URL];
    return urls.map(url => new URL(url, location.href).href);
}

/**
 * Fetch one catalogue: { image_base, profiles: [profile, ...], errors: [string, ...] }
 *
 * The catalogue lists profiles either as file names (relative to the catalogue) or inline as
 * objects, which is what the image server in server/ generates.
 * @param {string} manifest_url
 * @param {string|null} image_base_override
 */
async function load_one_catalogue(manifest_url, image_base_override)
{
    const response = await fetch(manifest_url, { cache: "no-cache" });
    if(!response.ok) throw new Error("HTTP " + response.status);
    const manifest = await response.json();

    const image_base = image_base_override || resolve_url(manifest["image_base"] || "../images/", manifest_url);
    const entries = Array.isArray(manifest["profiles"]) ? manifest["profiles"] : [];
    const errors = [];

    const profiles = await Promise.all(entries.map(async (entry, i) =>
    {
        const name = typeof entry === "string" ? entry : `profile #${i + 1}`;
        try
        {
            if(typeof entry !== "string")
            {
                return parse_profile_text(JSON.stringify(entry));
            }
            const response = await fetch(resolve_url(entry, manifest_url), { cache: "no-cache" });
            if(!response.ok) throw new Error("HTTP " + response.status);
            return parse_profile_text(await response.text());
        }
        catch(e)
        {
            errors.push(`${name}: ${e.message}`);
            return null;
        }
    }));

    return { image_base, profiles: profiles.filter(p => p), errors };
}

/**
 * Fetch the catalogue from the first source that is reachable and has machines
 * @param {string|null} image_base_override
 */
export async function load_catalogue(image_base_override)
{
    const failures = [];
    let result = null;
    for(const url of catalogue_urls())
    {
        try
        {
            result = await load_one_catalogue(url, image_base_override);
            if(result.profiles.length) return result;
            failures.push(`${url}: no machines ready`);
        }
        catch(e)
        {
            failures.push(`${url}: ${e.message}`);
        }
        console.info("catalogue unavailable, trying the next one:", failures[failures.length - 1]);
    }
    return {
        image_base: result ? result.image_base : image_base_override || "images/",
        profiles: [],
        errors: result ? result.errors.concat(failures) : failures,
    };
}

/**
 * HEAD a url: resolves to { ok, size } (size is undefined if unknown)
 * @param {string} url
 */
export async function probe_url(url)
{
    try
    {
        const response = await fetch(url, { method: "HEAD", cache: "no-cache" });
        const length = response.headers.get("Content-Length");
        return { ok: response.ok, size: length ? +length : undefined, status: response.status };
    }
    catch(e)
    {
        return { ok: false, size: undefined, status: 0 };
    }
}

/** @return {boolean} whether this browser can run the mem64 build (guest RAM > 3 GiB) */
export function supports_wasm_mem64()
{
    const bytes = new Uint8Array([
        0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00, // magic, version
        0x05, 0x05, 0x02, // memory section, 5 bytes, 2 memories
        0x00, 0x00, // 32-bit, min 0
        0x04, 0x00, // 64-bit, min 0
    ]);
    try
    {
        return WebAssembly.validate(bytes);
    }
    catch(e)
    {
        return false;
    }
}
