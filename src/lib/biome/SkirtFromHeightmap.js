// biome/SkirtFromHeightmap.js
import {
    CircleEase,
    Color3,
    CubicEase,
    EasingFunction,
    EffectRenderer,
    EffectWrapper,
    Engine,
    ExponentialEase,
    Matrix,
    Mesh,
    MeshBuilder,
    PBRMaterial,
    PowerEase,
    QuadraticEase,
    QuarticEase,
    QuinticEase,
    RawTexture,
    RenderTargetTexture,
    Scalar,
    ShaderMaterial,
    SineEase,
    StandardMaterial,
    Texture,
    Vector2,
    Vector3,
    VertexBuffer,
    VertexData,
} from "@babylonjs/core";

const IDENTITY = Matrix.Identity();
export class SkirtForHeightmap {
    constructor(texture, scene, { debug = false, cache, cache_prefix } = {}) {
        this.options = { debug };
        this.heightmap_texture = texture;
        this.scene = scene;
        this.camera = scene.activeCamera;

        this.cache = cache;
        this.cache_prefix = cache_prefix;
    }

    async initialize(texture) {
        let scene = this.scene;

        this.hexMesh = setupHexMesh(scene, this.camera, this);
        const srcTex = texture || this.heightmap_texture;

        await this.runJFA(scene, srcTex, {
            pad: 1.35,
            heightMultiplier: 15.0,
            targetMesh: this.hexMesh,
        });

        this.initialized = true;
        await this.postUpdate();
        return this.hexMesh;
    }

    async update(texture) {
        const tex = texture || registerOrReuseResource(
            this.scene,
            "source_island_heightmap",
            () => null,
        );

        await this.runJFA(this.scene, tex, {
            pad: 1.35,
            heightMultiplier: 15.0,
            targetMesh: this.hexMesh,
        });
        await this.postUpdate();
        return this.hexMesh;
    }

    async postUpdate() {
        // ----------------------------------------------------------
        // CACHE FINAL MESH (positions, normals, uvs, indices only)
        // ----------------------------------------------------------
        const mesh = registerOrReuseResource(
            this.scene,
            "island",
            () => {
                let m = new Mesh("island", this.scene);
                return m;
            },
        );
        const cacheKey = `${this.cache_prefix}/final_mesh`;

        const saved = await this.cache.get(cacheKey);

        if (saved) {
            let restored = mesh;
            mesh.scaling.setAll(1);

            restored.setVerticesData(
                VertexBuffer.PositionKind,
                new Float32Array(saved.positions),
            );
            restored.setVerticesData(
                VertexBuffer.NormalKind,
                new Float32Array(saved.normals),
            );
            if (saved.uvs) {
                restored.setVerticesData(
                    VertexBuffer.UVKind,
                    new Float32Array(saved.uvs),
                );
            }
            restored.setIndices(new Uint32Array(saved.indices));

            this.final_mesh = restored;
        } else {
            // Use generated mesh then cache it
            this.final_mesh = mesh;

            const data = {
                positions: Array.from(
                    mesh.getVerticesData(VertexBuffer.PositionKind),
                ),
                normals: Array.from(
                    mesh.getVerticesData(VertexBuffer.NormalKind),
                ),
                uvs: mesh.getVerticesData(VertexBuffer.UVKind)
                    ? Array.from(
                        mesh.getVerticesData(VertexBuffer.UVKind),
                    )
                    : null,
                indices: Array.from(mesh.getIndices()),
            };

            await this.cache.set(cacheKey, data);
        }

        // Now apply PBR (possibly cached textures below)

        await applyProceduralPBR(this.final_mesh, this.scene, {
            useTextureBake: true,
            cache: this.cache,
            cache_prefix: `${this.cache_prefix}/skirt_for_heightmap`,
        });
        mesh.scaling.set(15, 12, 15);
        return mesh;
    }

    async runJFA(scene, heightmapTex, config = {}) {
        return new Promise(async (resolve) => {
            const padCfg = config.pad ?? 1.0;
            const heightMultiplier = config.heightMultiplier ?? 5.0;

            // Make readable copy of original heightmap
            this.originalReadable = await this.cache.ensure(
                `${this.cache_prefix}/originalReadable`,
                async () => {
                    const rt = makeReadableCopy(scene, heightmapTex);
                    const arr = await rt.readPixels();
                    return Array.from(arr); // serialize to JSON-safe
                },
            ).then((value) => {
                // Rehydrate buffer into a CPU-texture-equivalent
                const arr = new Uint8Array(value);
                const tex = RawTexture.CreateRGBATexture(
                    arr,
                    heightmapTex.getSize().width,
                    heightmapTex.getSize().height,
                    scene,
                    false,
                );
                return tex;
            });

            // Apply padding
            this.paddedOriginal = makePaddedTexture(
                scene,
                this.originalReadable,
                padCfg,
            );
            this.paddedTex = makePaddedTexture(scene, heightmapTex, padCfg);

            // --- NEW UNIFORM PADDING LOGIC -----------------------------------------
            const origSize = heightmapTex.getSize().width;
            const paddedSize = this.paddedTex.getSize().width;

            // shrink factor in [0..1]
            const padShrink = origSize / paddedSize;
            const padScale = 1.0 / padShrink;
            // ------------------------------------------------------------------------

            const size = this.paddedTex.getSize();
            const W = size.width;
            const H = size.height;

            const maxDim = Math.max(W, H);
            const steps = Math.ceil(Math.log2(maxDim));

            const stageRTs = [];

            // SEED
            const seedRT = makeNearestRT(scene, "seedRT", W, H);
            seedPass(scene, this.paddedTex, seedRT);
            stageRTs.push(seedRT);

            // Preview the seed
            let startX = -12;
            let dx = 6;
            if (this.options.debug) {
                addPreviewPlane(scene, seedRT, startX + dx * 1, 6, "Seed");
            }

            // JFA LOOP
            let jump = Math.pow(2, steps - 1);

            // Keep reference to target mesh
            const targetMesh = config.targetMesh;
            targetMesh.scaling.setAll(1);
            const doStep = (i) => {
                return new Promise((stepResolve) => {
                    const inputRT = stageRTs[i];
                    const outputRT = makeNearestRT(
                        scene,
                        `sampleRT_${i}`,
                        W,
                        H,
                    );
                    const isLast = i === steps - 1;

                    jfaStep(scene, inputRT, outputRT, jump, async () => {
                        // Last step → composite heightmap
                        if (isLast) {
                            if (this.options.debug) {
                                addDistancePlane(scene, outputRT, 0, -6);
                            }

                            await buildCompositeHeightmap(
                                scene,
                                outputRT,
                                this.paddedOriginal,
                                heightMultiplier,
                                targetMesh,
                                padScale,
                            );

                            // ALL DONE
                            stepResolve();
                            return;
                        }

                        // Not last step → continue
                        stepResolve();
                    });

                    stageRTs.push(outputRT);

                    if (this.options.debug) {
                        addPreviewPlane(
                            scene,
                            outputRT,
                            startX + dx * (i + 2),
                            6,
                            "Step_" + jump,
                        );
                    }

                    jump /= 2;
                });
            };

            // Chain all steps sequentially
            (async () => {
                for (let i = 0; i < steps; i++) {
                    await doStep(i);
                }
                resolve(targetMesh);
            })();
        }); // end Promise
    }
}

