// thanks! https://forum.babylonjs.com/t/tree-vegetation-wind-sway-vertex-shader/60289 inteja
// https://forum.babylonjs.com/t/simple-stylized-water-shader/17672/8 phaselock
// https://forum.babylonjs.com/t/simple-stylized-water-shader/17672/9 nevergrind

import { Biome } from '@/lib/biome/Biome.js';
import { biomes } from '@/lib/biome/biomes.js';
import {
    Animation,
    ArcRotateCamera,
    Color3,
    Color4,
    CubicEase,
    EasingFunction,
    HemisphericLight,
    MaterialPluginBase,
    Matrix,
    Mesh,
    PBRMaterial,
    PointerEventTypes,
    Ray,
    Scalar,
    Scene,
    StandardMaterial,
    Tools,
    Vector2,
    Vector3,
    Vector4,
    VertexBuffer,
    VertexData
} from '@babylonjs/core';
import { COLORS } from './colors.js';
import * as Plants from './plants/classes';

window.GLOBAL_CACHE = {};
// === WATERTIGHT LOW-POLY FISH (aligned along +Z) ==========================
function makeLowPolyFish(scene, material, opts = {}) {
    const {
        length = 1.2, // overall length (Z)
        rings = 7, // number of cross-sections (>= 4)
        ringVerts = 8, // octagon per ring (closed volume)
        // half-width/half-height profile along the body (nose -> tail)
        profile = [
            { t: 0.0, w: 0.05, h: 0.04 }, // nose tip (small)
            { t: 0.15, w: 0.22, h: 0.17 }, // head/belly bulge
            { t: 0.35, w: 0.25, h: 0.18 }, // mid widest
            { t: 0.55, w: 0.18, h: 0.12 }, // tapering
            { t: 0.75, w: 0.11, h: 0.08 }, // peduncle (narrow before tail)
            { t: 0.92, w: 0.07, h: 0.06 }, // tail base
            { t: 1.0, w: 0.03, h: 0.03 } // tail tip (small round)
        ]
    } = opts;

    // helper: sample piecewise-linear width/height by t in [0,1]
    function sampleWH(t) {
        for (let i = 0; i < profile.length - 1; i++) {
            const a = profile[i],
                b = profile[i + 1];
            if (t >= a.t && t <= b.t) {
                const u = (t - a.t) / (b.t - a.t);
                return {
                    w: a.w + (b.w - a.w) * u,
                    h: a.h + (b.h - a.h) * u
                };
            }
        }
        const last = profile[profile.length - 1];
        return { w: last.w, h: last.h };
    }

    const verts = [];
    const idx = [];
    const halfL = length * 0.5;

    // Build rings (octagons) along +Z
    for (let i = 0; i < rings; i++) {
        const t = i / (rings - 1); // 0..1 from nose to tail
        const z = -halfL + t * length; // center at 0, forward +Z
        const { w, h } = sampleWH(t);

        for (let k = 0; k < ringVerts; k++) {
            const ang = (k / ringVerts) * Math.PI * 2.0; // 0..2π
            // ellipse scaled on X (width) and Y (height)
            const x = Math.cos(ang) * w;
            const y = Math.sin(ang) * h;
            verts.push(x, y, z);
        }
    }

    // Connect consecutive rings with quads (triangulated)
    const stride = ringVerts;
    for (let i = 0; i < rings - 1; i++) {
        const base = i * stride;
        const next = (i + 1) * stride;
        for (let k = 0; k < ringVerts; k++) {
            const a = base + k;
            const b = base + ((k + 1) % ringVerts);
            const c = next + k;
            const d = next + ((k + 1) % ringVerts);
            // two triangles per quad (consistent winding for outward normals)
            idx.push(a, b, c, b, d, c);
        }
    }

    // Nose cap (fan at ring 0)
    const noseCenterIndex = verts.length / 3;
    verts.push(0, 0, -halfL); // center at nose
    for (let k = 0; k < ringVerts; k++) {
        const a = k;
        const b = (k + 1) % ringVerts;
        idx.push(noseCenterIndex, b, a); // wind so normals point outward
    }

    // Tail cap (fan at last ring)
    const tailCenterIndex = verts.length / 3;
    verts.push(0, 0, +halfL); // center at tail
    const tailBase = (rings - 1) * stride;
    for (let k = 0; k < ringVerts; k++) {
        const a = tailBase + k;
        const b = tailBase + ((k + 1) % ringVerts);
        idx.push(tailCenterIndex, a, b);
    }

    const mesh = new Mesh('fishLowPoly', scene);
    const vd = new VertexData();
    vd.positions = verts;
    vd.indices = idx;
    const normals = [];
    VertexData.ComputeNormals(verts, idx, normals);
    vd.normals = normals;
    vd.applyToMesh(mesh);
    mesh.material = material;
    mesh.rotation.y = Tools.ToRadians(180);
    mesh.bakeCurrentTransformIntoVertices();
    return mesh;
}
function setupFishShader(scene) {
    class FishSinePlugin extends MaterialPluginBase {
        constructor(material) {
            super(material, 'FishSine', 200, { FISH: false });
            this._isEnabled = true;
            this._enable(true);
        }

        prepareDefines(defines) {
            defines.FISH = this._isEnabled;
        }

        getUniforms() {
            return {
                ubo: [
                    { name: 'fishTime', size: 1, type: 'float' },
                    { name: 'fishAmp', size: 1, type: 'float' },
                    { name: 'fishFreq', size: 1, type: 'float' },
                    { name: 'fishPhase', size: 1, type: 'float' }
                ]
            };
        }

        bindForSubMesh(ubo) {
            const FISH = this._material.getScene().FISH_PARAMS;
            ubo.updateFloat('fishTime', FISH.time);
            ubo.updateFloat('fishAmp', FISH.amp);
            ubo.updateFloat('fishFreq', FISH.freq);
            ubo.updateFloat('fishPhase', FISH.phase);
        }

        getCustomCode(shaderType) {
            if (shaderType !== 'vertex') return null;
            return {
                CUSTOM_VERTEX_UPDATE_POSITION: `
#ifdef FISH
  // Each fish wags locally along its +Z axis.
  float along = positionUpdated.z; // use the mutable version
  float taper = smoothstep(0.1, 1.0, along + 0.5); // stronger toward tail
  float wag = sin(along * fishFreq + fishTime + fishPhase + float(gl_VertexID) * 0.37)
              * fishAmp * taper;

  // apply offset
  positionUpdated.x += wag;
#endif
`
            };
        }
    }

    // --- Global fish shader params ---
    scene.FISH_PARAMS = {
        time: 0,
        amp: 0.08,
        freq: 10.0,
        phase: 0.0
    };

    scene.onBeforeRenderObservable.add(() => {
        scene.FISH_PARAMS.time = performance.now() * 0.001 * 3.0;
    });

    scene.wrapWithFishSine = (mat) => {
        if (!mat._fishPlugin) {
            mat._fishPlugin = new FishSinePlugin(mat);
        }
        return mat;
    };
}

