import { WINDOW_CONTEXT } from "@/lib/helpers";
import {
    Color4,
    Constants,
    Effect,
    Mesh,
    MirrorTexture,
    Plane,
    RenderTargetTexture,
    ShaderMaterial,
    Vector4,
    VertexData,
} from "@babylonjs/core";
import GUI from "lil-gui";
/**
 * Stylized physically-plausible water surface with Gerstner waves + natural horizon blending.
 */
export class Water {
    /**
     * @param {import('@babylonjs/core').Scene} scene
     * @param {{radius?:number, level?:number}} [opts]
     */
    constructor(scene, opts = {}) {
        this.scene = scene;
        this.radius = opts.radius ?? 1024;
        this.level = opts.level ?? 0;

        // === Mesh ===
        this.mesh = this._makeCircularTriMesh({
            scene,
            name: "water",
            radius: this.radius,
            density: 2, // smaller triangles = higher density
            falloff: 0.2, // 20% outer band gets circular coercion
        });
        this.mesh.position.y = this.level;

        // === Register shaders ===
        this._registerShaders();

        // === Depth renderer ===
        const depthRenderer = scene.enableDepthRenderer(
            scene.activeCamera,
            false,
        );
        this.depthTex = depthRenderer.getDepthMap();

        // === Refraction RTT ===
        this.refractionRTT = new RenderTargetTexture(
            "water_refraction",
            { ratio: 0.75 },
            scene,
            false,
            true,
        );
        this.refractionRTT.wrapU = Constants.TEXTURE_MIRROR_ADDRESSMODE;
        this.refractionRTT.wrapV = Constants.TEXTURE_MIRROR_ADDRESSMODE;

        this.refractionRTT.refreshRate = 1;
        this.refractionRTT.renderList = [];
        this.refractionRTT.activeCamera = scene.activeCamera;

        // === Reflection RTT ===
        this.reflectionRTT = new MirrorTexture(
            "water_reflection",
            { ratio: 0.5 },
            scene,
            true,
        );

        this.reflectionRTT.mirrorPlane = new Plane(0, -1, 0, this.level);
        this.reflectionRTT.refreshRate = 1;
        this.reflectionRTT.renderList = [];

        scene.customRenderTargets.push(this.refractionRTT);
        scene.customRenderTargets.push(this.reflectionRTT);

        // === Shader material ===
        const shaderMaterial = new ShaderMaterial(
            "shader",
            scene,
            { vertex: "custom", fragment: "custom" },
            {
                attributes: ["position", "normal", "uv"],
                uniforms: [
                    "world",
                    "worldView",
                    "worldViewProjection",
                    "cameraPosition",

                    // time & camera depth params
                    "time",
                    "camMinZ",
                    "camMaxZ",
                    "maxDepth",

                    // water colors
                    "wFoamColor",
                    "wDeepColor",
                    "wShallowColor",

                    // screen-space noise helpers
                    "wNoiseScale",
                    "wNoiseOffset",
                    "fNoiseScale",

                    // optics
                    "iorWater",
                    "iorAir",
                    "refrScale",
                    "reflScale",

                    // gerstner controls
                    "gravity",
                    "waterDepth",
                    "choppiness",
                    "waveA",
                    "waveB",
                    "waveC",
                    "waveD",
                    "steepness",
                    "windDir",
                    "sceneColor",
                    "exposure",
                    "foamStrength",
                    "foamThreshold",
                    "foamFalloff",
                    "foamShallowBoost",
                    "foamNoiseScale",
                ],
                samplers: [
                    "depthTex",
                    "refractionSampler",
                    "reflectionSampler",
                ],
            },
        );
        shaderMaterial.backFaceCulling = false;

        // === Uniforms ===
        const u = {
            Foam: {
                foamStrength: { value: 1.2, range: [0, 3, 0.01] },
                foamThreshold: { value: 0.4, range: [0, 1, 0.01] },
                foamFalloff: { value: 1.2, range: [0, 3, 0.01] },
                foamShallowBoost: { value: 1.0, range: [0, 3, 0.01] },
                foamNoiseScale: { value: 1.0, range: [0.1, 3, 0.01] },
                wFoamColor: {
                    value: new Vector4(0.95, 0.97, 1.0, 1.0),
                    color: true,
                },
            },

            Waves: {
                gravity: { value: 9.81, range: [0, 30, 0.01] },
                waterDepth: { value: 20.0, range: [0, 100, 0.1] },
                choppiness: { value: .2, range: [0, 3, 0.01] },
                waveAmpScale: { value: 1.0, range: [0, 3, 0.01] },
                waveLengthScale: { value: 1.0, range: [0, 3, 0.01] },
                waveSpeed: { value: 1.0, range: [0, 3, 0.01] },
            },

            Optics: {
                iorWater: { value: 1.333, range: [1, 2, 0.001] },
                iorAir: { value: 1.0, range: [0.5, 2, 0.001] },
                refrScale: { value: 0.18, range: [0, 1, 0.01] },
                reflScale: { value: 0.0, range: [0, 1, 0.01] },
                maxDepth: { value: 5.0, range: [0, 50, 0.1] },
            },

            Colors: {
                wDeepColor: {
                    value: new Vector4(0.02, 0.25, 0.4, 1.0),
                    color: true,
                },
                wShallowColor: {
                    value: new Vector4(0.03, 0.55, 0.7, 1.0),
                    color: true,
                },
                sceneColor: {
                    value: new Vector4(
                        ...(Color4.FromHexString("#3b9dce").asArray()),
                    ),
                    color: true,
                },
            },

            Noise: {
                wNoiseScale: { value: 0.68, range: [0, 1, 0.001] },
                wNoiseOffset: { value: 0.015, range: [0, 0.1, 0.001] },
                fNoiseScale: { value: 1.8, range: [0, 5, 0.01] },
            },
        };

        // === Continuous uniform sync ===
        scene.onBeforeRenderObservable.add(() => {
            for (const [, group] of Object.entries(u)) {
                for (const [key, def] of Object.entries(group)) {
                    if (!def.color && typeof def.value === "number") {
                        shaderMaterial.setFloat(key, def.value);
                    }
                }
            }
        });

        shaderMaterial.setFloat("camMinZ", scene.activeCamera.minZ);
        shaderMaterial.setFloat("camMaxZ", scene.activeCamera.maxZ);
        // === GUI reuse / setup (HMR safe) ===
        let gui;

        if (WINDOW_CONTEXT.is_dev) {
            // Reuse single global lil-gui instance
            if (window.__GLOBAL_LIL_GUI__) {
                gui = window.__GLOBAL_LIL_GUI__;
            } else {
                gui = new GUI({ title: "Procedural Controls", width: 360 });
                window.__GLOBAL_LIL_GUI__ = gui;
            }

            // --- Remove any existing “Water Shader” folder ---
            const existing = gui.folders?.find?.((f) =>
                f._title === "🌊 Water Shader" || f._title === "Water Shader"
            );
            if (existing) existing.destroy();

            // --- Create fresh folder ---
            const folder = gui.addFolder("🌊 Water Shader");
            this._guiFolder = folder;

            // helper for color uniforms
            const setColorUniform = (mat, key, vec) => mat.setVector4(key, vec);

            // build nested parameter groups
            for (const [groupName, group] of Object.entries(u)) {
                const sub = folder.addFolder(groupName);
                for (const [key, def] of Object.entries(group)) {
                    const val = def.value;

                    if (def.color) {
                        // color controllers
                        setColorUniform(shaderMaterial, key, val);
                        const picker = { color: [val.x, val.y, val.z] };
                        sub.addColor(picker, "color")
                            .name(key)
                            .onChange((rgb) => {
                                const [r, g, b] = rgb;
                                setColorUniform(
                                    shaderMaterial,
                                    key,
                                    new Vector4(r, g, b, 1.0),
                                );
                            });
                    } else {
                        // numeric controllers
                        shaderMaterial.setFloat(key, val);
                        if (def.range) {
                            sub.add(
                                def,
                                "value",
                                def.range[0],
                                def.range[1],
                                def.range[2],
                            )
                                .name(key)
                                .onChange((v) =>
                                    shaderMaterial.setFloat(key, v)
                                );
                        }
                    }
                }
            }

            folder.open();
        }

        // === GUI setup ===

        // helper for color4 uniforms
        const setColorUniform = (mat, key, vec) => {
            mat.setVector4(key, vec);
        };

        // main iteration
        for (const [groupName, group] of Object.entries(u)) {
            const folder = gui?.addFolder(groupName);

            for (const [key, def] of Object.entries(group)) {
                const val = def.value;

                if (def.color) {
                    // --- COLOR UNIFORMS ---
                    setColorUniform(shaderMaterial, key, val);
                    const picker = { color: [val.x, val.y, val.z] };
                    if (folder) {
                        folder
                            .addColor(picker, "color")
                            .name(key)
                            .onChange((rgb) => {
                                const [r, g, b] = rgb;
                                setColorUniform(
                                    shaderMaterial,
                                    key,
                                    new Vector4(r, g, b, 1.0),
                                );
                            });
                    }
                } else {
                    // --- FLOAT UNIFORMS ---
                    shaderMaterial.setFloat(key, val);
                    if (def.range) {
                        if (folder) {
                            folder
                                .add(
                                    def,
                                    "value",
                                    def.range[0],
                                    def.range[1],
                                    def.range[2],
                                )
                                .name(key)
                                .onChange((v) =>
                                    shaderMaterial.setFloat(key, v)
                                );
                        }
                    }
                }
            }
        }

        // === Textures ===
        shaderMaterial.setTexture("depthTex", this.depthTex);
        shaderMaterial.setTexture("refractionSampler", this.refractionRTT);
        shaderMaterial.setTexture("reflectionSampler", this.reflectionRTT);

        // === Waves A–D definitions ===
        shaderMaterial.setVector4("waveA", new Vector4(1.0, 0.3, 0.0, 12.0)); // swell
        shaderMaterial.setVector4("waveB", new Vector4(-0.7, 1.0, 0.0, 7.0)); // swell 2
        shaderMaterial.setVector4("waveC", new Vector4(0.3, -1.0, 0.0, 3.0)); // chop
        shaderMaterial.setVector4("waveD", new Vector4(-1.0, -0.4, 0.0, 1.5)); // chop

        shaderMaterial.alpha = 1;

        this.material = shaderMaterial;
        this.mesh.material = shaderMaterial;

        // === Keep time and camera in sync ===
        this._renderObserver = scene.onBeforeRenderObservable.add(() => {
            shaderMaterial.setFloat("time", performance.now() * 0.0009);

            shaderMaterial.setVector3(
                "cameraPosition",
                scene.activeCamera.position,
            );
            this.refractionRTT.activeCamera = scene.activeCamera;
        });

        // === Handle resizing ===
        const engine = scene.getEngine();
        engine.onResizeObservable.add(() => {
            const { reflectionRTT, refractionRTT, material, scene } = this;

            refractionRTT.resize({ ratio: 0.1 });
            reflectionRTT.resize({ ratio: 0.1 });
        });

        // === Link island ===
        const linkIsland = (m) => {
            if (m && m.name === "island") {
                const list = [m];
                this.refractionRTT.renderList = list;
                this.reflectionRTT.renderList = list;
                this.depthTex.renderList = list;
            }
        };
        this._newMeshObserver = scene.onNewMeshAddedObservable.add(linkIsland);
        scene.meshes.forEach(linkIsland);

        // === Maintain reflection lists ===
        const updateRenderLists = () => {
            const list = scene.meshes.filter((m) =>
                m !== this.mesh && m.isVisible && m.isEnabled()
            );

            this.reflectionRTT.renderList = list;
            this.refractionRTT.renderList = list;
        };
        updateRenderLists();
        this._meshAddedObserver = scene.onNewMeshAddedObservable.add(
            updateRenderLists,
        );
        this._meshRemovedObserver = scene.onMeshRemovedObservable?.add?.(
            updateRenderLists,
        );
    }