let heightmapStrength = 2.5;
let circleRadius = 50;
let hexRadius = 0.5;
const RESOURCES_CACHE = {};
function registerOrReuseResource(
    scene,
    name,
    init,
    { clear = false, replace = false } = {},
) {
    const engine = scene.getEngine();
    let res = RESOURCES_CACHE[name];

    // --- NEW: Allow forced replacement ---
    if (replace && res) {
        if (typeof res.dispose === "function") {
            res.dispose();
        }
        res = null;
        delete RESOURCES_CACHE[name];
    }

    // Create if missing
    if (!res) {
        res = init();
        RESOURCES_CACHE[name] = res;
    }

    // Clear if requested
    if (clear && res && res._bindFrameBuffer) {
        scene.onBeforeRenderObservable.addOnce(() => {
            res._bindFrameBuffer();
            engine.clear(res.clearColor || scene.clearColor, true, true, true);
            engine.restoreDefaultFramebuffer();
        });
    }

    return res;
}

// ============================================================================
//  MAKE ORIGINAL HEIGHTMAP CPU-READABLE
// ============================================================================
function makeReadableCopy(scene, srcTex) {
    const engine = scene.getEngine();
    const size = srcTex.getSize();

    const rt = registerOrReuseResource(
        scene,
        "origReadableRT",
        () =>
            new RenderTargetTexture(
                "origReadableRT",
                { width: size.width, height: size.height },
                scene,
                {
                    generateMipMaps: false,
                    generateDepthBuffer: false,
                    generateStencilBuffer: false,
                    samplingMode: Texture.NEAREST_NEAREST,
                },
            ),
        { clear: true },
    );

    const fx = new EffectRenderer(engine);

    const frag = `
        precision highp float;
        varying vec2 vUV;
        uniform sampler2D tex;
        void main(){
            gl_FragColor = texture2D(tex, vUV);
        }
    `;

    const wrap = new EffectWrapper({
        engine,
        fragmentShader: frag,
        samplerNames: ["tex"],
    });

    wrap.effect.executeWhenCompiled(() => {
        wrap.effect.setTexture("tex", srcTex);
        fx.render(wrap, rt);
    });

    return rt;
}

// ============================================================================
//  NEAREST-SAMPLING RENDER TARGET
// ============================================================================
function makeNearestRT(scene, name, W, H) {
    const rt = registerOrReuseResource(
        scene,
        name,
        () =>
            new RenderTargetTexture(
                name,
                { width: W, height: H },
                scene,
                {
                    generateDepthBuffer: false,
                    generateStencilBuffer: false,
                    generateMipMaps: false,
                    samplingMode: Texture.NEAREST_NEAREST,
                },
            ),
        { clear: true },
    );
    rt.wrapU = rt.wrapV = Texture.CLAMP_ADDRESSMODE;
    return rt;
}

// ============================================================================
//  PAD TEXTURE
// ============================================================================
function makePaddedTexture(scene, srcTex, padCfg) {
    const engine = scene.getEngine();
    const srcSize = srcTex.getSize();
    const W = srcSize.width;
    const H = srcSize.height;

    let padX = 1.0, padY = 1.0;

    if (typeof padCfg === "number") {
        padX = padY = Math.max(1.0, padCfg);
    } else if (typeof padCfg === "object") {
        padX = Math.max(1.0, padCfg.x ?? 1.0);
        padY = Math.max(1.0, padCfg.y ?? 1.0);
    }

    if (padX === 1 && padY === 1) {
        return srcTex;
    }

    const newW = Math.floor(W * padX);
    const newH = Math.floor(H * padY);

    const paddedRT = makeNearestRT(scene, "padded", newW, newH);
    const fx = new EffectRenderer(engine);

    const frag = `
        precision highp float;
        varying vec2 vUV;
        uniform sampler2D src;
        uniform vec2 srcSize;
        uniform vec2 dstSize;

        void main(){
            vec4 invalid = vec4(0.0, 0.0, 0.0, 0.0);

            vec2 dstPx = vUV * dstSize;
            vec2 padding = (dstSize - srcSize) * 0.5;
            vec2 srcPx = dstPx - padding;

            if (srcPx.x < 0.0 || srcPx.y < 0.0 ||
                srcPx.x >= srcSize.x || srcPx.y >= srcSize.y) {
                gl_FragColor = invalid;
                return;
            }

            gl_FragColor = texture2D(src, srcPx / srcSize);
        }
    `;

    const wrap = new EffectWrapper({
        engine,
        fragmentShader: frag,
        samplerNames: ["src"],
        uniformNames: ["srcSize", "dstSize"],
    });

    wrap.effect.executeWhenCompiled(() => {
        wrap.effect.setTexture("src", srcTex);
        wrap.effect.setVector2("srcSize", new Vector2(W, H));
        wrap.effect.setVector2("dstSize", new Vector2(newW, newH));
        fx.render(wrap, paddedRT);
    });

    return paddedRT;
}

// ============================================================================
//  SEED PASS
// ============================================================================
function seedPass(scene, heightmapTex, outRT) {
    const engine = scene.getEngine();
    const fx = new EffectRenderer(engine);

    const frag = `
precision highp float;
varying vec2 vUV;
uniform sampler2D tex;

void main() {
    float h = texture2D(tex, vUV).r;
    // Sentinel far outside [0,1] so it can never be a real UV
    vec2 INVALID = vec2(-1e9);

    if (h < 0.001) {
        // OUTSIDE pixel:
        //  - ext.xy   = vUV
        //  - intr.xy  = INVALID (no inside root here)
        gl_FragColor = vec4(
            vUV,       // R,G = ext.xy
            INVALID    // B,A = intr.xy
        );
    } else {
        // INSIDE pixel:
        //  - ext.xy   = INVALID
        //  - intr.xy  = vUV
        gl_FragColor = vec4(
            INVALID,   // R,G = ext.xy
            vUV        // B,A = intr.xy
        );
    }
}
`;

    const wrap = new EffectWrapper({
        engine,
        fragmentShader: frag,
        samplerNames: ["tex"],
    });

    wrap.effect.executeWhenCompiled(() => {
        wrap.effect.setTexture("tex", heightmapTex);
        fx.render(wrap, outRT);
    });
}

// ============================================================================
//  JFA STEP
// ============================================================================
function jfaStep(scene, inRT, outRT, jump, onDone) {
    const engine = scene.getEngine();
    const fx = new EffectRenderer(engine);

    const frag = `
precision highp float;
varying vec2 vUV;

uniform sampler2D tex;
uniform float jump;
uniform vec2 res;

float D(vec2 a, vec2 b){ return length(a - b); }

// A root is valid if it is NOT our huge negative sentinel
bool valid(vec2 r){
    return r.x > -1e8 && r.y > -1e8;
}

void main() {
    vec4 root = texture2D(tex, vUV);

    // Decode roots
    vec2 ext  = root.xy; // outside root
    vec2 intr = root.zw; // inside root

    float extD = valid(ext)  ? D(vUV, ext)  : 1e6;
    float intD = valid(intr) ? D(vUV, intr) : 1e6;

    // Look at neighbors
    for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
            vec2 off = vec2(float(i), float(j)) * (jump / res);
            vec2 uv2 = vUV + off;
            if (uv2.x < 0.0 || uv2.y < 0.0 || uv2.x > 1.0 || uv2.y > 1.0)
                continue;

            vec4 r2 = texture2D(tex, uv2);
            vec2 ext2  = r2.xy;
            vec2 intr2 = r2.zw;

            if (valid(ext2)) {
                float d = D(vUV, ext2);
                if (d < extD) {
                    extD = d;
                    ext  = ext2;
                }
            }

            if (valid(intr2)) {
                float d = D(vUV, intr2);
                if (d < intD) {
                    intD = d;
                    intr = intr2;
                }
            }
        }
    }

    // Write back both roots:
    // R,G = ext.xy
    // B,A = intr.xy
    gl_FragColor = vec4(ext, intr);
}
`;

    const wrap = new EffectWrapper({
        engine,
        fragmentShader: frag,
        samplerNames: ["tex"],
        uniformNames: ["jump", "res"],
    });

    const sz = inRT.getSize();

    wrap.effect.executeWhenCompiled(() => {
        wrap.effect.setTexture("tex", inRT);
        wrap.effect.setFloat("jump", jump);
        wrap.effect.setVector2("res", new Vector2(sz.width, sz.height));
        fx.render(wrap, outRT);

        if (onDone) onDone();
    });
}

