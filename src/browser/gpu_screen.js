/**
 * @fileoverview
 * Display adapter for the virtio-gpu device (src/virtio_gpu.js).
 *
 * WebGPU API objects are deliberately held as {*} because the closure
 * externs predate WebGPU (see window["Terminal"] in starter.js).
 */

// For Types Only
import { BusConnector } from "../bus.js";

const BLIT_SHADER = `
struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
    var pos = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
    var out: VOut;
    let p = pos[vi];
    out.pos = vec4f(p, 0., 1.);
    out.uv = vec2f((p.x + 1.) * 0.5, (1. - p.y) * 0.5);
    return out;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

@fragment fn fs(in: VOut) -> @location(0) vec4f {
    let c = textureSample(tex, samp, in.uv);
    return vec4f(c.rgb, 1.0);
}
`;

// Virtio gpu formats: {1,2,3,4} are B,G,R,X/A byte order, {67,68,121,134}
// are R,G,B,X/A byte order (all 4 bytes per pixel).
function is_bgr_format(format)
{
    return format === 1 || format === 2 || format === 3 || format === 4;
}

/**
 * Presents virtio-gpu frames, overlaying a canvas on the VGA screen container.
 * Uses WebGPU when available, falls back to a plain 2D canvas.
 * Listens to the emulator bus for "virtio-gpu-set-scanout" and
 * "virtio-gpu-frame" messages.
 *
 * @constructor
 * @param {BusConnector} bus
 * @param {HTMLElement} container  The screen container (as passed to ScreenAdapter)
 */
export function GpuScreenAdapter(bus, container)
{
    /** @const @type {BusConnector} */
    this.bus = bus;

    const canvas = document.createElement("canvas");
    canvas.style.display = "none";
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.imageRendering = "pixelated";
    if(!container.style.position)
    {
        container.style.position = "relative";
    }
    container.appendChild(canvas);

    this.canvas = canvas;
    this.active = false;

    // "uninitialized" -> "pending" -> "webgpu" | "2d"
    this.backend = "uninitialized";

    // WebGPU state (all untyped, see file header)
    this.gpu_device = undefined;
    this.gpu_context = undefined;
    this.gpu_pipeline = undefined;
    this.gpu_bindgroup_layout = undefined;
    this.gpu_texture = undefined;
    this.gpu_bindgroup = undefined;
    this.gpu_texture_format = "";
    this.texture_width = 0;
    this.texture_height = 0;

    this.ctx2d = null;

    // Frames arriving while WebGPU initialises asynchronously
    this.pending_frame = null;

    bus.register("virtio-gpu-set-scanout", function(scanout)
    {
        this.on_set_scanout(scanout);
    }, this);

    bus.register("virtio-gpu-frame", function(frame)
    {
        this.on_frame(frame);
    }, this);
}

GpuScreenAdapter.prototype.on_set_scanout = function(scanout)
{
    if(scanout.enabled)
    {
        this.active = true;
        this.canvas.style.display = "";
        if(this.canvas.width !== scanout.width || this.canvas.height !== scanout.height)
        {
            this.canvas.width = scanout.width;
            this.canvas.height = scanout.height;
            this.destroy_texture();
        }
        this.ensure_backend();
    }
    else
    {
        this.active = false;
        this.canvas.style.display = "none";
    }
};

GpuScreenAdapter.prototype.on_frame = function(frame)
{
    if(!this.active)
    {
        return;
    }

    this.ensure_backend();

    if(this.backend === "pending" || this.backend === "uninitialized")
    {
        // Keep only the most recent frame
        this.pending_frame = frame;
        return;
    }

    this.present(frame);
};

GpuScreenAdapter.prototype.ensure_backend = function()
{
    if(this.backend !== "uninitialized")
    {
        return;
    }

    const nav_gpu = typeof navigator !== "undefined" && navigator["gpu"];
    if(nav_gpu)
    {
        this.backend = "pending";
        this.init_webgpu(nav_gpu).then(ok =>
        {
            this.backend = ok ? "webgpu" : "2d";
            console.log("virtio-gpu: using " + (ok ? "WebGPU" : "2d canvas") + " backend");
            if(this.pending_frame)
            {
                const frame = this.pending_frame;
                this.pending_frame = null;
                this.present(frame);
            }
        }).catch(err =>
        {
            console.warn("virtio-gpu: WebGPU init failed, using 2d canvas fallback", err);
            this.backend = "2d";
            if(this.pending_frame)
            {
                const frame = this.pending_frame;
                this.pending_frame = null;
                this.present(frame);
            }
        });
    }
    else
    {
        this.backend = "2d";
    }
};

/**
 * @return {Promise<boolean>} true if WebGPU is usable
 */