    /** Circular water surface (double-sided), same topology approach */
    _makeCircularTriMesh({
        scene,
        name = "triSurface",
        radius = 128,
        density = 1.0, // 1.0 = triangles of size ~radius/40 (adjustable)
        falloff = 0.15, // % of radius where circular coercion starts
    }) {
        const positions = [];
        const uvs = [];
        const indices = [];

        const R = radius;
        const triSize = R / (40 * density); // density → triangle edge size
        const u = [triSize, 0];
        const v = [triSize * 0.5, triSize * Math.sqrt(3) * 0.5];

        const maxExtent = R * 1.1;
        const fall = falloff * R;

        // Storage for vertex indices
        const grid = new Map();
        const key = (i, j) => `${i},${j}`;

        let vertCount = 0;

        // --- Generate grid vertices -------------------------------------------
        // Choose range based on approximate bounding box large enough for circle
        const N = Math.ceil(maxExtent / triSize) + 3;

        for (let i = -N; i <= N; i++) {
            for (let j = -N; j <= N; j++) {
                // Triangular-lattice coordinate → 2D point
                const x = i * u[0] + j * v[0];
                const z = i * u[1] + j * v[1];
                const r = Math.sqrt(x * x + z * z);

                if (r > maxExtent) continue;

                // --- circular coercion near boundary ---
                if (r > R - fall) {
                    const t = (r - (R - fall)) / fall;
                    const w = t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
                    const nx = x / r;
                    const nz = z / r;
                    const rx = (1 - w) * x + w * nx * R;
                    const rz = (1 - w) * z + w * nz * R;
                    positions.push(rx, 0, rz);
                } else {
                    positions.push(x, 0, z);
                }

                // Simple UV mapping (radial)
                uvs.push((x / R) * 0.5 + 0.5, (z / R) * 0.5 + 0.5);

                grid.set(key(i, j), vertCount++);
            }
        }

        // --- Generate triangle indices ------------------------------------------
        const tryAdd = (a, b, c) => {
            if (a !== undefined && b !== undefined && c !== undefined) {
                indices.push(a, b, c);
            }
        };

        for (let i = -N; i <= N; i++) {
            for (let j = -N; j <= N; j++) {
                const a = grid.get(key(i, j));
                if (a === undefined) continue;

                // The six surrounding triangles in a triangular lattice
                const b = grid.get(key(i + 1, j));
                const c = grid.get(key(i, j + 1));
                const d = grid.get(key(i - 1, j + 1));

                tryAdd(a, b, c);
                tryAdd(a, c, d);
            }
        }

        // --- Build Babylon mesh --------------------------------------------------
        const mesh = new Mesh(name, scene);
        const vd = new VertexData();

        vd.positions = positions;
        vd.indices = indices;
        vd.uvs = uvs;

        const normals = [];
        VertexData.ComputeNormals(positions, indices, normals);
        vd.normals = normals;

        vd.applyToMesh(mesh);
        return mesh;
    }