async function buildCompositeHeightmap(
    scene,
    finalRT,
    originalRT,
    heightMultiplier,
    targetMesh,
    padScale = 1.0, // NEW
) {
    const size = finalRT.getSize();
    const W = size.width;
    const H = size.height;

    const sdfPixels = await finalRT.readPixels();
    const origPixels = await originalRT.readPixels();

    if (!sdfPixels || !origPixels) {
        console.error("Missing pixels for composite terrain.");
        return;
    }

    const isByte = sdfPixels instanceof Uint8Array ||
        sdfPixels instanceof Uint8ClampedArray;
    const composite = new Float32Array(W * H);

    // config
    const isoSamples = 50;
    const isoStep = 0.015;
    const falloffSharpness = .1;
    const blendWidth = 0.02;

    let idx = 0;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const valid = (v) => v.x > -1e8 && v.y > -1e8;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;

            let hOrig = origPixels[i] / 255.0;
            if (hOrig < 0.0) hOrig = 0.0; // clean padded border

            let r = sdfPixels[i + 0];
            let g = sdfPixels[i + 1];
            let b = sdfPixels[i + 2];
            let a = sdfPixels[i + 3];

            if (isByte) {
                r /= 255;
                g /= 255;
                b /= 255;
                a /= 255;
            }

            const uv = { x: x / (W - 1), y: y / (H - 1) };
            const ext = { x: r, y: g };
            const intr = { x: b, y: a };

            let extD = valid(ext) ? dist(uv, ext) : 1e6;
            let intD = valid(intr) ? dist(uv, intr) : 1e6;

            const sdf = extD - intD;

            // OUTSIDE height
            let acc = 0;
            for (let k = 0; k < isoSamples; k++) {
                const iso = k * isoStep;
                const shifted = sdf - iso;
                const falloff = 1.0 -
                    Math.exp(-falloffSharpness * Math.abs(shifted));
                acc += shifted * falloff;
            }
            const outsideHeight = (acc / isoSamples) * heightMultiplier;

            // blend
            const blend = Scalar.Clamp(
                (sdf / blendWidth + 1) * 0.5,
                0,
                1,
            );

            composite[idx++] = hOrig * blend +
                outsideHeight * (1.0 - blend);
        }
    }

    // Store composite + NEW padScale
    scene.compositeHeightmap = {
        width: W,
        height: H,
        data: composite,
        padScale, // NEW
        scale: 1,
        // bilinear sample
        sampleUV(u, v) {
            u = Scalar.Clamp(u, 0, 1);
            v = Scalar.Clamp(v, 0, 1);

            const x = u * (W - 1);
            const y = v * (H - 1);
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);
            const x1 = Math.min(x0 + 1, W - 1);
            const y1 = Math.min(y0 + 1, H - 1);

            const fx = x - x0;
            const fy = y - y0;

            const i00 = composite[y0 * W + x0];
            const i10 = composite[y0 * W + x1];
            const i01 = composite[y1 * W + x0];
            const i11 = composite[y1 * W + x1];

            const ix0 = Scalar.Lerp(i00, i10, fx);
            const ix1 = Scalar.Lerp(i01, i11, fx);
            return Scalar.Lerp(ix0, ix1, fy);
        },

        // NEW world→UV mapping using shrink-factor
        sampleWorld(pos) {
            const u = Scalar.InverseLerp(
                this.worldBounds.minX,
                this.worldBounds.maxX,
                pos.x,
            );
            const v = Scalar.InverseLerp(
                this.worldBounds.minZ,
                this.worldBounds.maxZ,
                pos.z,
            );

            return this.sampleUV(u, v);
        },
    };

    if (targetMesh) {
        applyHeightmapToMesh(targetMesh, { strength: heightmapStrength });
    }

    console.log("Composite heightmap ready:", scene.compositeHeightmap);
    // =====================================================================
    //  REPRODUCE ORIGINAL HARDCODED EXAMPLE USING applyHeightmapToMesh
    // =====================================================================
    // Only create once
    if (!scene._defaultCompositeGround) {
        // This matches the original example:
        // width: 20, height: 20, subdivisions from texture size, positioned at (0, -5, 12)
        const ground = targetMesh || MeshBuilder.CreateGround(
            "compositeGround",
            {
                width: 20,
                height: 20,
                subdivisionsX: W - 1,
                subdivisionsY: H - 1,
                updatable: true,
            },
            scene,
        );

        ground.bakeCurrentTransformIntoVertices();
        ground.computeWorldMatrix(true);

        // Apply the composite heightmap additively.
        // `composite` already includes heightMultiplier, so strength = 1 reproduces original look.
        applyHeightmapToMesh(ground, {
            strength: heightmapStrength,
            // auto mapping (Option 3) will use the ground's bounding box,
            // which matches the original width/height of 20x20.
        });

        // Match original transform & material
        // ground.position = new Vector3(0, -5, 12);

        const mat = new StandardMaterial("compGroundMat", scene);
        mat.diffuseColor = new Color3(0.70, 1.0, 0.85);
        mat.specularColor = Color3.Black();
        ground.material = mat;

        scene._defaultCompositeGround = ground;
    }
}

// --- NEW: helper to warp + reapply heightmap when sliders change ---

// ============================================================================
//  APPLY HEIGHTMAP TO ANY MESH (OPTION 3 WITH OPTION 2 OVERRIDE)
// ============================================================================
export function applyHeightmapToMesh(mesh, options = {}) {
    const scene = mesh.getScene();
    const H = scene.compositeHeightmap;

    if (!H) {
        console.error("Composite heightmap not ready yet.");
        return;
    }

    H.worldBounds = {
        minX: -10, // or extract from terrain placement
        maxX: 10,
        minZ: -10,
        maxZ: 10,
    };

    const strength = options.strength ?? 1.0;

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) return;

    const world = IDENTITY;
    let minX = +Infinity, maxX = -Infinity;
    let minZ = +Infinity, maxZ = -Infinity;

    // Compute world-space bounding box
    for (let i = 0; i < positions.length; i += 3) {
        const wp = Vector3.TransformCoordinates(
            new Vector3(
                positions[i],
                positions[i + 1],
                positions[i + 2],
            ),
            world,
        );
        if (wp.x < minX) minX = wp.x;
        if (wp.x > maxX) maxX = wp.x;
        if (wp.z < minZ) minZ = wp.z;
        if (wp.z > maxZ) maxZ = wp.z;
    }

    const center = new Vector3(
        (minX + maxX) * 0.5,
        0,
        (minZ + maxZ) * 0.5,
    );
    const size = new Vector3(maxX - minX, 0, maxZ - minZ);

    // =========================================================
    // APPLY HEIGHT — always baseline Y = 0
    // =========================================================
    for (let i = 0; i < positions.length; i += 3) {
        // World position BEFORE modification
        const wp = Vector3.TransformCoordinates(
            new Vector3(
                positions[i],
                positions[i + 1],
                positions[i + 2],
            ),
            world,
        );

        // Sample heightmap
        const h = H.sampleWorld(wp, { center, size });

        // FORCE baseline Y = 0
        positions[i + 1] = h * strength;
    }

    mesh.setVerticesData(VertexBuffer.PositionKind, positions);

    // Recompute normals
    const indices = mesh.getIndices();
    const normals = [];
    VertexData.ComputeNormals(positions, indices, normals);
    mesh.setVerticesData(VertexBuffer.NormalKind, normals);
}