// --- Simple colored material helper ----------------------------------------
function makeFishMat(scene, color) {
    const m = new StandardMaterial('m_fish', scene);
    m.disableLighting = true;
    m.emissiveColor = color;
    m.specularColor = Color3.Black();
    m.backFaceCulling = false;
    scene.wrapWithFishSine(m);
    return m;
}
class FishSystemCute {
    constructor(scene, waterMesh, islandMesh, opts = {}) {
        this.scene = scene;
        this.waterY = waterMesh.position.y;
        this.islandRadius = opts.noSwimRadius || 30;
        this.bounds = opts.bounds || 60;
        this.depth = opts.depthRange || [1.2, 3.5];
        this.count = opts.numFish || 40;
        this.fish = [];
        this.spawnFish();
        scene.onBeforeRenderObservable.add(() => this.update());
    }

    makeFishMat(color) {
        const mat = new StandardMaterial('m_fish', this.scene);
        mat.disableLighting = true;
        mat.emissiveColor = color;
        mat.backFaceCulling = false;
        this.scene.wrapWithFishSine(mat);
        return mat;
    }

    spawnFish() {
        const { scene } = this;
        for (let i = 0; i < this.count; i++) {
            const hue = Math.random();
            const color = Color3.FromHSV(hue, 0.9, 1.0);
            const fish = makeLowPolyFish(scene, this.makeFishMat(color), {
                length: 1.0 + Math.random() * 0.4
            });

            // proper orientation: face +Z (forward)
            fish.rotation.set(0, Math.random() * Math.PI * 2, 0);

            // spawn outside island
            let p;
            do {
                p = new Vector3((Math.random() - 0.5) * this.bounds * 2, this.waterY - Scalar.Lerp(this.depth[0], this.depth[1], Math.random()), (Math.random() - 0.5) * this.bounds * 2);
            } while (p.length() < this.islandRadius);
            fish.position.copyFrom(p);

            // direction (XZ)
            const dir = new Vector3(Math.sin(fish.rotation.y), 0, Math.cos(fish.rotation.y));
            this.fish.push({
                mesh: fish,
                dir,
                speed: 0.6 + Math.random() * 0.3,
                turnRate: 0.6 + Math.random() * 0.3
            });
        }
    }

    update() {
        const dt = this.scene.getEngine().getDeltaTime() * 0.001;
        const t = performance.now() * 0.001;

        for (const f of this.fish) {
            const mesh = f.mesh;

            // gentle wandering: tiny random yaw perturbation
            const turn = (Math.random() - 0.5) * f.turnRate * dt;
            const sinY = Math.sin(turn),
                cosY = Math.cos(turn);
            const newDir = new Vector3(f.dir.x * cosY - f.dir.z * sinY, 0, f.dir.x * sinY + f.dir.z * cosY).normalize();
            f.dir.copyFrom(newDir);

            // move forward along +Z local
            mesh.position.addInPlace(f.dir.scale(f.speed * dt));

            // island + boundary avoidance
            const len = mesh.position.length();
            if (len < this.islandRadius * 0.9 || len > this.bounds) {
                const away = mesh.position.normalize();
                f.dir = Vector3.Lerp(f.dir, away, 0.2).normalize();
            }

            // orient mesh so it faces velocity
            mesh.rotation.y = Math.atan2(f.dir.x, f.dir.z);

            // smooth vertical bobbing
            mesh.position.y = this.waterY - Scalar.Lerp(this.depth[0], this.depth[1], Math.sin(t * 0.4 + mesh.uniqueId * 1.3) * 0.5 + 0.5);
        }
    }
}