    /** Vertex + fragment shaders */
    _registerShaders() {
        // === Vertex shader unchanged (Gerstner) ===
        Effect.ShadersStore["customVertexShader"] = `precision highp float;
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 worldView;
uniform mat4 worldViewProjection;
uniform float time;

// === Tunables & physical parameters ===
uniform float gravity;         // affects wave period
uniform float waterDepth;      // affects directional coherence
uniform float choppiness;      // horizontal displacement strength
uniform float waveAmpScale;    // amplitude multiplier
uniform float waveLengthScale; // wavelength multiplier
uniform float waveSpeed;       // temporal speed
uniform float waveSeed;        // per-instance random offset
uniform vec4  windDir;         // direction + magnitude
uniform vec4  steepness;       // 4-component slope mod (currently applied globally)
uniform float windSeed;        // secondary random phase for gusts (optional)

// === Outputs ===
varying vec3 vPositionW;
varying vec4 vClipSpace;
varying vec3 vPosVS;
varying vec3 vNormalW;
varying vec3 vNormalVS; 
varying float vCrest;
varying vec2 vFoamFlow;
// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
float hash11(float p){ 
    p = fract(p*0.1031 + waveSeed*0.17);
    p *= p + 33.33; 
    p *= p + p; 
    return fract(p);
}

mat2 rot(float a){ 
    float c = cos(a), s = sin(a); 
    return mat2(c,-s,s,c); 
}

#define NUM_WAVES 5

struct Wave { vec2 dir; float amp; float k; float w; float phase; };

// ---------------------------------------------------------------------------
// Wave initialization — loosely aligned with wind direction, modulated by depth
// ---------------------------------------------------------------------------
void initWaves(out Wave W[NUM_WAVES], float t){
    // Compute wind properties
    float windMag = clamp(length(windDir.xy), 0.0, 3.0);           // strength
    vec2 windNorm = windMag > 0.001 ? normalize(windDir.xy) : vec2(1.0, 0.0);

    // Gentle time-based gust rotation
    float gust = sin(t * 0.05 + windSeed * 3.14159) * 0.15;        // ±0.15 radians
    mat2 gustRot = rot(gust);
    vec2 baseDir = gustRot * windNorm;

    // Coherence from depth & wind
    float depthAlign = clamp(waterDepth / 30.0, 0.0, 1.0);         // deep→aligned
    float windAlign  = smoothstep(0.2, 1.5, windMag);               // strong wind→aligned
    float alignment  = clamp(0.25 + 0.75 * windAlign * depthAlign, 0.0, 1.0);

    // Populate wave set
    for (int i=0; i<NUM_WAVES; ++i){
        float fi = float(i);
        float r0 = hash11(10.0 + fi);
        float r1 = hash11(20.0 + fi);
        bool swell = (i < NUM_WAVES/3);

        float L = swell ? mix(6.0,14.0,r0) : mix(0.4,3.0,r0);
        L *= waveLengthScale;
        float k = 6.28318530718 / L;
        float w = sqrt(gravity * k);

        // Direction spread inversely related to alignment
        float spread = radians(mix(60.0, 10.0, alignment));
        float deviation = radians(mix(-spread, spread, r1));
        vec2 dir = normalize(rot(deviation) * baseDir);

        // Amplitude scales with wind strength and global amp
        float amp = (swell ? mix(0.06,0.15,r0) : mix(0.008,0.035,r0));
        amp *= (0.8 + 0.4 * windAlign) * waveAmpScale;

        W[i] = Wave(dir, amp, k, w, r1 * 6.28318);
    }
}

// ---------------------------------------------------------------------------
// Analytical height and gradient
// ---------------------------------------------------------------------------
float heightAt(vec2 xz, float t, Wave W[NUM_WAVES]){
    float y=0.0;
    for (int i=0; i<NUM_WAVES; ++i){
        Wave w=W[i];
        float th = dot(w.dir, xz)*w.k - w.w*t*waveSpeed + w.phase;
        y += w.amp * sin(th);
    }
    return y;
}

vec2 heightGrad(vec2 xz, float t, Wave W[NUM_WAVES]){
    vec2 g=vec2(0.0);
    for (int i=0; i<NUM_WAVES; ++i){
        Wave w=W[i];
        float th = dot(w.dir, xz)*w.k - w.w*t*waveSpeed + w.phase;
        g += w.amp * w.k * w.dir * cos(th);
    }
    return g;
}

// ---------------------------------------------------------------------------
// Vertex main
// ---------------------------------------------------------------------------
void main(){
    Wave W[NUM_WAVES];
    initWaves(W, time);

    vec3 pos = position;

    // Skip deep skirt vertices (below edgeDepth)
    if (pos.y > -1500.0) {
        float y = heightAt(pos.xz, time, W);
        pos.y = y;
    }

    vec2 grad = heightGrad(pos.xz, time, W);
 vFoamFlow = grad * (choppiness * 0.15);
    // Apply horizontal choppiness (Gerstner-style)
    pos.xz += grad * (choppiness * 0.3);

    // Normal
    vec3 n = normalize(vec3(-grad.x * choppiness, 1.0, -grad.y * choppiness));
    

    // Foam crest proxy
    float slope = length(grad);
    vCrest = smoothstep(0.8, 1.6, slope);

    // World transforms
    vec4 worldPos = world * vec4(pos, 1.0);
    vPositionW = worldPos.xyz;
    vNormalW = normalize((world * vec4(n, 0.0)).xyz);
    vPosVS = (worldView * vec4(pos, 1.0)).xyz;
    vClipSpace = worldViewProjection * vec4(pos, 1.0);
     vec3 nVS = normalize((worldView * vec4(n, 0.0)).xyz);
    vNormalVS = nVS;
    gl_Position = vClipSpace;
}

`;

        Effect.ShadersStore["customFragmentShader"] = `
precision highp float;

varying vec3 vPositionW;
varying vec4 vClipSpace;
varying vec3 vPosVS;
varying vec3 vNormalW;
varying vec3 vNormalVS;
varying float vCrest;
varying vec2 vFoamFlow;

uniform sampler2D depthTex;
uniform sampler2D refractionSampler;
uniform sampler2D reflectionSampler;

uniform float camMinZ;
uniform float camMaxZ;
uniform float maxDepth;
uniform vec4  wFoamColor;
uniform vec4  wDeepColor;
uniform vec4  wShallowColor;
uniform float time;
uniform float wNoiseScale;
uniform float wNoiseOffset;
uniform float fNoiseScale;
uniform float iorWater;
uniform float iorAir;
uniform float refrScale;
uniform float reflScale;
uniform vec4  windDir;
uniform vec3  cameraPosition;
uniform vec4  sceneColor;
uniform float exposure;
uniform float foamStrength;
uniform float foamThreshold;
uniform float foamFalloff;
uniform float foamShallowBoost;
uniform float foamNoiseScale;

float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}


// --- helpers ---------------------------------------------------
float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f*f*(3.0 - 2.0*f); // smoothstep

    float n = dot(i, vec3(1.0, 57.0, 113.0));

    float a = hash13(i);
    float b = hash13(i + vec3(1,0,0));
    float c = hash13(i + vec3(0,1,0));
    float d = hash13(i + vec3(1,1,0));
    float e = hash13(i + vec3(0,0,1));
    float f1= hash13(i + vec3(1,0,1));
    float g = hash13(i + vec3(0,1,1));
    float h = hash13(i + vec3(1,1,1));

    float nx00 = mix(a, b, f.x);
    float nx10 = mix(c, d, f.x);
    float nx01 = mix(e, f1, f.x);
    float nx11 = mix(g, h, f.x);

    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);

    return mix(nxy0, nxy1, f.z);
}


float fbm(vec3 p){
  float a = 0.5;
  float s = 0.0;
  s += a * noise(p);         p *= 2.01; a *= 0.5;
  s += a * noise(p);         p *= 2.01; a *= 0.5;
  s += a * noise(p);
  return s;
}

float fresnelSchlick(float cosTheta, float F0){
  return F0 + (1.0 - F0)*pow(1.0 - cosTheta, 5.0);
}

float phaseHG(float mu){
  float g = 0.6;
  float gg = g*g;
  return (1.0 - gg) / (4.0 * 3.14159 * pow(1.0 + gg - 2.0*g*mu, 1.5));
}

void main(void){

  vec2 ndc = (vClipSpace.xy / vClipSpace.w) / 2.0 + 0.5;

  // ORIGINAL ripple computation (will be replaced after minimal fade)
  vec2 p = vPositionW.xz * wNoiseScale;
// === DOMAIN WARPED FLOW NOISE ===



// Time-warped animation to avoid periodic snapping
vec3 timeWarp = vec3(
    cos(time * 0.15) * 3.0,
    sin(time * 0.21) * 3.0,
    sin(time * 0.13) * 3.0
);

// Primary domain warp
vec2 warp1 = vec2(
    noise(vec3(p * 0.75, 0.0) + timeWarp),
    noise(vec3(p * 0.85 + 11.5, 0.0) + timeWarp)
);

// Secondary domain warp (nested) for extra fluidity
vec2 warp2 = vec2(
    noise(vec3((p + warp1 * 0.4) * 1.1, 0.0) + timeWarp * 0.5),
    noise(vec3((p + warp1 * 0.4) * 1.3 + 17.7, 0.0) + timeWarp * 0.5)
);

// Apply warp
p += warp1 * 0.35 + warp2 * 0.25;

// Final noise sample
float ripple = noise(vec3(p * 1.0, 0.0) + timeWarp) * wNoiseOffset;




  float depthBehind = texture2D(depthTex, ndc + ripple).r;
  float surfaceDepth = (vClipSpace.z + camMinZ) / (camMaxZ + camMinZ);
  float depthDelta = max(0.0, depthBehind - surfaceDepth);
  float waterDepthMeters = depthDelta * camMaxZ;
  float depthVisibility = exp(-waterDepthMeters / 50.0);
  float wdepth = clamp((camMaxZ * depthDelta) / maxDepth, 0.0, 1.0);

  vec3 N  = normalize(vNormalW);
  vec3 Vw = normalize(cameraPosition - vPositionW);
  if ((cameraPosition.y + 0.02) < vPositionW.y) Vw = -Vw;

  bool isUnder = !gl_FrontFacing;

  float n1 = isUnder ? iorWater : iorAir;
  float n2 = isUnder ? iorAir   : iorWater;
  float eta = n1 / n2;
  float cosI = clamp(dot(N, Vw), 0.0, 1.0);
  float F0 = pow((n1 - n2) / (n1 + n2), 2.0);
  float Fr = fresnelSchlick(cosI, F0);

  vec3 T = refract(-Vw, N, eta);
  vec3 R = reflect(-Vw,  N);
  bool TIR = all(lessThan(abs(T), vec3(1e-6)));
  if (TIR) Fr = 1.0;

  float eyeZ = max(1.0, -vPosVS.z);
  float refrMult = isUnder ? refrScale : 0.0;

  // ============================
  //  MINIMAL HORIZON FADE INSERT
  // ============================

  // World-space distance from camera to water fragment
// === Angle-based horizon flattening ===
// View angle: 1.0 when grazing (edge of water), 0.0 when looking down
float horizonFade = 1.0 - abs(dot(Vw, N));
 horizonFade = smoothstep(0.3, 0.95, horizonFade) * 0.4;


  // Reduce ripple near horizon
  float rippleFade = (1.0 - 0.7 * horizonFade);

  // Replace ORIGINAL ripple only here:
  ripple = fbm(vec3(vPositionW.xz * wNoiseScale * 1.3, time * 0.7)) 
           * wNoiseOffset * rippleFade;

  // ============================
  //  END OF MINIMAL ADDITION
  // ============================


  vec2 refrUV = ndc + (refrMult * T.xy) / eyeZ + ripple * 0.4;
  vec2 reflUV = ndc + (reflScale * R.xy) / eyeZ - ripple * 0.4;

  vec3 refrColor = texture2D(refractionSampler, refrUV).rgb;
  vec3 reflColor = texture2D(reflectionSampler, reflUV).rgb;

  float reflectFade = mix(1.0, 0.35, horizonFade);   // reduce reflection intensity
float refractFade = mix(1.0, 0.55, horizonFade);   // reduce refractive contrast

reflColor = mix(reflColor, sceneColor.rgb, horizonFade * 0.6);
refrColor = mix(refrColor, sceneColor.rgb, horizonFade * 0.4);

reflColor *= reflectFade;
refrColor *= refractFade;

  vec3 env = sceneColor.rgb * exposure;

  float envLum = max(0.0001, dot(env, vec3(0.2126,0.7152,0.0722)));
  vec3 envNorm = env / envLum;
  float envMax = max(max(envNorm.r, envNorm.g), envNorm.b);
  float envMin = min(min(envNorm.r, envNorm.g), envNorm.b);
  float envSat = (envMax - envMin) / max(envMax, 1e-3);
  vec3 fallbackSky = vec3(0.18, 0.36, 0.85);
  vec3 envSafe = mix(fallbackSky, env, clamp(envSat * envLum * 3.0, 0.0, 1.0));

  vec3 skyZenith  = envSafe * 0.85;
  vec3 skyHorizon = envSafe * 0.95;

  vec3 up = vec3(0.0, 1.0, 0.0);
  float horizonBlend = smoothstep(0.45, 0.85, 1.0 - abs(dot(Vw, up)));
  horizonBlend = mix(0.35, 0.65, horizonBlend);
  vec3 skyColor = mix(skyZenith, skyHorizon, horizonBlend);


  // === foam math ===
  vec2 advect = vFoamFlow * time * 1.5;
  float shallowFoam = smoothstep(foamThreshold * 0.5, foamThreshold + 0.25, 1.0 - wdepth);
  float crestFoam   = pow(vCrest, 1.2 + foamFalloff * 0.5);
  float foamCombined = mix(shallowFoam, crestFoam, 0.6);
  float t = foamCombined * 6.28318 * foamNoiseScale;
  float band1 = 0.5 + 0.5 * sin(t + time * 0.1);
  float band2 = 0.5 + 0.5 * sin(t * 1.7 + time * 0.07);
  float band3 = 0.5 + 0.5 * sin(t * 2.4 - time * 0.05);
  float bands = (band1 * 0.5 + band2 * 0.35 + band3 * 0.25);
  bands = pow(bands, 1.5 / (foamFalloff + 0.5));
  float shallowBoost = 1.0 + foamShallowBoost * (1.0 - wdepth);
  float foamMask = clamp(bands * foamCombined * foamStrength * shallowBoost, 0.0, 1.0);

  // MINIMALLY fade foam near horizon
  foamMask *= (1.0 - 0.8 * horizonFade);


  // =========================
  // ABOVE WATER
  // =========================
  if (!isUnder) {
      vec3 deepCol = mix(wDeepColor.rgb, wShallowColor.rgb, 0.3);
      float roughness = 0.15;
      Fr *= mix(1.0, 0.75, roughness);

      vec3 absorbA = vec3(0.08, 0.045, 0.02);
      vec3 trans   = exp(-absorbA * (4.0 * clamp(wdepth + 0.15, 0.0, 1.0)));

      vec3 refrCol = texture2D(refractionSampler, refrUV).rgb;
      vec3 reflCol = texture2D(reflectionSampler,  reflUV).rgb;

      refrCol *= trans;
      refrCol = mix(refrCol, deepCol, 0.3);
      refrCol = mix(refrCol, deepCol, 1.0 - depthVisibility);

      vec3 color = mix(refrCol, reflCol, Fr);
      color = mix(color, wFoamColor.rgb, foamMask * 0.6);
    // === FINAL horizon flattening (this was missing) ===
    float flatten = horizonFade;               // 0 = no change, 1 = flat horizon
    vec3 horizonColor = sceneColor.rgb;              // or wDeepColor.rgb if preferred
    color = mix(color, horizonColor, flatten); // <-- THIS was missing
      gl_FragColor = vec4(color, 1.0);
      return;
  }


  // =========================
  // UNDER WATER
  // =========================

  float d = distance(cameraPosition, vPositionW);

  vec3 sigma_a = vec3(0.06, 0.035, 0.015);
  vec3 sigma_s = vec3(0.015, 0.025, 0.040);
  vec3 sigma_t = sigma_a + sigma_s;

  float attenuation = clamp(exp(-0.25 * d), 0.35, 1.0);

  float mu = clamp(dot(Vw, up), 0.0, 1.0);
  float snellWindow = smoothstep(0.30, 0.96, mu);

  refrUV = ndc + refrScale * (-T.xy) + ripple * 0.8;
  refrColor = texture2D(refractionSampler, refrUV).rgb;
  reflColor = texture2D(reflectionSampler, ndc).rgb;

  vec3 skyTint = mix(refrColor, reflColor, 0.4);

  vec3 L_window = skyTint * (1.3 + 0.7 * snellWindow);
  float phase = phaseHG(mu);
  vec3 waterHue = normalize(vec3(0.05, 0.25, 0.55) + wShallowColor.rgb * 0.3);
  vec3 L_scatter = waterHue * phase * 0.8 * (1.0 - attenuation);
  vec3 L_surface = reflColor * (Fr * 0.3) * snellWindow;

  vec3 color = L_window * attenuation + L_scatter + L_surface;
  float windowLift = smoothstep(0.6, 1.0, mu);
  color += vec3(0.25, 0.3, 0.35) * windowLift;

  float farHaze = clamp(d / (camMaxZ * 0.6), 0.0, 1.0);
  vec3 hazeTint = waterHue * 0.25;
  color = mix(color, hazeTint, farHaze * 0.35);

  color = pow(color, vec3(0.9));

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 0.9);
}

`;
    }

    /** Dispose */
    dispose() {
        const { scene } = this;
        if (this._renderObserver) {
            scene.onBeforeRenderObservable.remove(this._renderObserver);
        }
        if (this._newMeshObserver) {
            scene.onNewMeshAddedObservable.remove(this._newMeshObserver);
        }
        if (this.reflectionRTT) {
            scene.customRenderTargets.splice(
                scene.customRenderTargets.indexOf(this.reflectionRTT),
                1,
            );
            this.reflectionRTT.dispose();
        }
        if (this.refractionRTT) {
            scene.customRenderTargets.splice(
                scene.customRenderTargets.indexOf(this.refractionRTT),
                1,
            );
            this.refractionRTT.dispose();
        }
        this.material?.dispose();
        this.mesh?.dispose();
    }
}