// ============================================================================
//  PREVIEW PLANES
// ============================================================================
function addPreviewPlane(scene, rt, x, y, label) {
    const plane = registerOrReuseResource(
        scene,
        "plane_" + label,
        () => MeshBuilder.CreatePlane("plane_" + label, { size: 5 }, scene),
    );
    plane.position.x = x;
    plane.position.y = y;

    const mat = registerOrReuseResource(
        scene,
        "prev_" + label,
        () =>
            new ShaderMaterial("prev_" + label, scene, {
                vertexSource: `
                precision highp float;
                attribute vec3 position;
                attribute vec2 uv;
                varying vec2 vUV;
                uniform mat4 worldViewProjection;
                void main(){
                    vUV = uv;
                    gl_Position = worldViewProjection * vec4(position,1.0);
                }
            `,
                fragmentSource: `
                precision highp float;
                varying vec2 vUV;
                uniform sampler2D tex;

                void main(){
                    vec4 r = texture2D(tex, vUV);
                    float d = length(r.xy - vUV);
                    gl_FragColor = vec4(d, d*0.2, 1.0-d, 1.0);
                }
            `,
            }, {
                attributes: ["position", "uv"],
                uniforms: ["worldViewProjection"],
                samplers: ["tex"],
            }),
    );

    mat.setTexture("tex", rt);
    plane.material = mat;
}

// ============================================================================
//  SIGNED DISTANCE VISUALIZER
// ============================================================================
function addDistancePlane(scene, rt, x, y) {
    const plane = registerOrReuseResource(
        scene,
        "distVis",
        () => MeshBuilder.CreatePlane("distVis", { size: 8 }, scene),
    );
    plane.position.x = x;
    plane.position.y = y;

    const mat = registerOrReuseResource(
        scene,
        "distVisMat",
        () =>
            new ShaderMaterial("distVisMat", scene, {
                vertexSource: `
                precision highp float;
                attribute vec3 position;
                attribute vec2 uv;
                varying vec2 vUV;
                uniform mat4 worldViewProjection;
                void main(){
                    vUV = uv;
                    gl_Position = worldViewProjection * vec4(position,1.0);
                }
            `,
                fragmentSource: `
precision highp float;

varying vec2 vUV;
uniform sampler2D tex;

float D(vec2 a, vec2 b){ return length(a - b); }
bool valid(vec2 r){ return r.x > -1e8 && r.y > -1e8; }

void main(){
    vec4 r = texture2D(tex, vUV);
    vec2 ext  = r.xy;
    vec2 intr = r.zw;

    float extD = valid(ext)  ? D(vUV, ext)  : 1e6;
    float intD = valid(intr) ? D(vUV, intr) : 1e6;

    float sdf = extD - intD;

    float S = sdf * 1024.0;
    float atten = 1.0 - exp(-6.0 * abs(S * 0.002));
    float bands = 0.8 + 0.2 * cos(S * 0.3);

    vec3 colOut = vec3(0.90, 0.60, 0.30);
    vec3 colIn  = vec3(0.65, 0.85, 1.00);

    vec3 base = (sdf > 0.0)? colOut: colIn;
    base *= atten * bands;

    float mixEdge = smoothstep(0.0, 3.0/1024.0, abs(sdf));
    vec3 finalColor = mix(vec3(1.0), base, mixEdge);

    gl_FragColor = vec4(finalColor,1.0);
}
`,
            }, {
                attributes: ["position", "uv"],
                uniforms: ["worldViewProjection"],
                samplers: ["tex"],
            }),
    );

    mat.setTexture("tex", rt);
    plane.material = mat;
    plane.position.y = -3;
}