function setupTrees(scene) {
    // ======================================================
    // 🎨 MATERIALS — flat / bright PBR + wind on foliage
    // ======================================================
    const wrapWind = scene.wrapWithWindSway || ((m) => m); // safe fallback if wind wrapper isn't present
    // ======================================================
    // 🎨 Base helper
    // ======================================================

    const wrap = (m) => (typeof wrapWind === 'function' ? wrapWind(m) : m);

    // ======================================================
    // 🎨 Define material presets (data-driven)
    // ======================================================
    function color3(hex) {
        const c = COLORS[hex] || '#ffffff';
        const num = parseInt(c.slice(1), 16);
        return new Color3(((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255);
    }

    function tuneFlatPBR(mat, { color = new Color3(1, 1, 1), doubleSided = true, unlit = true } = {}) {
        mat.albedoColor = color;
        mat.metallic = 0.0;
        mat.roughness = 1.0;
        mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
        mat.backFaceCulling = !doubleSided;
        return mat;
    }

    // ======================================================
    // 🌈 Material definitions (using COLORS palette)
    // ======================================================

    const defs = {
        trunk: {
            color: color3('yellowyBrown'),
            doubleSided: false,
            unlit: false,
            wrap: false
        },
        leaf: {
            color: color3('kermitGreen'),
            doubleSided: true,
            unlit: true,
            wrap: true
        },
        fruit: {
            color: color3('orangePink'),
            doubleSided: true,
            unlit: true,
            wrap: true
        },
        cone: {
            color: color3('lightMaroon'),
            doubleSided: true,
            unlit: true,
            wrap: true
        },
        flower: {
            color: color3('redViolet'),
            doubleSided: true,
            unlit: true,
            wrap: true
        },
        rock: {
            color: color3('greyblue'),
            doubleSided: false,
            unlit: false,
            wrap: false
        },
        ground: {
            color: color3('yellowyBrown'),
            doubleSided: false,
            unlit: false,
            wrap: false
        },
        sand: {
            color: color3('fadedOrange'),
            doubleSided: false,
            unlit: true,
            wrap: false
        },
        water: {
            color: color3('brightSkyBlue'),
            doubleSided: true,
            unlit: false,
            wrap: false
        }
    };
    // ======================================================
    // 🧱 Construct and tune all materials
    // ======================================================
    const MAT = {};

    for (const [name, def] of Object.entries(defs)) {
        const m = new PBRMaterial(`m_${name}`, scene);
        tuneFlatPBR(m, def);
        if (def.wrap) wrap(m);

        // minor special cases
        if (name === 'water') {
            m.metallic = 0.2;
            m.roughness = 0.2;
        }
        if (name === 'leaf') {
            m.forceNormalForward = true;
        }

        MAT[name] = m;
    }

    // ======================================================
    // 🌐 Cache globally
    // ======================================================
    window.GLOBAL_CACHE = window.GLOBAL_CACHE || {};
    window.GLOBAL_CACHE.MAT = MAT;
}

export var createScene = function (engine, canvas) {
    const scene = new Scene(engine);
    // Optional: tweak clear color to match horizon
    scene.clearColor = new Color4(1, 0.8, 0.95, 1);
    window.GLOBAL_CACHE.scene = scene;
    scene.environmentIntensity = -5;
    setupWindShader(scene);

    // --- Mobile: ArcRotateCamera for touch orbit ---
    const target = new Vector3(0, 0.5, 0); // center of island
    const radius = 120; // zoom distance so whole island fits with padding
    const alpha = Math.PI / 4; // around from diagonal
    const beta = Math.PI / 2.4; // slightly above horizon

    const camera = new ArcRotateCamera('Cam', alpha, beta, radius, target, scene);
    // camera.maxZ = 2000
    camera.attachControl(canvas, true);

    window.addEventListener('YEEHDOH_START', () => {
        if (!camera) return;

        // Zoom in (reduce radius)
        const zoomAnim = new Animation('cameraZoomIn', 'radius', 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);

        zoomAnim.setKeys([
            { frame: 0, value: camera.radius },
            { frame: 90, value: camera.radius * 0.55 }
        ]);

        // Slight tilt toward island
        const tiltAnim = new Animation('cameraTiltDown', 'beta', 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);

        tiltAnim.setKeys([
            { frame: 0, value: camera.beta },
            { frame: 90, value: camera.beta * 0.9 }
        ]);

        const easing = new CubicEase();
        easing.setEasingMode(EasingFunction.EASINGMODE_EASEOUT);
        zoomAnim.setEasingFunction(easing);
        tiltAnim.setEasingFunction(easing);

        camera.animations = [zoomAnim, tiltAnim];
        scene.beginAnimation(camera, 0, 90, false);
    });

    // Touch-friendly adjustments
    camera.lowerRadiusLimit = 2;
    camera.upperRadiusLimit = 500;
    // camera.wheelPrecision = 80; // slow zoom
    // camera.panningSensibility = 0; // disable drag-pan (rotate only)
    camera.inertia = 0.8; // smoother orbit feel
    camera.angularSensibilityX = 2500; // swipe sensitivity
    camera.angularSensibilityY = 2500;

    // Prevent page scrolling on touch gestures
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    camera.attachControl(canvas, true);
    const hemi = new HemisphericLight('light', new Vector3(0.2, 1, 0.1), scene);
    hemi.intensity = 0.3;
    // // === Parameters ===
    // const SIZE = 100,
    //     SUB = 128,
    //     N = SUB + 1;
    // const SEEDS = 8,
    //     ITER = Math.ceil(Math.log2(N));

    // // === 1️⃣ Random seeds for jump flood ===
    // const seedX = [],
    //     seedY = [];
    // for (let i = 0; i < SEEDS; i++) {
    //     seedX.push(Math.random() * N);
    //     seedY.push(Math.random() * N);
    // }

    // // === 2️⃣ Jump Flood Distance (simple scalar field) ===
    // const near = new Float32Array(N * N).fill(1e9);
    // const idx = (x, y) => y * N + x;
    // for (let i = 0; i < SEEDS; i++) near[idx(Math.floor(seedX[i]), Math.floor(seedY[i]))] = 0;
    // let step = N / 2;
    // while (step >= 1) {
    //     for (let y = 0; y < N; y++) {
    //         for (let x = 0; x < N; x++) {
    //             const i = idx(x, y);
    //             let best = near[i];
    //             for (let dy = -1; dy <= 1; dy++) {
    //                 for (let dx = -1; dx <= 1; dx++) {
    //                     const nx = Math.floor(x + dx * step),
    //                         ny = Math.floor(y + dy * step);
    //                     if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
    //                     const n = near[idx(nx, ny)] + Math.hypot(dx * step, dy * step);
    //                     if (n < best) best = n;
    //                 }
    //             }
    //             near[i] = best;
    //         }
    //     }
    //     step /= 2;
    // }

    // // === 3️⃣ Multiscale sine noise (rotated + phased) ===
    // function multiSine(x, z) {
    //     let n = 0,
    //         amp = 1,
    //         freq = 1,
    //         rot = 0.5;
    //     for (let o = 0; o < 5; o++) {
    //         const a = freq * 0.25;
    //         const px = x * a * Math.cos(rot) - z * a * Math.sin(rot);
    //         const pz = x * a * Math.sin(rot) + z * a * Math.cos(rot);
    //         n += (Math.sin(px + 3.1 * o) + Math.sin(pz + 1.7 * o)) * 0.5 * amp;
    //         freq *= 1.9;
    //         amp *= 0.55;
    //         rot += 1.1; // change rotation per octave
    //     }
    //     return n;
    // }
    // // === 4️⃣ Build heightmap ===
    // const pos = new Float32Array(N * N * 3);
    // const cols = new Float32Array(N * N * 4);

    // let p = 0,
    //     c = 0;
    // const maxD = (Math.sqrt(2) * N) / 2;

    // // --- 🗺️ Terrain color sampler for vegetation ---
    // scene.getGroundColor = function (x, z) {
    //     // normalize to grid space
    //     const xn = (x / SIZE + 0.5) * (N - 1);
    //     const zn = (z / SIZE + 0.5) * (N - 1);

    //     const xi = Math.floor(xn);
    //     const zi = Math.floor(zn);
    //     if (xi < 0 || zi < 0 || xi >= N - 1 || zi >= N - 1) {
    //         return new Color3(0.5, 0.5, 0.5);
    //     }

    //     const lerp = (a, b, t) => a + (b - a) * t;
    //     const cAt = (x, z) => {
    //         const i = (z * N + x) * 4;
    //         return new Color3(cols[i], cols[i + 1], cols[i + 2]);
    //     };

    //     const tx = xn - xi;
    //     const tz = zn - zi;

    //     const c00 = cAt(xi, zi);
    //     const c10 = cAt(xi + 1, zi);
    //     const c01 = cAt(xi, zi + 1);
    //     const c11 = cAt(xi + 1, zi + 1);

    //     // bilinear interpolate colors
    //     const r = lerp(lerp(c00.r, c10.r, tx), lerp(c01.r, c11.r, tx), tz);
    //     const g = lerp(lerp(c00.g, c10.g, tx), lerp(c01.g, c11.g, tx), tz);
    //     const b = lerp(lerp(c00.b, c10.b, tx), lerp(c01.b, c11.b, tx), tz);
    //     return new Color3(r, g, b);
    // };

    // // Convenience: derive humidity (0 = dry, 1 = lush)
    // scene.getAridity = function (x, z) {
    //     const c = scene.getGroundColor(x, z);
    //     // bluer / greener = wetter; more red/yellow = drier
    //     const wet = c.g + c.b * 0.5;
    //     const dry = c.r;
    //     return Scalar.Clamp(1.0 - (dry - wet + 0.5), 0, 1);
    // };

    // // helper functions
    // function smoothstep(a, b, t) {
    //     t = Math.min(1, Math.max(0, (t - a) / (b - a)));
    //     return t * t * (3 - 2 * t);
    // }
    // function maskNoise(xn, zn) {
    //     return (Math.sin(xn * 12.3) + Math.sin(zn * 15.7)) * 0.25;
    // }

    // for (let y = 0; y < N; y++) {
    //     for (let x = 0; x < N; x++) {
    //         const xn = x / N - 0.5; // normalized X [-0.5, 0.5]
    //         const zn = y / N - 0.5; // normalized Z [-0.5, 0.5]
    //         const wx = xn * SIZE;
    //         const wz = zn * SIZE;
    //         const d = near[idx(x, y)] / maxD;

    //         // --- island shape (jump-flood + radial bias) ---
    //         let island = Math.max(0, 1 - d * 1.8);
    //         island = Math.pow(island, 2.5); // smoother core

    //         // --- multiscale sine noise ---
    //         let n = multiSine(x, y);

    //         // --- base height (more dramatic) ---
    //         let base = island + n * 0.3 * (island + 0.2);
    //         base = Math.sign(base) * Math.pow(Math.abs(base), 1.3);
    //         let h = base * 4.2; // main amplitude boost

    //         // === circular falloff (lowers terrain, not flattens) ===
    //         const r = Math.sqrt(xn * xn + zn * zn);
    //         const noise = maskNoise(xn, zn) * 0.15;
    //         const radius = 0.45 + noise; // outer fade radius
    //         const fadeStart = 0.35 + noise * 0.5;
    //         const t = Math.min(1, Math.max(0, (r - fadeStart) / (radius - fadeStart)));
    //         const fade = Math.exp(-5.0 * t * t);

    //         // instead of scaling, lower terrain outward
    //         const falloff = (1.0 - fade) * 8.0; // depth at outer rim
    //         h -= falloff;

    //         // === smooth waterline depression ===
    //         const waterLevel = 0.2;
    //         const shoreWidth = 5.4;
    //         const shoreDepth = 6.0;
    //         let dh = h - waterLevel;
    //         let shoreFade = Math.min(1, Math.max(0, (dh + shoreWidth) / shoreWidth));
    //         shoreFade = shoreFade * shoreFade * (3 - 2 * shoreFade);
    //         if (dh < shoreWidth) {
    //             const punch = (1 - shoreFade) * shoreDepth;
    //             h -= punch;
    //         }

    //         // === deep-sea exaggeration ===
    //         if (h < waterLevel) {
    //             const t2 = (waterLevel - h) / waterLevel;
    //             h -= t2 * 2.5; // make seafloor deeper
    //         }

    //         // === store position + color ===
    //         pos[p++] = wx;
    //         pos[p++] = h;
    //         pos[p++] = wz;

    //         // simple vertex color gradient by height
    //         let rC = 0.6,
    //             gC = 0.85,
    //             bC = 0.6;
    //         if (h < 0.2) {
    //             // underwater
    //             rC = 0.4;
    //             gC = 0.6;
    //             bC = 0.9;
    //         } else if (h < 1.0) {
    //             // shoreline
    //             rC = 0.55;
    //             gC = 0.8;
    //             bC = 0.65;
    //         } else if (h < 2.0) {
    //             // hills
    //             rC = 0.8;
    //             gC = 0.7;
    //             bC = 0.45;
    //         } else {
    //             // peaks
    //             rC = 0.7;
    //             gC = 0.6;
    //             bC = 0.6;
    //         }
    //         cols[c++] = rC;
    //         cols[c++] = gC;
    //         cols[c++] = bC;
    //         cols[c++] = 1.0;
    //     }
    // }

    // // === 5️⃣ Triangles ===
    // const idxs = [];
    // for (let y = 0; y < SUB; y++) {
    //     for (let x = 0; x < SUB; x++) {
    //         const i = y * N + x;
    //         idxs.push(i, i + 1, i + N, i + 1, i + N + 1, i + N);
    //     }
    // }

    // const mesh = new Mesh('island', scene);
    // const vd = new VertexData();
    // vd.positions = pos;
    // vd.indices = idxs;
    // vd.colors = cols;
    // vd.normals = [];
    // VertexData.ComputeNormals(pos, idxs, vd.normals);
    // vd.applyToMesh(mesh);

    // const mat = new StandardMaterial('mat', scene);
    // mat.vertexColorUsed = true;
    // mat.specularColor = Color3.Black();
    // mat.useFlatShading = true;
    // mesh.material = mat;

    // // --- 🌞 Add sunlight and shadows (minimal) ---
    // const sun = new DirectionalLight('sun', new Vector3(-1, -2, -1), scene);
    // sun.position = new Vector3(50, 100, 0);
    // // --- ☁️ Soft, low-res shadows ---
    // const shadowGen = new ShadowGenerator(1024, sun); // lower res = faster & softer
    // shadowGen.useBlurExponentialShadowMap = true; // softer penumbra blur
    // shadowGen.blurKernel = 4; // increase for softness
    // shadowGen.blurScale = 5.0; // 1 = moderate blur, >1 = more diffuse
    // shadowGen.setDarkness(0.4);
    // shadowGen.bias = 0.001;
    // shadowGen.normalBias = 0.01;
    // // --- 🪴 Automatically register all new meshes as shadow casters if desired ---
    // scene.onNewMeshAddedObservable.add((m) => {
    //     // skip invisible meshes or water
    //     if (!m || m === mesh || m.name.toLowerCase().includes('water') || m.name.toLowerCase().includes('fish')) return;

    //     // heuristics: only cast shadows if not flat ground
    //     if (m.isVisible && m.getTotalVertices() > 0 && !shadowGen.getShadowMap().renderList.includes(m)) {
    //         shadowGen.addShadowCaster(m, true);
    //     }
    // });
    // // Island receives shadows
    // mesh.receiveShadows = true;

    // Water plane

    //     // Create water as circular mesh
    //     const water = createCircularWater('water', 1024, 256, 256, scene);
    //     water.position.y = 0;

    //     // Custom shaders
    //     Effect.ShadersStore['customVertexShader'] = `
    //         precision highp float;
    //         attribute vec3 position;
    //         attribute vec2 uv;
    //         uniform mat4 worldViewProjection;
    //         uniform float time;
    //         out float newY;
    //         varying vec3 vPosition;
    //         varying vec4 vClipSpace;

    //         void main(void) {
    //             // === Water surface waves ===
    // float scale = 6.0;       // wavelength (~6 units)
    // float amp   = 0.07;      // amplitude (~7 cm visually)
    // float speed = 1.2;       // time multiplier

    // // combine 2 angled waves for variety
    // float wave1 = sin((position.x + position.z) / scale + time * speed);
    // float wave2 = sin((position.x - position.z) / (scale * 1.3) + time * speed * 1.1);
    // newY = (wave1 + wave2) * 0.5 * amp;

    // vec3 newPositionM = vec3(position.x, newY, position.z);
    // gl_Position = worldViewProjection * vec4(newPositionM, 1.0);
    //             vPosition = position;
    //             vClipSpace = gl_Position;
    //         }
    //     `;

    //     Effect.ShadersStore['customFragmentShader'] = `
    //         precision highp float;
    //         varying vec3 vPosition;
    //         varying vec4 vClipSpace;
    //         uniform sampler2D depthTex;
    //         uniform sampler2D refractionSampler;
    //         uniform float camMinZ;
    //         uniform float camMaxZ;
    //         uniform float maxDepth;
    //         uniform vec4 wFoamColor;
    //         uniform vec4 wDeepColor;
    //         uniform vec4 wShallowColor;
    //         uniform float time;
    //         uniform float wNoiseScale;
    //         uniform float wNoiseOffset;
    //         uniform float fNoiseScale;
    //         in float newY;

    //         float mod289(float x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
    //         vec4 mod289(vec4 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
    //         vec4 perm(vec4 x){return mod289(((x * 34.0) + 1.0) * x);}

    //         float noise(vec3 p){
    //             vec3 a = floor(p);
    //             vec3 d = p - a;
    //             d = d * d * (3.0 - 2.0 * d);
    //             vec4 b = a.xxyy + vec4(0.0, 1.0, 0.0, 1.0);
    //             vec4 k1 = perm(b.xyxy);
    //             vec4 k2 = perm(k1.xyxy + b.zzww);
    //             vec4 c = k2 + a.zzzz;
    //             vec4 k3 = perm(c);
    //             vec4 k4 = perm(c + 1.0);
    //             vec4 o1 = fract(k3 * (1.0 / 41.0));
    //             vec4 o2 = fract(k4 * (1.0 / 41.0));
    //             vec4 o3 = o2 * d.z + o1 * (1.0 - d.z);
    //             vec2 o4 = o3.yw * d.x + o3.xz * (1.0 - d.x);
    //             return o4.y * d.y + o4.x * (1.0 - d.y);
    //         }

    //         void main(void) {
    //             float waveNoise = noise(vec3(0., time, 0.) + vPosition * wNoiseScale) * wNoiseOffset;
    //             vec2 ndc = (vClipSpace.xy / vClipSpace.w) / 2.0 + 0.5;
    //             float depthOfObjectBehindWater = texture2D(depthTex, vec2(ndc.x, ndc.y) + waveNoise).r;
    //             float linearWaterDepth = (vClipSpace.z + camMinZ) / (camMaxZ + camMinZ);
    //             float waterDepth = camMaxZ * (depthOfObjectBehindWater - linearWaterDepth);
    //             float wdepth = clamp((waterDepth / maxDepth), 0.0, 1.0);

    //             // soft fade at the shoreline
    //             float fadeDistance = 0.15;
    //             float shoreFade = smoothstep(0.0, fadeDistance, wdepth + newY * 0.5);

    //             vec4 refractiveColor = texture2D(refractionSampler, vec2(ndc.x, ndc.y) + waveNoise + newY);

    //             // foam
    //             float foam = 1.0 - smoothstep(0.1, 0.2, wdepth);
    //             float foamEffect = smoothstep(0.1, 0.2, noise(vec3(0., time, 0.) + vPosition * fNoiseScale * 0.3) * foam);
    //             vec4 foamColor = vec4(foamEffect) * 0.5;

    //             // color blending
    //           // === Depth-based underwater fade ===
    //             float visibility = exp(-2.5 * wdepth);
    //             // exponential fade with adjustable falloff
    //             // lower uWaterFalloff → clearer water
    //             // higher uWaterFalloff → murkier / faster fade

    // // Blend the refraction (terrain) with the deep color
    // // When deep, refraction fades out and deep color dominates
    // vec3 fogged = mix(wDeepColor.rgb, refractiveColor.rgb, visibility);

    // // Combine shallow-to-deep blend for overall hue
    // vec3 finalRGB = mix(wShallowColor.rgb, fogged, wdepth);

    // // Foam and shoreline as before
    // finalRGB = mix(wFoamColor.rgb, finalRGB, 1.0 - foamColor.r);

    // // --- Keep alpha roughly constant (no transparency fade) ---
    // float finalAlpha = .9; // you can tweak to 0.6–1.0 depending on look

    // gl_FragColor = vec4(finalRGB, finalAlpha);
    //         }
    //     `;
    //     Effect.ShadersStore['customFragmentShader'] = `
    // precision highp float;
    // varying vec3 vPosition;
    // varying vec4 vClipSpace;

    // uniform sampler2D depthTex;
    // uniform sampler2D refractionSampler;
    // uniform float camMinZ;
    // uniform float camMaxZ;
    // uniform float maxDepth;

    // uniform vec4 wFoamColor;
    // uniform vec4 wDeepColor;
    // uniform vec4 wShallowColor;

    // uniform float time;
    // uniform float wNoiseScale;
    // uniform float wNoiseOffset;
    // uniform float fNoiseScale;
    // in float newY;

    // float mod289(float x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
    // vec4 mod289(vec4 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
    // vec4 perm(vec4 x){return mod289(((x * 34.0) + 1.0) * x);}
    // float noise(vec3 p){
    //   vec3 a = floor(p);
    //   vec3 d = p - a;
    //   d = d * d * (3.0 - 2.0 * d);
    //   vec4 b = a.xxyy + vec4(0.0, 1.0, 0.0, 1.0);
    //   vec4 k1 = perm(b.xyxy);
    //   vec4 k2 = perm(k1.xyxy + b.zzww);
    //   vec4 c = k2 + a.zzzz;
    //   vec4 k3 = perm(c);
    //   vec4 k4 = perm(c + 1.0);
    //   vec4 o1 = fract(k3 * (1.0 / 41.0));
    //   vec4 o2 = fract(k4 * (1.0 / 41.0));
    //   vec4 o3 = o2 * d.z + o1 * (1.0 - d.z);
    //   vec2 o4 = o3.yw * d.x + o3.xz * (1.0 - d.x);
    //   return o4.y * d.y + o4.x * (1.0 - d.y);
    // }

    // void main(void) {
    //   float waveNoise = noise(vec3(0., time, 0.) + vPosition * wNoiseScale) * wNoiseOffset;
    //   vec2 ndc = (vClipSpace.xy / vClipSpace.w) / 2.0 + 0.5;

    //   float depthBehind = texture2D(depthTex, ndc + waveNoise).r;
    //   float linearWaterDepth = (vClipSpace.z + camMinZ) / (camMaxZ + camMinZ);
    //   float waterDepth = camMaxZ * (depthBehind - linearWaterDepth);
    //   float wdepth = clamp((waterDepth / maxDepth), 0.0, 1.0);

    //   bool isUnder = !gl_FrontFacing;

    //   vec2 refrOffset = waveNoise * vec2((isUnder ? -6.0 : 6.0), (isUnder ? -4.0 : 4.0));
    // vec4 refrColor = texture(refractionSampler, ndc + refrOffset + vec2(newY * 0.5));

    //   if (!isUnder) {
    //     // Above surface: brighter and foamy
    //     float visibility = exp(-3.5 * wdepth);
    //     vec3 fogged = mix(wDeepColor.rgb, refrColor.rgb, visibility);
    //     vec3 color = mix(wShallowColor.rgb, fogged, wdepth);
    //     float foam = 1.0 - smoothstep(0.05, 0.2, wdepth);
    //     float foamNoise = noise(vec3(vPosition.xz * fNoiseScale, time * 0.7));
    //     color = mix(color, wFoamColor.rgb, foam * foamNoise * 0.5);
    //     gl_FragColor = vec4(color, 0.9);
    //   } else {
    //     // Below surface: refracted and bluish but transparent
    //     float scatter = exp(-abs(vPosition.y) * 0.25);
    //     vec3 base = mix(wDeepColor.rgb * 0.8, wShallowColor.rgb * 1.2, scatter);
    //     // Mix refracted world with underwater haze
    //     vec3 color = mix(base, refrColor.rgb, 0.7);
    //     gl_FragColor = vec4(color, 0.7);
    //   }
    // }
    // `;

    //     // Shader material
    //     var shaderMaterial = new ShaderMaterial(
    //         'shader',
    //         scene,
    //         { vertex: 'custom', fragment: 'custom' },
    //         {
    //             attributes: ['position', 'normal', 'uv'],
    //             uniforms: ['world', 'worldView', 'worldViewProjection', 'view', 'projection']
    //         }
    //     );

    //     shaderMaterial.backFaceCulling = false;

    //     // Depth renderer
    //     var depthRenderer = scene.enableDepthRenderer(scene.activeCamera, false);
    //     var depthTex = depthRenderer.getDepthMap();

    //     // Refraction RTT
    //     var _refractionRTT = new RenderTargetTexture('water_refraction', { width: 256, height: 256 }, scene, false, true);
    //     _refractionRTT.wrapU = Constants.TEXTURE_MIRROR_ADDRESSMODE;
    //     _refractionRTT.wrapV = Constants.TEXTURE_MIRROR_ADDRESSMODE;
    //     _refractionRTT.ignoreCameraViewport = true;
    //     _refractionRTT.refreshRate = 1;
    //     _refractionRTT.renderList = depthTex.renderList = [mesh];

    //     scene.customRenderTargets.push(_refractionRTT);

    //     // Shader parameters
    //     shaderMaterial.setTexture('depthTex', depthTex);
    //     shaderMaterial.setTexture('refractionSampler', _refractionRTT);
    //     shaderMaterial.setFloat('camMinZ', scene.activeCamera.minZ);
    //     shaderMaterial.setFloat('camMaxZ', scene.activeCamera.maxZ);
    //     shaderMaterial.setFloat('time', 0);
    //     shaderMaterial.setFloat('wNoiseScale', 0.25); // much lower frequency
    //     shaderMaterial.setFloat('wNoiseOffset', 0.02); // slightly stronger effect
    //     shaderMaterial.setFloat('fNoiseScale', 1.5); // gentler foam noise
    //     shaderMaterial.setFloat('maxDepth', 5.0);
    //     shaderMaterial.setVector4('wDeepColor', new Vector4(0.0, 0.3, 0.5, 0.8));
    //     shaderMaterial.setVector4('wShallowColor', new Vector4(0.0, 0.6, 0.8, 0.8));
    //     shaderMaterial.setVector4('wFoamColor', new Vector4(1, 1, 1, 1));
    //     shaderMaterial.alpha = 0.5;

    //     // Animate
    //     var time = 0;
    //     scene.registerBeforeRender(function () {
    //         time += engine.getDeltaTime() * 0.001;
    //         shaderMaterial.setFloat('time', time);
    //     });

    //     water.material = shaderMaterial;
    setupTrees(scene);

    // Build 3 messy variants once and keep them hidden for reuse

    window.GLOBAL_CACHE.WindMats = (() => {
        const wrap = (m) => scene.wrapWithWindSway(m);

        const baseLeaf = wrap(window.GLOBAL_CACHE.MAT.leaf.clone('leaf_base'));
        const darkLeaf = wrap(window.GLOBAL_CACHE.MAT.leaf.clone('leaf_dark'));
        darkLeaf.albedoColor = new Color3(0.1, 0.6, 0.1);

        const baseTrunk = wrap(window.GLOBAL_CACHE.MAT.trunk.clone('trunk_base'));
        const darkTrunk = wrap(window.GLOBAL_CACHE.MAT.trunk.clone('trunk_dark'));
        darkTrunk.albedoColor = new Color3(0.35, 0.25, 0.15);

        const fruitMat = wrap(window.GLOBAL_CACHE.MAT.fruit.clone('fruit_base'));
        const coneMat = wrap(window.GLOBAL_CACHE.MAT.cone.clone('cone_base'));

        return {
            leafs: [baseLeaf, darkLeaf],
            trunks: [baseTrunk, darkTrunk],
            fruits: [fruitMat, coneMat]
        };
    })();

    // // create 2–3 reusable unique frond meshes with variation
    // window.GLOBAL_CACHE.frondModels = [
    //     makePalmFrond(scene, window.GLOBAL_CACHE.MAT.leaf, {
    //         length: 3.5,
    //         maxWidth: 0.55,
    //         pinnae: 22,
    //         droop: 0.7,
    //         bendForward: 0.35,
    //         tearChance: 0.12,
    //         randomness: 0.2
    //     }),

    //     makePalmFrond(scene, window.GLOBAL_CACHE.MAT.leaf, {
    //         length: 4.0,
    //         pinnae: 28,
    //         maxWidth: 0.6,
    //         droop: 0.9,
    //         bendForward: 0.5,
    //         shapePower: 1.6,
    //         tearChance: 0.18,
    //         randomness: 0.3
    //     }),

    //     makePalmFrond(scene, window.GLOBAL_CACHE.MAT.leaf, {
    //         length: 3.0,
    //         pinnae: 20,
    //         maxWidth: 0.5,
    //         droop: 0.65,
    //         bendForward: 0.25,
    //         tearChance: 0.25,
    //         tearDepth: 0.6,
    //         randomness: 0.4
    //     })
    // ];
    // window.GLOBAL_CACHE.frondModels.forEach((f) => f.setEnabled(false));

    // Plants.growForest({ scene }, new Vector3(0, 0, 0), 40, 130, mesh);

    function addRandomPlant() {
        const radius = 40;
        const x = (Math.random() - 0.5) * radius * 2;
        const z = (Math.random() - 0.5) * radius * 2;

        // raycast downward to find ground
        const ray = new Ray(new Vector3(x, 50, z), Vector3.Down(), 100);
        const pick = scene.pickWithRay(ray, (m) => m === mesh);
        if (!pick?.hit) return;

        const pos = pick.pickedPoint.clone();
        if (pos.y < 0.25) return;

        const normal = pick.getNormal(true, true);
        if (normal?.y < 0.75) return;

        // fertility context
        function simpleNoise2D(x, z) {
            return Math.sin(x * 0.11 + z * 0.07) + Math.sin(x * 0.05 - z * 0.13);
        }
        const n = simpleNoise2D(pos.x, pos.z);
        const altitude = pos.y;
        const food = Scalar.Clamp((0.6 + n * 0.4) * Scalar.SmoothStep(0.1, 1.5, 2.2 - altitude), 0, 1);
        const ctx = { altitude, food, moisture: (n + 2) / 4, fertility: food };

        // choose random plant type depending on fertility
        const r = Math.random();
        let p;

        if (ctx.food < 0.35) {
            if (r < 0.6) p = new Plants.Palm(scene, pos, ctx);
            else p = new Plants.Bush(scene, pos, ctx);
        } else if (ctx.food < 0.7) {
            if (r < 0.3) p = new Plants.Palm(scene, pos, ctx);
            else if (r < 0.75) p = new Plants.Tree(scene, pos, ctx);
            else p = new Plants.Bush(scene, pos, ctx);
        } else {
            if (r < 0.4) p = new Plants.Tree(scene, pos, ctx);
            else if (r < 0.7) p = new Plants.Palm(scene, pos, ctx);
            else if (r < 0.9) p = new Plants.FlowerCluster(scene, pos, ctx);
            else p = new Plants.Flower(scene, pos, ctx);
        }

        // animate appearance
        const s = 3.5 + ctx.food * 3.5;
        p.group.scaling.setAll(0);
        Plants.Animate.popScale(p.group, 35);
        p.group.scaling.setAll(s);
    }
    // setupIslandFog(scene, mesh, 400);
    let biome = new Biome(biomes.volcanic, scene);
    biome.populate();

    // 🧠 SPACEBAR for desktop
    window.addEventListener('keydown', (ev) => {
        if (ev.code === 'Space') addRandomPlant();
    });

    scene.onPointerObservable.add((pointerInfo) => {
        if (pointerInfo.type !== PointerEventTypes.POINTERTAP) return;

        const evt = pointerInfo.event;

        // === Click-to-plant only on tap ===
        const pickRay = scene.createPickingRay(evt.clientX, evt.clientY, Matrix.Identity(), camera);
        const groundPick = scene.pickWithRay(pickRay, (m) => m.name === 'island');

        if (!groundPick?.hit) return;

        const pos = groundPick.pickedPoint.clone();
        const normal = groundPick.getNormal(true, true);

        // only upward-facing surface
        if (normal?.y < 0.5) return;

        // compute fertility context
        function simpleNoise2D(x, z) {
            return Math.sin(x * 0.11 + z * 0.07) + Math.sin(x * 0.05 - z * 0.13);
        }
        const n = simpleNoise2D(pos.x, pos.z);
        const altitude = pos.y;
        const food = Scalar.Clamp((0.6 + n * 0.4) * Scalar.SmoothStep(0.1, 1.5, 2.2 - altitude), 0, 1);
        const ctx = { altitude, food, moisture: (n + 2) / 4, fertility: food };

        // random plant selection
        const r = Math.random();
        let p;

        if (ctx.food < 0.35) {
            if (r < 0.6) p = new Plants.Palm(scene, pos, ctx);
            else p = new Plants.Bush(scene, pos, ctx);
        } else if (ctx.food < 0.7) {
            if (r < 0.3) p = new Plants.Palm(scene, pos, ctx);
            else if (r < 0.75) p = new Plants.Tree(scene, pos, ctx);
            else p = new Plants.Bush(scene, pos, ctx);
        } else {
            if (r < 0.4) p = new Plants.Tree(scene, pos, ctx);
            else if (r < 0.7) p = new Plants.Palm(scene, pos, ctx);
            else if (r < 0.9) p = new Plants.FlowerCluster(scene, pos, ctx);
            else p = new Plants.Flower(scene, pos, ctx);
        }

        // animate appearance
        const s = 3.5 + ctx.food * 3.5;
        p.group.scaling.setAll(0);
        Plants.Animate.popScale(p.group, 35);
        p.group.scaling.setAll(s);
    });

    setupFishShader(scene);
    // const fishies = new FishSystemCute(scene, water, mesh, {
    //     numFish: 80,
    //     noSwimRadius: 32,
    //     depthRange: [1.0, 3.8],
    //     bounds: 60
    // });

    return scene;
};

// ======================================================
// 🌊 Radially Subdivided Circular Water Mesh
// ======================================================
function createCircularWater(name, radius = 128, radialSegments = 80, ringSegments = 80, scene) {
    const positions = [];
    const indices = [];
    const uvs = [];

    // Generate vertices in concentric rings
    // Use exponential spacing for more detail near the center
    const rMin = 0.001;
    for (let i = 0; i <= ringSegments; i++) {
        // t in [0,1]; exponential growth
        const t = i / ringSegments;
        const r = radius * Math.pow(t, 2.2); // adjust exponent for density falloff

        for (let j = 0; j <= radialSegments; j++) {
            const theta = (j / radialSegments) * Math.PI * 2;
            const x = r * Math.cos(theta);
            const z = r * Math.sin(theta);

            positions.push(x, 0, z);
            uvs.push(j / radialSegments, i / ringSegments);
        }
    }

    // Build indices between rings
    const stride = radialSegments + 1;
    for (let i = 0; i < ringSegments; i++) {
        for (let j = 0; j < radialSegments; j++) {
            const a = i * stride + j;
            const b = a + 1;
            const c = a + stride;
            const d = c + 1;
            indices.push(a, b, c, b, d, c);
        }
    }
    indices.reverse();

    // Create mesh
    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.uvs = uvs;

    const normals = [];
    VertexData.ComputeNormals(positions, indices, normals);
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);
    // --- Now rebuild it as true two-sided geometry ---
    VertexData._ComputeSides(
        Mesh.DOUBLESIDE,
        mesh.getVerticesData(VertexBuffer.PositionKind),
        mesh.getIndices(),
        mesh.getVerticesData(VertexBuffer.NormalKind),
        mesh.getVerticesData(VertexBuffer.UVKind),
        // ✅ add default UV region arguments (optional but required for TS)
        new Vector4(0, 0, 1, 1),
        new Vector4(0, 0, 1, 1)
    );

    return mesh;
}
function setupWindShader(scene) {
    const WIND = {
        time: 0,
        amplitude: 0.3,
        speed: 8,
        pow: 1.4,
        dir: new Vector2(1.0, 0.4).normalize(),
        noiseScale: 0.2,
        noiseSpeed: 0.5,
        shiverAmp: 0.05,
        shiverFreq: 5.5
    };
    scene.WIND = WIND;

    // -------------------------------
    // 🌬️ Wind Plugin (UBO-correct)
    // -------------------------------
    // inside setupWindShader(scene) ---------------------------------------------
    class WindSwayPlugin extends MaterialPluginBase {
        constructor(material) {
            super(material, 'WindSway', 200, { WIND: false });
            this._isEnabled = true;
            this._enable(true);
        }

        prepareDefines(defines) {
            defines.WIND = this._isEnabled;
        }

        getUniforms() {
            // Reuse your existing uniforms; no new ones required
            return {
                ubo: [
                    { name: 'windTime', size: 1, type: 'float' },
                    { name: 'windAmplitude', size: 1, type: 'float' },
                    { name: 'windSpeed', size: 1, type: 'float' },
                    { name: 'windPow', size: 1, type: 'float' },
                    { name: 'windDir', size: 2, type: 'vec2' },
                    { name: 'noiseScale', size: 1, type: 'float' },
                    { name: 'noiseSpeed', size: 1, type: 'float' },
                    { name: 'shiverAmp', size: 1, type: 'float' },
                    { name: 'shiverFreq', size: 1, type: 'float' }
                ]
            };
        }

        bindForSubMesh(ubo) {
            // const d = this._material.getScene().WIND.dir.normalize();
            // const WIND = this._material.getScene().WIND;
            // ubo.updateFloat('windTime', WIND.time);
            // ubo.updateFloat('windAmplitude', WIND.amplitude);
            // ubo.updateFloat('windSpeed', WIND.speed);
            // ubo.updateFloat('windPow', WIND.pow);
            // ubo.updateFloat2('windDir', d.x, d.y);
            // ubo.updateFloat('noiseScale', WIND.noiseScale);
            // ubo.updateFloat('noiseSpeed', WIND.noiseSpeed);
            // ubo.updateFloat('shiverAmp', WIND.shiverAmp);
            // ubo.updateFloat('shiverFreq', WIND.shiverFreq);
        }

        getCustomCode(shaderType) {
            if (shaderType !== 'vertex') return null;

            return {
                // IMPORTANT: apply sway in WORLD space (global)
                CUSTOM_VERTEX_UPDATE_WORLDPOS: `
      #ifdef WIND
        // Compute world-space base (pivot)
        vec4 baseW = finalWorld * vec4(0.0, 0.0, 0.0, 1.0);

        // Compute local height relative to base
        float localHeight = worldPos.y - baseW.y;
        float h = clamp((localHeight + 1.5) / 3.0, 0.0, 1.0);

        // Wave phase from global position
        float phase = windTime * windSpeed + dot(worldPos.xz, windDir) * windPow;

        // Local sway/shiver amounts
        float sway   = sin(phase) * windAmplitude * pow(h, 1.5);
        float shiver = sin(phase * shiverFreq) * shiverAmp * pow(h, 2.0);

        // Compute rotation axis roughly perpendicular to windDir
        vec3 rel = worldPos.xyz - baseW.xyz;
        vec3 axis = normalize(vec3(-windDir.y, 0.0, windDir.x));

        // Small rotation angle in radians
        float angle = (sway + shiver) * 0.2;
        float c = cos(angle), s = sin(angle);
        mat2 rot = mat2(c, -s, s, c);

        // Rotate relative XZ around base pivot
        rel.xz = rot * rel.xz;

        // Reconstruct world position
        worldPos.xyz = baseW.xyz + rel;
        vPositionW = worldPos.xyz;
      #endif`
            };
        }
    }

    // ----------------------------------
    // 🎁 Helper to apply plugin
    // ----------------------------------
    scene.wrapWithWindSway = (mat) => {
        if (!mat) return mat;
        if (!mat._windPlugin) {
            try {
                const plugin = new WindSwayPlugin(mat);
                mat._windPlugin = plugin;
            } catch (e) {
                console.warn('Wind plugin already attached or failed:', e);
            }
        }
        return mat;
    };

    // drive time
    scene.onBeforeRenderObservable.add(() => {
        WIND.time = performance.now() * 0.001;
    });
}
// === Water + Fog setup ===
function setupIslandFog(scene, islandMesh, waterRadius) {
    // Estimate island’s radius (if not provided)
    const bounds = islandMesh.getBoundingInfo().boundingBox;
    const islandRadius = Math.max(Math.abs(bounds.maximum.x), Math.abs(bounds.maximum.z));

    // Where fog starts (a bit behind island)
    const fogStart = islandRadius * -9.1; // start fading just behind island
    const fogEnd = waterRadius; // full fade at water edge

    // Convert to an exponential fog density value
    // Rule of thumb: density ≈ 1 / (fogEnd - fogStart)
    const density = 1.0 / (fogEnd - fogStart);

    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = density * 1.5; // tweak intensity visually
    scene.fogColor = new Color3(0.07, 0.35, 0.4); // oceanic teal

    console.log(`🌫 Fog tuned: starts at ${fogStart.toFixed(1)}, full by ${fogEnd.toFixed(1)}, density=${scene.fogDensity.toFixed(4)}`);
}