GpuScreenAdapter.prototype.init_webgpu = async function(nav_gpu)
{
    const adapter = await nav_gpu["requestAdapter"]();
    if(!adapter)
    {
        return false;
    }
    const device = await adapter["requestDevice"]();
    if(!device)
    {
        return false;
    }

    const context = this.canvas.getContext("webgpu");
    if(!context)
    {
        return false;
    }

    const canvas_format = nav_gpu["getPreferredCanvasFormat"]();
    context.configure({
        device: device,
        format: canvas_format,
        alphaMode: "opaque",
    });

    const shader = device.createShaderModule({ code: BLIT_SHADER });

    this.gpu_bindgroup_layout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: 2, // FRAGMENT
                sampler: { type: "filtering" },
            },
            {
                binding: 1,
                visibility: 2, // FRAGMENT
                texture: { sampleType: "float" },
            },
        ],
    });

    this.gpu_pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.gpu_bindgroup_layout] }),
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fs", targets: [{ format: canvas_format }] },
        primitive: { topology: "triangle-list" },
    });

    this.gpu_device = device;
    this.gpu_context = context;

    device.lost.then(info =>
    {
        console.warn("virtio-gpu: WebGPU device lost: " + info.message);
        this.backend = "2d";
        this.gpu_device = undefined;
    });

    return true;
};

GpuScreenAdapter.prototype.destroy_texture = function()
{
    if(this.gpu_texture)
    {
        this.gpu_texture.destroy();
        this.gpu_texture = undefined;
        this.gpu_bindgroup = undefined;
    }
};

/**
 * @param {*} format The WebGPU texture format matching the frame data
 */
GpuScreenAdapter.prototype.ensure_texture = function(format)
{
    if(this.gpu_texture &&
        this.gpu_texture_format === format &&
        this.texture_width === this.canvas.width &&
        this.texture_height === this.canvas.height)
    {
        return;
    }

    this.destroy_texture();

    this.gpu_texture = this.gpu_device.createTexture({
        size: { width: this.canvas.width, height: this.canvas.height },
        format: format,
        usage: 0x04 | 0x02 | 0x10, // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT
    });
    this.gpu_texture_format = format;
    this.texture_width = this.canvas.width;
    this.texture_height = this.canvas.height;

    const sampler = this.gpu_device.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
    });

    this.gpu_bindgroup = this.gpu_device.createBindGroup({
        layout: this.gpu_bindgroup_layout,
        entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: this.gpu_texture.createView() },
        ],
    });
};

/**
 * @param {{x: number, y: number, width: number, height: number, format: number, pixels: Uint8Array}} frame
 */
GpuScreenAdapter.prototype.present = function(frame)
{
    if(this.backend === "webgpu")
    {
        this.present_webgpu(frame);
    }
    else
    {
        this.present_2d(frame);
    }
};

/**
 * @param {{x: number, y: number, width: number, height: number, format: number, pixels: Uint8Array}} frame
 */
GpuScreenAdapter.prototype.present_webgpu = function(frame)
{
    const format = is_bgr_format(frame.format) ? "bgra8unorm" : "rgba8unorm";
    this.ensure_texture(format);

    // Guest pixels map 1:1 onto the canvas-resolution texture; subrect
    // uploads via the writeTexture destination origin.
    this.gpu_device.queue.writeTexture(
        { texture: this.gpu_texture, origin: { x: frame.x, y: frame.y, z: 0 } },
        frame.pixels,
        { bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
        { width: frame.width, height: frame.height, depthOrArrayLayers: 1 });

    const encoder = this.gpu_device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
        colorAttachments: [{
            view: this.gpu_context.getCurrentTexture().createView(),
            loadOp: "clear",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            storeOp: "store",
        }],
    });
    pass.setPipeline(this.gpu_pipeline);
    pass.setBindGroup(0, this.gpu_bindgroup);
    pass.draw(3);
    pass.end();
    this.gpu_device.queue.submit([encoder.finish()]);
};

/**
 * @param {{x: number, y: number, width: number, height: number, format: number, pixels: Uint8Array}} frame
 */
GpuScreenAdapter.prototype.present_2d = function(frame)
{
    if(!this.ctx2d)
    {
        this.ctx2d = this.canvas.getContext("2d", { alpha: false });
    }

    const w = frame.width;
    const h = frame.height;
    const src = frame.pixels;
    const img = this.ctx2d.createImageData(w, h);
    const dst = img.data;

    if(is_bgr_format(frame.format))
    {
        for(let i = 0, n = w * h * 4; i < n; i += 4)
        {
            dst[i] = src[i + 2];
            dst[i + 1] = src[i + 1];
            dst[i + 2] = src[i];
            dst[i + 3] = 255;
        }
    }
    else
    {
        dst.set(src.subarray(0, w * h * 4));
        for(let i = 3, n = w * h * 4; i < n; i += 4)
        {
            dst[i] = 255;
        }
    }

    this.ctx2d.putImageData(img, frame.x, frame.y);
};