function setupHexMesh(scene, camera, skirt) {
    // ====== Helpers ======
    function hexToCartesian(q, r, size) {
        const x = size * (Math.sqrt(3) * (q + r / 2));
        const y = size * (1.5 * r);
        return new Vector2(x, y);
    }

    // Clip polygon against circle
    function clipPolygonToCircle(points, radius) {
        const clipped = [];
        const len = points.length;

        function isInside(p) {
            return p.length() <= radius + 1e-7;
        }

        function intersect(p1, p2) {
            const d = p2.subtract(p1);
            const a = d.x * d.x + d.y * d.y;
            const b = 2 * (p1.x * d.x + p1.y * d.y);
            const c = p1.x * p1.x + p1.y * p1.y - radius * radius;
            const disc = b * b - 4 * a * c;
            if (disc < 0) return null;
            const sqrtDisc = Math.sqrt(disc);
            const t1 = (-b - sqrtDisc) / (2 * a);
            const t2 = (-b + sqrtDisc) / (2 * a);
            const hits = [];
            if (t1 >= 0 && t1 <= 1) hits.push(p1.add(d.scale(t1)));
            if (t2 >= 0 && t2 <= 1) hits.push(p1.add(d.scale(t2)));
            return hits;
        }

        for (let i = 0; i < len; i++) {
            const p1 = points[i];
            const p2 = points[(i + 1) % len];
            const inside1 = isInside(p1);
            const inside2 = isInside(p2);

            if (inside1 && inside2) {
                clipped.push(p2);
            } else if (inside1 && !inside2) {
                const hit = intersect(p1, p2);
                if (hit && hit[0]) clipped.push(hit[0]);
            } else if (!inside1 && inside2) {
                const hit = intersect(p1, p2);
                if (hit && hit[0]) clipped.push(hit[0]);
                clipped.push(p2);
            } else {
                const hits = intersect(p1, p2);
                if (hits && hits.length === 2) {
                    clipped.push(hits[0]);
                    clipped.push(hits[1]);
                }
            }
        }
        return clipped;
    }

    let allVerts, allIndices, vdata, mesh;
    function generateGeometry() {
        // ====== 1) Build lattice ======
        const centers = [];
        const maxRing = Math.ceil(circleRadius / (hexRadius * 1.5)) + 2;
        for (let q = -maxRing; q <= maxRing; q++) {
            for (let r = -maxRing; r <= maxRing; r++) {
                centers.push({ q, r, pos: hexToCartesian(q, r, hexRadius) });
            }
        }

        // ====== 2) Triangulate ======
        allVerts = [];
        allIndices = [];
        const vertexMap = new Map();
        const triIdToIndex = new Map();

        function getVertexIndex(v) {
            const key = `${v.x.toFixed(5)},${v.y.toFixed(5)}`;
            if (vertexMap.has(key)) return vertexMap.get(key);
            const idx = allVerts.length / 3;
            allVerts.push(v.x, 0, v.y);
            vertexMap.set(key, idx);
            return idx;
        }

        for (const { q, r, pos: c } of centers) {
            const corners = [];
            for (let i = 0; i < 6; i++) {
                const a = Math.PI / 3 * i + Math.PI / 6;
                corners.push(
                    new Vector2(
                        c.x + hexRadius * Math.cos(a),
                        c.y + hexRadius * Math.sin(a),
                    ),
                );
            }

            for (let i = 0; i < 6; i++) {
                const tri = [c, corners[i], corners[(i + 1) % 6]];
                const clipped = clipPolygonToCircle(tri, circleRadius);
                if (clipped.length >= 3) {
                    const base = getVertexIndex(clipped[0]);
                    for (let k = 1; k < clipped.length - 1; k++) {
                        const i1 = getVertexIndex(clipped[k]);
                        const i2 = getVertexIndex(clipped[k + 1]);
                        const triStart = allIndices.length;
                        allIndices.push(base, i1, i2);
                        triIdToIndex.set(`${q},${r},${i}`, triStart);
                    }
                }
            }
        }

        // ====== 3) Mesh ======
        mesh = registerOrReuseResource(
            scene,
            "island",
            () => {
                let m = new Mesh("island", scene);
                return m;
            },
        );

        const oldIndexCount = mesh.getTotalIndices();
        const oldVertexCount = mesh.getTotalVertices();

        const newIndexCount = allIndices.length;
        const newVertexCount = allVerts.length / 3;

        const needsResize = newIndexCount !== oldIndexCount ||
            newVertexCount !== oldVertexCount;

        vdata = new VertexData();
        vdata.indices = allIndices;
        // vdata.applyToMesh(mesh); // indices only (non updatable is fine)
        if (needsResize) {
            // recreate index buffer
            mesh.setIndices(allIndices, null, true);

            // recreate vertex buffer
            mesh.setVerticesData(
                VertexBuffer.PositionKind,
                allVerts.slice(),
                true,
                3, // item size
                true, // instantiate new buffer
            );
        } else {
            // update in-place (same buffer size)
            mesh.updateVerticesData(
                VertexBuffer.PositionKind,
                allVerts,
            );
            mesh.setIndices(allIndices);
        }

        const mat = new StandardMaterial("mat", scene);
        // mat.diffuseColor = new Color3(0.3, 0.8, 1.0);
        mat.backFaceCulling = false;
        // mat.wireframe = true;
        mesh.material = mat;
        return { originalVerts: allVerts.slice(), mesh };
    }

    let clampRadius = 7.6; // C
    let strength = .7; // α = 1/(1+strength)
    let edgeSlope = .15; // slope at R (0..1)
    let easingFn = new QuadraticEase();
    easingFn.setEasingMode(EasingFunction.EASINGMODE_EASEIN);

    // Interior shaping amount for the easing "bump" (kept modest to avoid artifacts)
    let curveAmount = .5;

    let mapR = makeRadiusMapper(
        circleRadius,
        clampRadius,
        strength,
        edgeSlope,
        easingFn,
        curveAmount,
    );

    function rebuildDeformedMesh(scene) {
        let { originalVerts } = generateGeometry();
        applyWarp({ originalVerts, mapR });

        if (scene.compositeHeightmap) {
            applyHeightmapToMesh(mesh, { strength: heightmapStrength });
            applyProceduralPBR(mesh, scene, {
                useTextureBake: true,
                cache: skirt.cache,
                cache_prefix: skirt.cache_prefix,
            });
        }
    }

    rebuildDeformedMesh(scene);

    // ====== 4) Balanced-Density Warp (with Easing shaping) ======

    function alphaFromStrength(s) {
        return 1 / (1 + Math.max(0, s));
    }

    // Hermite with fixed endpoint slopes; t in [0,1], p0..p1 are positions, m0,m1 are *derivatives wrt r* times (R-C)
    function hermiteBridge(t, p0, p1, m0, m1) {
        const t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }

    // Build radius mapper:
    //  - Inside (r ≤ C): newR = α r  (flat slope α, constant density)
    //  - Outside (C..R): Hermite from αC to R with slopes α at C and edgeSlope at R
    //  - Easing: we add an interior bump B(t) = e(t)*(1 - e(t)) so B(0)=B(1)=0 and B'(0)=B'(1)=0.
    //            This shapes the curve without affecting endpoint values or slopes.
    function makeRadiusMapper(R, C, sStrength, sEdgeSlope, easing, bumpAmt) {
        const α = alphaFromStrength(sStrength);
        const span = R - C;
        const p0 = α * C;
        const p1 = R;
        const m0 = α * span; // slope at C (times span)
        const m1 = sEdgeSlope * span; // slope at R (times span)

        // Precompute for speed
        return function mapR(r) {
            if (r <= 0) return 0;

            if (r <= C) return α * r;

            const t = (r - C) / span;

            // Base Hermite that enforces endpoint slopes exactly
            const base = hermiteBridge(t, p0, p1, m0, m1);

            // Easing-shaped compression bump — zero at both ends but subtractive near R
            const et = easing ? easing.ease(t) : t;
            const bump = et * (1 - et);
            const shaped = base - bumpAmt * bump * (p1 - p0); // subtract → stronger near edge
            return shaped;
        };
    }

    // Inverse via LUT on newR -> r (monotone)
    function makeInverseRadiusMapper(
        R,
        C,
        sStrength,
        sEdgeSlope,
        easing,
        bumpAmt,
        N = 2048,
    ) {
        const mapR = makeRadiusMapper(
            R,
            C,
            sStrength,
            sEdgeSlope,
            easing,
            bumpAmt,
        );
        const r0s = new Float32Array(N + 1);
        const Rs = new Float32Array(N + 1);
        for (let i = 0; i <= N; i++) {
            const r0 = (i / N) * R;
            r0s[i] = r0;
            Rs[i] = mapR(r0);
        }
        return function invR(newR) {
            if (newR <= 0) return 0;
            if (newR >= R) return R;
            let lo = 0, hi = N;
            while (lo + 1 < hi) {
                const mid = (lo + hi) >> 1;
                if (Rs[mid] < newR) lo = mid;
                else hi = mid;
            }
            const d = Rs[hi] - Rs[lo];
            if (d <= 1e-12) return r0s[lo];
            const t = (newR - Rs[lo]) / d;
            return r0s[lo] + t * (r0s[hi] - r0s[lo]);
        };
    }

    let invR = makeInverseRadiusMapper(
        circleRadius,
        clampRadius,
        strength,
        edgeSlope,
        easingFn,
        curveAmount,
    );

    function applyWarp({ originalVerts, mapR }) {
        const warped = originalVerts.slice();
        const R = circleRadius;
        for (let i = 0; i < warped.length; i += 3) {
            const x = warped[i];
            const y = warped[i + 2];
            const r = Math.hypot(x, y);
            if (r === 0) continue; // ← only keep divide-by-zero protection
            const nr = mapR(r);
            const k = nr / r;
            warped[i] = x * k;
            warped[i + 2] = y * k;
        }
        vdata.positions = warped;
        vdata.normals = [];
        VertexData.ComputeNormals(warped, allIndices, vdata.normals);
        vdata.applyToMesh(mesh);
    }

    // -------------------------------------------------------------

    function hexCenterWarped(q, r) {
        const size = hexRadius;
        const c = hexToCartesian(q, r, size);
        const r0 = Math.hypot(c.x, c.y);
        const R = circleRadius;
        if (r0 >= R) {
            const s = R / r0;
            return new Vector3(c.x * s, 0, c.y * s);
        }
        const nr = mapR(r0);
        const k = nr / r0;
        return new Vector3(c.x * k, 0, c.y * k);
    }

    function buildHexMeshAt(q, r, outMesh, liftY = 0.03) {
        const size = hexRadius;
        const center = hexCenterWarped(q, r);
        const corners = [];
        for (let i = 0; i < 6; i++) {
            const a = Math.PI / 3 * i + Math.PI / 6;
            const local = new Vector2(
                (q + r / 2) * Math.sqrt(3) * size + size * Math.cos(a),
                (r * 1.5) * size + size * Math.sin(a),
            );
            const r0 = Math.hypot(local.x, local.y);
            const nr = (r0 >= circleRadius) ? circleRadius : mapR(r0);
            const k = nr / r0;
            corners.push(new Vector3(local.x * k, liftY, local.y * k));
        }

        const pos = [];
        const idx = [];
        for (let i = 0; i < 6; i++) {
            pos.push(center.x, center.y + liftY, center.z);
            pos.push(corners[i].x, corners[i].y, corners[i].z);
            pos.push(
                corners[(i + 1) % 6].x,
                corners[(i + 1) % 6].y,
                corners[(i + 1) % 6].z,
            );
            const base = i * 3;
            idx.push(base, base + 1, base + 2);
        }
        const vd = new VertexData();
        vd.positions = pos;
        vd.indices = idx;
        vd.normals = [];
        VertexData.ComputeNormals(pos, idx, vd.normals);
        vd.applyToMesh(outMesh, true);
        outMesh.setEnabled(true);
    }

    // ====== 7) GUI (lil-gui) ======

    function attachHexWarpGUI() {
        if (typeof window === "undefined") return;

        let gui;
        if (window.__GLOBAL_LIL_GUI__) {
            gui = window.__GLOBAL_LIL_GUI__;
        }

        // Destroy old folder if exists
        const existing = gui.folders?.find?.((f) => f._title === "Hex Warp");
        if (existing) existing.destroy();

        const folder = gui.addFolder("Hex Warp");

        const params = {
            heightmapScale: 1,
            clampRadius: clampRadius,
            strength: strength,
            edgeSlope: edgeSlope,
            curveAmount: curveAmount,
            heightmapStrength: heightmapStrength,
            circleRadius: circleRadius,
            hexRadius: hexRadius,
            heightmapShrink: scene._heightmapShrink || 1.0,
            easing: "Quadratic",
        };

        const easingDefs = {
            Quadratic: QuadraticEase,
            Cubic: CubicEase,
            Quartic: QuarticEase,
            Quintic: QuinticEase,
            Exponential: ExponentialEase,
            Sine: SineEase,
            Circle: CircleEase,
            Power: PowerEase,
        };

        // Clamp Radius
        folder.add(params, "clampRadius", 0.0, circleRadius * 0.95)
            .name("Clamp Radius")
            .onChange((v) => {
                clampRadius = Math.min(Math.max(0, v), circleRadius - 1e-6);
                mapR = makeRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                invR = makeInverseRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                rebuildDeformedMesh(scene);
            });

        folder.add(params, "heightmapScale", 0.1, 4.0)
            .name("Heightmap Scale")
            .onChange((v) => {
                scene.compositeHeightmap.scale = v;
                rebuildDeformedMesh(scene);
                // shading reacts automatically
            });

        // Strength
        folder.add(params, "strength", 0.0, 8.0)
            .name("Strength (inside compression)")
            .onChange((v) => {
                strength = v;
                mapR = makeRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                invR = makeInverseRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                rebuildDeformedMesh(scene);
            });

        // Edge slope
        folder.add(params, "edgeSlope", 0.0, 1.0)
            .name("Edge Slope at R")
            .onChange((v) => {
                edgeSlope = v;
                mapR = makeRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                invR = makeInverseRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                rebuildDeformedMesh(scene);
            });

        // Curve Amount
        folder.add(params, "curveAmount", 0.0, 1.0)
            .name("Curve Amount (easing bump)")
            .onChange((v) => {
                curveAmount = v;
                mapR = makeRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                invR = makeInverseRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                rebuildDeformedMesh(scene);
            });

        // Heightmap strength
        folder.add(params, "heightmapStrength", 0.0, 12.0)
            .name("Heightmap Strength")
            .onChange((v) => {
                heightmapStrength = v;
                rebuildDeformedMesh(scene);
            });

        // Hex Lattice Radius
        folder.add(params, "circleRadius", 0.0, 50.0)
            .name("HexMesh Radius")
            .onChange((v) => {
                circleRadius = v;
                mapR = makeRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                invR = makeInverseRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                rebuildDeformedMesh(scene);
            });

        // Cell radius
        folder.add(params, "hexRadius", 0.02, 0.5)
            .name("Cell Radius")
            .onChange((v) => {
                hexRadius = v;
                rebuildDeformedMesh(scene);
            });

        // Heightmap shrink (padding)
        folder.add(params, "heightmapShrink", 0.05, 1.0)
            .name("Heightmap Shrink (padding)")
            .onChange((v) => {
                scene._heightmapShrink = v;

                skirt.runJFA(
                    scene,
                    registerOrReuseResource(
                        scene,
                        "source_island_heightmap",
                        () => null,
                    ),
                    {
                        pad: 1.0 / v,
                        heightMultiplier: 15.0,
                        targetMesh: mesh,
                    },
                );
            });

        // Easing selector
        folder.add(params, "easing", Object.keys(easingDefs))
            .name("Easing (EaseIn)")
            .onChange((label) => {
                const EaseClass = easingDefs[label];
                easingFn = new EaseClass();
                easingFn.setEasingMode(EasingFunction.EASINGMODE_EASEIN);

                if (label === "Power" && typeof easingFn.power === "number") {
                    easingFn.power = 2;
                }

                mapR = makeRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );
                invR = makeInverseRadiusMapper(
                    circleRadius,
                    clampRadius,
                    strength,
                    edgeSlope,
                    easingFn,
                    curveAmount,
                );

                rebuildDeformedMesh(scene);
            });

        folder.open();
    }

    attachHexWarpGUI();

    return mesh;
}

// ============================================================================
//  PROCEDURAL PBR MATERIAL FROM COMPOSITE HEIGHT + EROSION
// ============================================================================

import { COLORS } from "../colors.js";
/**
 * Full PBR terrain shading:
 *  - Same logic for vertex colors and baked textures
 *  - Continuous blending between layers using height + slope + curvature
 *  - Correct metallic/roughness/AO packing for Babylon PBRMaterial
 *
 * opts:
 *   useTextureBake?: boolean
 *   textureResolution?: number
 */
export async function applyProceduralPBR(
    mesh,
    scene,
    opts = { cache: null, cache_prefix: null },
) {
    const H = scene.compositeHeightmap;
    if (!H) {
        console.error("Composite heightmap not ready.");
        return;
    }

    const useTextureBake = opts.useTextureBake ?? false;
    const texRes = opts.textureResolution ?? 1024;

    // -----------------------------------------------------------------------
    // ART CONTROLS (what an artist tweaks)
    // -----------------------------------------------------------------------
    // Heights in [0..1] over geometry vertical extent.
    const LAYERS = [
        {
            id: "sand",
            stop: 0.00, // center height of this material band
            width: 0.50, // how wide its influence is
            colorLow: Color3.FromHexString(COLORS.peach),
            colorHigh: Color3.FromHexString(COLORS.fadedOrange),
            rough: 0.85,
            metallic: 0.02,
            ao: 0.9,
            preferSlope: 0.0, // 0 = flat, 1 = vertical
            preferCurve: 0.0, // 0 = smooth, 1 = edges/ridges
        },
        {
            id: "grass",
            stop: 0.50,
            width: 0.18,
            colorLow: Color3.FromHexString(COLORS.lightTeal),
            colorHigh: Color3.FromHexString(COLORS.kermitGreen),
            rough: 0.65,
            metallic: 0.02,
            ao: 0.8,
            preferSlope: 0.2,
            preferCurve: 0.2,
        },
        {
            id: "cliff",
            stop: 0.65,
            width: 0.25,
            colorLow: Color3.FromHexString(COLORS.greyblue),
            colorHigh: Color3.FromHexString(COLORS.blueGreen),
            rough: 0.9,
            metallic: 0.08,
            ao: 0.8,
            preferSlope: 1.0,
            preferCurve: 0.7,
        },
        {
            id: "rock",
            stop: 0.75,
            width: 5,
            colorLow: Color3.FromHexString(COLORS.stormyBlue),
            colorHigh: Color3.FromHexString(COLORS.darkNavyBlue),
            rough: 0.75,
            metallic: 0.12,
            ao: 0.8,
            preferSlope: 0.6,
            preferCurve: 0.4,
        },
    ];

    LAYERS.sort((a, b) => a.stop - b.stop);

    // -----------------------------------------------
    // POSTERIZATION SUPPORT
    // -----------------------------------------------
    const posterize = opts.posterize ?? false;

    // Convert COLORS {name:"#rrggbb"} → array of Color3
    const POSTER_PALETTE = Object.values(COLORS).map((hex) =>
        Color3.FromHexString(hex)
    );

    // Returns the closest palette color in linear RGB
    function nearestPaletteColor(c) {
        let best = null;
        let bd = Infinity;

        for (const p of POSTER_PALETTE) {
            const dr = c.r - p.r;
            const dg = c.g - p.g;
            const db = c.b - p.b;
            const d = dr * dr + dg * dg + db * db; // squared distance

            if (d < bd) {
                bd = d;
                best = p;
            }
        }
        return best.clone();
    }

    // -----------------------------------------------------------------------
    // SHARED HELPERS
    // -----------------------------------------------------------------------

    // --- Fast domain-warped value hash noise (film grain) ---
    function hash2(x, y) {
        let h = x * 374761393 + y * 668265263;
        h = (h ^ (h >> 13)) * 1274126177;
        return ((h ^ (h >> 16)) >>> 0) / 4294967295;
    }

    function noise2(u, v) {
        // Scale domain to break alignment
        const sx = u * 839.0;
        const sy = v * 977.0;

        // First hash noise sample
        const h1 = hash2(sx, sy);

        // Domain warp (breaks grid artifacts)
        const wx = sx + (h1 - 0.5) * 12.7;
        const wy = sy + (h1 - 0.5) * 14.9;

        // Second hash gives final grain
        return hash2(wx, wy);
    }

    // Height → soft triangular weight for this layer
    function heightWeight(h, stop, width) {
        const d = Math.abs(h - stop) / Math.max(width, 1e-6);
        return 1.0 - Scalar.Clamp(d, 0.0, 1.0); // 1 at center, 0 at edge
    }

    // How much this layer likes the local slope/curvature
    function slopeCurvBias(layer, slope01, curv01) {
        const sb = 1.0 - Math.abs(slope01 - layer.preferSlope);
        const cb = 1.0 - Math.abs(curv01 - layer.preferCurve);
        return Scalar.Clamp(0.5 * (sb + cb), 0.0, 1.0);
    }

    function evalMaterial(hNorm, slope01, curv01, u, v) {
        let accumW = 0;
        const Ws = new Array(LAYERS.length);

        // raw weights per layer
        for (let i = 0; i < LAYERS.length; i++) {
            const L = LAYERS[i];

            const hw = heightWeight(hNorm, L.stop, L.width);
            if (hw <= 0.0) {
                Ws[i] = 0.0;
                continue;
            }

            const pref = slopeCurvBias(L, slope01, curv01);
            const n = noise2(u * 5.0, v * 5.0); // 0..1
            const noiseBias = Scalar.Lerp(0.9, 1.1, n); // subtle

            const w = hw * (0.5 + 0.5 * pref) * noiseBias;
            Ws[i] = Math.max(w, 0.0);
            accumW += Ws[i];
        }

        if (accumW < 1e-6) {
            // fallback: choose closest stop
            let best = 0;
            let bd = 1e9;
            for (let i = 0; i < LAYERS.length; i++) {
                const d = Math.abs(hNorm - LAYERS[i].stop);
                if (d < bd) {
                    bd = d;
                    best = i;
                }
            }
            Ws[best] = 1.0;
            accumW = 1.0;
        }

        // normalize weights
        for (let i = 0; i < LAYERS.length; i++) {
            Ws[i] /= accumW;
        }

        // accumulate outputs
        let color = new Color3(0, 0, 0);
        let rough = 0;
        let metallic = 0;
        let ao = 0;

        for (let i = 0; i < LAYERS.length; i++) {
            const L = LAYERS[i];
            const w = Ws[i];
            if (w <= 0.0) continue;

            // gradient within the band (local height)
            const bandT = Scalar.InverseLerp(
                L.stop - L.width,
                L.stop + L.width,
                hNorm,
            );
            const baseCol = Color3.Lerp(
                L.colorLow,
                L.colorHigh,
                Scalar.Clamp(bandT, 0.0, 1.0),
            );

            const n = noise2(u * 8.0, v * 8.0);
            const noisyCol = Color3.Lerp(
                baseCol,
                Color3.White(),
                (n - 0.5) * 0.1, // small shift
            );

            color = color.add(noisyCol.scale(w));
            rough += L.rough * w;
            metallic += L.metallic * w;
            ao += L.ao * w;
        }

        rough = Scalar.Clamp(rough, 0.02, 1.0);
        metallic = Scalar.Clamp(metallic, 0.0, 1.0);
        ao = Scalar.Clamp(ao, 0.0, 1.0);

        return { color, rough, metallic, ao };
    }

    // Local-space planar UVs (XZ) so texture ↔ world alignment matches vertex sampling
    function ensurePlanarUVs(mesh) {
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        if (!positions) return;

        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i];
            const z = positions[i + 2];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }

        const vcount = positions.length / 3;
        const uvs = new Float32Array(vcount * 2);
        let k = 0;

        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i];
            const z = positions[i + 2];
            const u = Scalar.InverseLerp(minX, maxX, x);
            const v = Scalar.InverseLerp(minZ, maxZ, z);
            uvs[k++] = u;
            uvs[k++] = v;
        }

        mesh.setVerticesData(VertexBuffer.UVKind, uvs, true);
    }

    // Slope + curvature from heightmap using finite differences
    function sampleSlopeCurv(H, u, v) {
        const epsU = 1.0 / H.width;
        const epsV = 1.0 / H.height;

        const hC = H.sampleUV(u, v);
        const hL = H.sampleUV(u - epsU, v);
        const hR = H.sampleUV(u + epsU, v);
        const hD = H.sampleUV(u, v - epsV);
        const hU = H.sampleUV(u, v + epsV);

        const dx = hR - hL;
        const dy = hU - hD;

        const slope = Scalar.Clamp(Math.sqrt(dx * dx + dy * dy) * 10.0, 0, 1);

        const dxx = hR + hL - 2.0 * hC;
        const dyy = hU + hD - 2.0 * hC;
        const curv = Scalar.Clamp((Math.abs(dxx) + Math.abs(dyy)) * 50.0, 0, 1);

        return { slope01: slope, curv01: curv };
    }

    // -----------------------------------------------------------------------
    // PATH 1: VERTEX COLORS (same field, sampled per-vertex)
    // -----------------------------------------------------------------------
    if (!useTextureBake) {
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
        if (!positions || !normals) return;

        const vcount = positions.length / 3;

        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < vcount; i++) {
            const py = positions[i * 3 + 1];
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
        const heightRange = Math.max(maxY - minY, 1e-5);

        const colors = new Float32Array(vcount * 4);

        for (let i = 0; i < vcount; i++) {
            const px = positions[i * 3 + 0];
            const py = positions[i * 3 + 1];
            const pz = positions[i * 3 + 2];

            const nx = normals[i * 3 + 0];
            const ny = normals[i * 3 + 1];
            const nz = normals[i * 3 + 2];

            const hNorm = Scalar.Clamp((py - minY) / heightRange, 0, 1);

            const slope01 = Scalar.Clamp(Math.sqrt(nx * nx + nz * nz), 0, 1);
            const curv01 = Scalar.Clamp(1.0 - Math.abs(ny), 0, 1);

            const u = px * 0.02;
            const v = pz * 0.02;

            let { color, rough } = evalMaterial(hNorm, slope01, curv01, u, v);

            // POSTERIZATION
            if (posterize) {
                color = nearestPaletteColor(color);
            }

            const idx = i * 4;
            colors[idx + 0] = color.r;
            colors[idx + 1] = color.g;
            colors[idx + 2] = color.b;
            colors[idx + 3] = rough;
        }

        mesh.setVerticesData(VertexBuffer.ColorKind, colors, true);

        let mat = mesh.material;
        if (!(mat instanceof PBRMaterial)) {
            mat = new PBRMaterial("proceduralPBR", scene);
            mesh.material = mat;
        }

        mat.useVertexColors = true;
        mat.metallic = 0.0;
        mat.roughness = 1.0;
        mat.useRoughnessFromMetallicTextureAlpha = false;

        return mat;
    }

    // -----------------------------------------------------------------------
    // PATH 2: TEXTURE BAKE (same field, sampled in UV / top-down domain)
    // -----------------------------------------------------------------------
    const textures = await opts.cache.ensure(
        `${opts.cache_prefix}/textures`,
        async () => {
            const albedo = new Uint8Array(texRes * texRes * 4);
            const orm = new Uint8Array(texRes * texRes * 4); // R=AO, G=Rough, B=Metal, A=1

            for (let y = 0; y < texRes; y++) {
                for (let x = 0; x < texRes; x++) {
                    const u = x / (texRes - 1);
                    const v = y / (texRes - 1);

                    const hNorm = Scalar.Clamp(H.sampleUV(u, v), 0, 1);
                    const { slope01, curv01 } = sampleSlopeCurv(H, u, v);

                    let { color, rough, metallic, ao } = evalMaterial(
                        hNorm,
                        slope01,
                        curv01,
                        u,
                        v,
                    );

                    // POSTERIZATION
                    if (posterize) {
                        color = nearestPaletteColor(color);
                    }

                    const idx = (y * texRes + x) * 4;

                    albedo[idx + 0] = (color.r * 255) | 0;
                    albedo[idx + 1] = (color.g * 255) | 0;
                    albedo[idx + 2] = (color.b * 255) | 0;
                    albedo[idx + 3] = 255;

                    orm[idx + 0] = (ao * 255) | 0; // AO
                    orm[idx + 1] = (rough * 255) | 0; // Roughness
                    orm[idx + 2] = (metallic * 255) | 0; // Metallic
                    orm[idx + 3] = 255;
                }
            }

            return { albedo, orm };
        },
    ).then(({ albedo, orm }) => {
        ensurePlanarUVs(mesh);

        const albedoTex = registerOrReuseResource(
            scene,
            "albedoTex",
            () =>
                new RawTexture(
                    albedo,
                    texRes,
                    texRes,
                    Engine.TEXTUREFORMAT_RGBA,
                    scene,
                    true, // generateMipMaps
                    false, // invertY
                    Texture.BILINEAR_SAMPLINGMODE,
                    Engine.TEXTURETYPE_UNSIGNED_BYTE,
                ),
        );

        albedoTex.gammaSpace = true; // sRGB

        const ormTex = registerOrReuseResource(
            scene,
            "ormTex",
            () =>
                new RawTexture(
                    orm,
                    texRes,
                    texRes,
                    Engine.TEXTUREFORMAT_RGBA,
                    scene,
                    true,
                    false,
                    Texture.BILINEAR_SAMPLINGMODE,
                    Engine.TEXTURETYPE_UNSIGNED_BYTE,
                ),
        );
        ormTex.gammaSpace = false; // linear

        let mat = mesh.material;
        if (!(mat instanceof PBRMaterial)) {
            mat = new PBRMaterial("proceduralPBR", scene);
            mesh.material = mat;
        }

        mat.useVertexColors = false;

        mat.albedoTexture = albedoTex;
        mat.metallicTexture = ormTex;

        // PBR packing: R=AO, G=Roughness, B=Metallic
        mat.useAmbientOcclusionFromMetallicTextureRed = true;
        mat.useRoughnessFromMetallicTextureAlpha = false;
        mat.useRoughnessFromMetallicTextureGreen = true;
        mat.useMetallnessFromMetallicTextureBlue = true;
        mat.useAmbientInGrayScale = true;

        mat.metallic = 0.0; // base; overridden per-pixel from packed texture
    });
}

function generatePlanarUVs(mesh, bounds) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const uvs = new Float32Array((positions.length / 3) * 2);

    const minX = bounds.minX;
    const maxX = bounds.maxX;
    const minZ = bounds.minZ;
    const maxZ = bounds.maxZ;

    let idx = 0;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i + 0];
        const z = positions[i + 2];

        const world = Vector3.TransformCoordinates(
            new Vector3(x, positions[i + 1], z),
            IDENTITY,
        );

        const u = Scalar.InverseLerp(minX, maxX, world.x);
        const v = Scalar.InverseLerp(minZ, maxZ, world.z);

        uvs[idx++] = u;
        uvs[idx++] = v;
    }

    mesh.setVerticesData(VertexBuffer.UVKind, uvs, true);
}

// --- Heightmap slope & curvature sampling (finite differences) ---
function sampleSlopeCurv(H, u, v) {
    const epsU = 1.0 / H.width;
    const epsV = 1.0 / H.height;

    const hC = H.sampleUV(u, v);

    const hL = H.sampleUV(u - epsU, v);
    const hR = H.sampleUV(u + epsU, v);
    const hD = H.sampleUV(u, v - epsV);
    const hU = H.sampleUV(u, v + epsV);

    // Slope from gradient magnitude
    const dx = hR - hL;
    const dy = hU - hD;
    const slope = Scalar.Clamp(Math.sqrt(dx * dx + dy * dy) * 10.0, 0, 1);

    // Curvature = Laplacian magnitude
    const dxx = hR + hL - 2 * hC;
    const dyy = hU + hD - 2 * hC;
    const curv = Scalar.Clamp((Math.abs(dxx) + Math.abs(dyy)) * 50.0, 0, 1);

    return { slope01: slope, curv01: curv };
}
