import { Animation, Color3, Color4, Mesh, MeshBuilder, Ray, Scalar, SolidParticleSystem, TransformNode, Vector3, VertexData } from '@babylonjs/core';
import { COLORS } from '../colors.js';
import { Entity } from '../entity.js';
import * as Terrain from '../static/terrain.js';
import { emitFruit, emitPetal, makePalmFrond } from '../geometry/emitters.js';
// 0 → lowest poly, 1 → full detail
window.POLY_THROTTLE = 0.1;

// Utility: scale particle count / quality according to POLY_THROTTLE
window.scaleQuality = function (count, minFactor = 0.25) {
    const t = Scalar.Clamp(window.POLY_THROTTLE ?? 1, 0, 1);
    // exponentially bias so mid-range throttles still reduce count noticeably
    const f = Scalar.Lerp(minFactor, 1.0, Math.pow(t, 1.4));
    return Math.max(1, Math.round(count * f));
};

// Utility: inverse-scale particle size (so lower poly means bigger particles)
window.scaleSize = function (size, minFactor = 0.25) {
    const t = Scalar.Clamp(window.POLY_THROTTLE ?? 1, 0, 1);
    const f = Scalar.Lerp(1.0 / minFactor, 1.0, Math.pow(t, 1.2));
    return size * f;
};
// ======================================================
// 🌳 BASE CLASS
// ======================================================
// inside plants/classes.js
// ======================================================
// 🌿 PLANT (extends Entity)
// ======================================================
export class Plant extends Entity {
    constructor(scene, pos, params = {}) {
        super(scene, pos, params);

        // Shared base anchor for shader wind sway
        this.baseCenter = pos.clone();

        // Optionally used for procedural growth or wind interaction
        this.isGrowing = false;
    }

    // Override: adds mesh with wind sway wrapping
    add(mesh, mat = null) {
        const s = this.scene;

        // If material is supplied or mesh has one, wrap with wind sway plugin
        if (mat) {
            if (s.wrapWithWindSway) {
                mesh.material = s.wrapWithWindSway(mat);
            } else {
                mesh.material = mat;
            }
        } else if (mesh.material && s.wrapWithWindSway) {
            mesh.material = s.wrapWithWindSway(mesh.material);
        }

        // Link for shader to sway around this plant’s anchor
        mesh._plantBaseCenter = this.baseCenter.clone();
        mesh.parent = this.group;

        return mesh;
    }

    // Optional: basic growth helper
    grow(duration = 1000, easing = 'easeOutBack', onDone = null) {
        const A = Animate || this.scene.Animate;
        if (!A) return;
        this.isGrowing = true;
        this.group.scaling.setAll(0);
        A.popScale(this.group, duration / 60, 0, easing);
        setTimeout(() => {
            this.isGrowing = false;
            if (onDone) onDone();
        }, duration);
    }

    // Reuse computeBounds from Entity if needed
    computeBounds() {
        super.computeBounds();
    }

    // Optional lifecycle hook — called at end of growth animation
    finalize() {
        this.computeBounds();
        this.isGrowing = false;
    }
}

// ======================================================
// 🌾 FOREST BUILDER (same)
// ======================================================
export function growForest({ scene }, center, radius = 25, count = 120, groundMesh = null) {
    const ray = new Ray();
    const landRadius = radius * 0.9;

    // cheap 2D sine-based pseudo noise
    function simpleNoise2D(x, z) {
        return Math.sin(x * 0.11 + z * 0.07) + Math.sin(x * 0.05 - z * 0.13);
    }

    function computeContext(pos) {
        const n = simpleNoise2D(pos.x, pos.z);
        const altitude = pos.y;
        const food = Scalar.Clamp((0.6 + n * 0.4) * Scalar.SmoothStep(0.1, 1.5, 2.2 - altitude), 0, 1);
        return { altitude, food, moisture: (n + 2) / 4, fertility: food };
    }

    for (let i = 0; i < count; i++) {
        const jitter = Math.random() * 200;
        setTimeout(() => {
            const x = center.x + (Math.random() - 0.5) * radius * 2;
            const z = center.z + (Math.random() - 0.5) * radius * 2;
            if ((x - center.x) ** 2 + (z - center.z) ** 2 > landRadius ** 2) return;

            const ray = new Ray(new Vector3(x, 50, z), Vector3.Down(), 100);
            const pick = scene.pickWithRay(ray, (m) => m === groundMesh);
            if (!pick?.hit) return;
            const pos = pick.pickedPoint.clone();
            if (pos.y < 0.25) return;
            const normal = pick.getNormal(true, true);
            if (normal?.y < 0.75) return;

            const ctx = computeContext(pos);

            // 🌾 Probability mixing based on context
            let p;
            const r = Math.random();
            // inside growForest()
            if (ctx.food < 0.35) {
                // 🏜️ Arid zone
                if (r < 0.45) {
                    p = new Terrain.Rock(scene, pos, { ...ctx, size: 1.5 + Math.random() * 1.5 });
                } else if (r < 0.75) {
                    p = new Palm(scene, pos, ctx);
                } else {
                    p = new Bush(scene, pos, ctx);
                }
            } else if (ctx.food < 0.7) {
                // 🌵 Semi-arid / mid fertility
                if (r < 0.15) {
                    p = new Terrain.Rock(scene, pos, { ...ctx, size: 1.0 + Math.random() * 1.2 });
                } else if (r < 0.35) {
                    p = new Palm(scene, pos, ctx);
                } else if (r < 0.75) {
                    p = new Tree(scene, pos, ctx);
                } else {
                    p = new Bush(scene, pos, ctx);
                }
            } else {
                // 🌿 Lush, fertile area
                if (r < 0.05) {
                    p = new Terrain.Rock(scene, pos, { ...ctx, size: 0.8 + Math.random() * 0.8 });
                } else if (r < 0.4) {
                    p = new Tree(scene, pos, ctx);
                } else if (r < 0.7) {
                    p = new Palm(scene, pos, ctx);
                } else if (r < 0.9) {
                    p = new FlowerCluster(scene, pos, ctx);
                } else {
                    p = new Flower(scene, pos, ctx);
                }
            }

            // Scale whole plant by fertility
            const s = 3.5 + ctx.food * 3.5;
            p.group.scaling.setAll(0);
            Animate.popScale(p.group, 35);
            p.group.scaling.setAll(s);
        }, jitter);
    }
}

// ======================================================
// 🌈 Color utilities

function randomLeafColor(base) {
    const jitter = 0.12;
    const h = base.clone();
    h.r = Scalar.Clamp(base.r + (Math.random() - 0.5) * jitter, 0, 1);
    h.g = Scalar.Clamp(base.g + (Math.random() - 0.5) * jitter, 0, 1);
    h.b = Scalar.Clamp(base.b + (Math.random() - 0.5) * jitter, 0, 1);
    return h;
}

export class Tree extends Plant {
    constructor(scene, pos, params = {}) {
        super(scene, pos, params);
        const MAT = window.GLOBAL_CACHE.MAT;
        const A = Animate;

        // === Deterministic RNG ===
        const seed = Math.sin(pos.x * 12.9898 + pos.z * 78.233) * 43758.5453;
        let randState = (seed - Math.floor(seed)) * 1e6;
        const rand = () => {
            randState = (randState * 16807) % 2147483647;
            return (randState & 0x7fffffff) / 2147483647;
        };
        const rRange = (a, b) => a + (b - a) * rand();

        // === Environment ===
        const humidity = scene.getAridity(pos.x, pos.z);
        const fertility = params.fertility ?? 0.5;
        const moisture = params.moisture ?? 0.5;

        // === Color palette ===
        const PALETTES = {
            lush: ['bluishGreen', 'aquamarine', 'emerald', 'lightTeal', 'cerulean', 'brightSkyBlue'],
            temperate: ['peach', 'orangePink', 'goldenYellow', 'fadedOrange', 'darkishPink'],
            arid: ['lightMaroon', 'redViolet', 'watermelon', 'mustardGreen', 'yellowyBrown']
        };
        let paletteType = 'temperate';
        if (fertility > 0.65 && moisture > 0.55) paletteType = 'lush';
        else if (fertility < 0.35 || moisture < 0.35) paletteType = 'arid';
        const baseColor = Color3.FromHexString(COLORS[PALETTES[paletteType][Math.floor(rand() * PALETTES[paletteType].length)]]);

        // === Height & proportions ===
        const envFactor = Scalar.Clamp((fertility + moisture * 0.8) * 0.6 + (1 - humidity) * 0.4, 0, 1);
        const baseHeight = Scalar.Lerp(4.5, 12.0, envFactor);
        const h = baseHeight * rRange(0.4, 0.8);
        const trunkThick = Scalar.Lerp(0.3, 0.55, envFactor);
        const canopyRadius = Scalar.Lerp(1.2, 2.2, envFactor);
        const canopyDensity = window.scaleQuality(
            Math.floor(Scalar.Lerp(150, 350, envFactor)),
            0.25 // at POLY_THROTTLE = 0 → 25% of original count
        );

        // === Curved lean parameters ===
        const leanAmt = Scalar.Lerp(0.02, 0.25, Scalar.InverseLerp(4.5, 12.0, h));
        const leanDir = new Vector3((rand() - 0.5) * 2, 0, (rand() - 0.5) * 2).normalize();
        const curveVec = leanDir.scale(leanAmt * h);

        // === Build smooth trunk curve (single mesh) ===
        const path = [];
        const segs = 3; // curve resolution
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            // Smooth cubic-like curve: starts vertical, bends gradually
            const ease = 1 - Math.pow(1 - t, 3);
            const offset = curveVec.scale(ease);
            path.push(new Vector3(offset.x, t * h, offset.z));
        }

        const trunk = this.add(
            MeshBuilder.CreateTube(
                'trunk',
                {
                    path,
                    radiusFunction: (i, d) => {
                        const t = i / (path.length - 1);
                        return trunkThick * Scalar.Lerp(1, 0.5, t);
                    },
                    tessellation: 8,
                    cap: MeshBuilder.NO_CAP
                },
                scene
            ),
            MAT.trunk
        );

        trunk.scaling.setAll(0);

        // Vertex colors for bark
        const bark = new Color4(0.35 + 0.15 * (1 - humidity), 0.25 + 0.1 * (1 - humidity), 0.15 + 0.2 * humidity, 1);
        trunk.setVerticesData(
            'color',
            new Array(trunk.getTotalVertices() * 4).fill(0).map((_, i) => {
                const m = i % 4;
                return m === 0 ? bark.r : m === 1 ? bark.g : m === 2 ? bark.b : bark.a;
            })
        );

        // === Canopy positioned at end of curve ===
        const canopyParent = new TransformNode('canopy', scene);
        canopyParent.parent = this.group;
        const end = path[path.length - 1];
        canopyParent.position = end.clone();
        canopyParent.scaling.setAll(0);

        // === Canopy (SPS with vertex colors) ===
        const leafTemplate = MeshBuilder.CreateSphere('leafInstance', { diameter: 0.25, segments: 1 }, scene);
        leafTemplate.material = MAT.leaf;
        const sps = new SolidParticleSystem('canopySPS', scene, {
            updatable: false,
            useModelMaterial: true
        });

        sps.addShape(leafTemplate, canopyDensity, {
            positionFunction: (p) => {
                const r = canopyRadius * Math.pow(rand(), 0.8);
                const theta = rand() * Math.PI * 2;
                const phi = Math.acos(2 * rand() - 1);
                p.position.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
                const s = window.scaleSize(Scalar.Lerp(2.0, 1.2, humidity) * (0.8 + rand() * 0.5));

                p.scaling.setAll(s);
                const jitter = 0.12;
                p.color = new Color4(Scalar.Clamp(baseColor.r + (rand() - 0.5) * jitter, 0, 1), Scalar.Clamp(baseColor.g + (rand() - 0.5) * jitter, 0, 1), Scalar.Clamp(baseColor.b + (rand() - 0.5) * jitter, 0, 1), 1);
            }
        });

        const canopy = sps.buildMesh();
        canopy.material = MAT.leaf;
        canopy.material.useVertexColor = true;
        canopy.parent = canopyParent;
        leafTemplate.dispose();

        // === Fruits ===
        const fruits = [];
        const fruitChance = Scalar.Lerp(0.8, 0.3, humidity);
        if (rand() < fruitChance) {
            const fruitMesh = emitFruit(scene, MAT.fruit, 0.18);
            const fruitSPS = new SolidParticleSystem('fruitSPS', scene, {
                updatable: false,
                useModelMaterial: true
            });
            const count = Math.floor(Scalar.Lerp(10, 20, envFactor));
            fruitSPS.addShape(fruitMesh, count, {
                positionFunction: (p) => {
                    const r = canopyRadius * 0.8;
                    const a = rand() * Math.PI * 2;
                    const b = Math.acos(2 * rand() - 1);
                    p.position.set(r * Math.sin(b) * Math.cos(a), r * Math.cos(b), r * Math.sin(b) * Math.sin(a));
                    p.scaling.setAll(1 + rand() * 0.3);
                    const warm = Color3.Lerp(baseColor, new Color3(1, 0.6, 0.4), 0.5 + rand() * 0.2);
                    p.color = new Color4(warm.r, warm.g, warm.b, 1);
                }
            });
            const fruitCloud = this.add(fruitSPS.buildMesh(), MAT.fruit);
            fruitCloud.material.useVertexColor = true;
            fruitCloud.parent = canopyParent;
            fruitMesh.dispose();
            fruits.push(fruitCloud);
        }

        // === Animate (1 s total) ===
        [trunk, canopyParent, ...fruits].forEach((m) => setTimeout(() => A.popScale(m, 20, 0, 'easeOutBack'), rand() * 250));
        setTimeout(() => this.finalize(), 1000);
    }
}

export class Palm extends Plant {
    constructor(scene, pos, params = {}) {
        super(scene, pos, params);
        const A = Animate;
        const W = window.GLOBAL_CACHE.WindMats;

        // --- environment inputs ---
        const altitude = Scalar.Clamp(params.altitude ?? scene.getAltitude?.(pos.x, pos.z) ?? 0.3, 0, 1);
        const humidity = scene.getAridity?.(pos.x, pos.z) ?? 0.3;

        // ======================================================
        // 🌴 STRUCTURAL VARIETY (height & thickness only)
        // ======================================================

        // trunk height: 3 – 11 m range (≈ 2.5× diversity)
        const h = Scalar.Lerp(20, 3, altitude * 0.6 + Math.random() * 0.4) * (0.8 + Math.random() * 0.4);

        // base–top radius relationship: thin to thick
        const baseRadius = Scalar.Lerp(0.9, 0.35, altitude) * (0.6 + Math.random() * 0.8); // 0.35–1.0 roughly
        const tipRadius = baseRadius * Scalar.Lerp(0.25, 0.55, Math.random());

        // curvature & lean stronger for tall palms
        const segs = 3;
        const leanMag = Scalar.Lerp(0.55, 0.1, altitude) * Scalar.Lerp(1.0, 1.8, h / 11);
        const leanSign = Math.random() < 0.5 ? 1 : -1;
        const curveLean = leanMag * leanSign;

        const trunkMat = W.trunks[Math.floor(Math.random() * W.trunks.length)];
        const leafMat = W.leafs[Math.floor(Math.random() * W.leafs.length)];

        // ======================================================
        // 🌴 TRUNK GEOMETRY (continuous, curved, color graded)
        // ======================================================
        const sides = 6;
        const verts = [];
        const idx = [];
        const colors = [];

        const baseCol = new Color4(0.45, 0.32 + 0.2 * altitude, 0.22, 1);
        const tipCol = new Color4(0.3, 0.25 + 0.1 * altitude, 0.18, 1);

        for (let j = 0; j <= segs; j++) {
            const t = j / segs;
            const y = h * t;
            const r = Scalar.Lerp(baseRadius, tipRadius, t);
            const cx = curveLean * Math.pow(t, 1.3) * h * 0.25;
            const col = Color4.Lerp(baseCol, tipCol, t);

            for (let i = 0; i < sides; i++) {
                const a = (i / sides) * Math.PI * 2;
                const x = cx + Math.cos(a) * r;
                const z = Math.sin(a) * r;
                verts.push(x, y, z);
                colors.push(col.r, col.g, col.b, col.a);
            }
        }

        for (let j = 0; j < segs; j++) {
            for (let i = 0; i < sides; i++) {
                const a = j * sides + i;
                const b = j * sides + ((i + 1) % sides);
                const c = (j + 1) * sides + i;
                const d = (j + 1) * sides + ((i + 1) % sides);
                idx.push(a, b, c, b, d, c);
            }
        }

        const trunk = new Mesh('palmTrunk', scene);
        const vd = new VertexData();
        vd.positions = verts;
        vd.indices = idx;
        vd.colors = colors;
        const normals = [];
        VertexData.ComputeNormals(verts, idx, normals);
        vd.normals = normals;
        vd.applyToMesh(trunk);
        trunk.material = trunkMat;
        this.add(trunk, trunkMat);
        trunk.scaling.setAll(0);

        // ======================================================
        // 🌿 CROWN
        // ======================================================
        const crown = new TransformNode('crown', scene);
        crown.parent = this.group;
        crown.position.set(curveLean * h * 0.25, h, 0);
        crown.scaling.setAll(0);

        // ======================================================
        // 🌾 FRONDS (scaled with trunk height, not variety)
        // ======================================================
        const frondCount = Math.floor(Scalar.Lerp(22, 32, h / 11));
        const frondSPS = new SolidParticleSystem('palmFronds', scene, {
            updatable: false,
            useModelMaterial: true
        });

        const altFactor = Scalar.Clamp(altitude, 0, 1);
        for (let i = 0; i < frondCount; i++) {
            const ring = 0.35 + Math.random() * 0.25;
            const ang = Math.random() * Math.PI * 2;
            const frondType = altFactor > 0.7 ? 'date' : altFactor < 0.3 ? 'coconut' : Math.random() < 0.3 ? 'windswept' : 'auto';

            const frond = makePalmFrond(scene, leafMat, {
                frondType,
                altitude: altFactor,
                seed: i * 37 + pos.x * 13 + pos.z * 17,
                length: Scalar.Lerp(3.2, 4.4, h / 11),
                maxWidth: Scalar.Lerp(0.45, 0.55, h / 11),
                randomness: 0.3,
                tearChance: 0.12,
                tearDepth: 0.45
            });

            // vertex color tint (slight hue variation)
            const cVar = Scalar.Lerp(0.05, 0.25, Math.random());
            const baseTint = new Color4(0.08 + cVar, 0.5 + Math.random() * 0.3, 0.08 + Math.random() * 0.15, 1);
            const vCount = frond.getVerticesData('position').length / 3;
            const fColors = [];
            for (let k = 0; k < vCount; k++) fColors.push(baseTint.r, baseTint.g, baseTint.b, baseTint.a);
            frond.setVerticesData('color', fColors);

            frondSPS.addShape(frond, 1, {
                positionFunction: (p) => {
                    p.position.set(ring * Math.cos(ang), Math.random() * 0.1, ring * Math.sin(ang));
                    p.rotation.set(-0.25 - Math.random() * 0.4, ang + (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.2);
                    p.scaling.setAll(Scalar.Lerp(0.8, 1.1, h / 11));
                }
            });
            frond.dispose();
        }

        const frondsMesh = this.add(frondSPS.buildMesh(), leafMat);
        frondsMesh.parent = crown;
        frondsMesh.scaling.setAll(0);

        // ======================================================
        // 🍈 FRUIT CLUSTERS (realistic distribution)
        // ======================================================
        const fertility = params.fertility ?? 0.5;
        const moisture = params.moisture ?? 0.5;
        const fruitChance = Scalar.Clamp(0.2 + 0.5 * fertility + 0.4 * moisture + Math.random() * 0.2, 0, 1);

        const fruitCluster = new TransformNode('fruitCluster', scene);
        fruitCluster.parent = crown;
        fruitCluster.position.y = -0.35;
        fruitCluster.scaling.setAll(0);

        if (Math.random() < fruitChance) {
            const fruitMat = W.fruits[Math.floor(Math.random() * W.fruits.length)];
            const fruitBaseMesh = emitFruit(scene, fruitMat, 0.12);

            const fruitSPS = new SolidParticleSystem('fruitSPS', scene, {
                updatable: false,
                useModelMaterial: true
            });

            const lowAlt = altitude < 0.45;
            const type = lowAlt ? 'coconut' : 'date';

            const baseCount = type === 'coconut' ? 6 + Math.floor(Math.random() * 4) : 30 + Math.floor(Math.random() * 25);
            const count = window.scaleQuality(baseCount, 0.25);

            const clusterCount = type === 'coconut' ? 1 : 2 + Math.floor(Math.random() * 2);

            for (let c = 0; c < clusterCount; c++) {
                const baseAng = Math.random() * Math.PI * 2;
                const hangDir = new Vector3(Math.cos(baseAng), -0.6, Math.sin(baseAng)).normalize();

                fruitSPS.addShape(fruitBaseMesh, count, {
                    positionFunction: (p) => {
                        const t = Math.random();
                        const radius = type === 'coconut' ? 0.25 + Math.random() * 0.1 : 0.4 + Math.random() * 0.15;
                        const offset = hangDir.scale(radius * t);
                        p.position.copyFrom(offset);
                        p.position.y -= 0.1 + Math.random() * 0.3;

                        const tilt = (Math.random() - 0.5) * 0.6;
                        p.rotation.set(tilt, baseAng + Math.random() * 0.8, (Math.random() - 0.5) * 0.3);
                        p.scaling.setAll(window.scaleSize(type === 'coconut' ? 0.9 + Math.random() * 0.4 : 0.5 + Math.random() * 0.25));

                        // warm tropical colors
                        const base = type === 'coconut' ? Color3.FromHexString(COLORS['fadedOrange']) : Color3.FromHexString(COLORS['goldenYellow']);
                        const cJ = 0.1;
                        const col = new Color4(Scalar.Clamp(base.r + (Math.random() - 0.5) * cJ, 0, 1), Scalar.Clamp(base.g + (Math.random() - 0.5) * cJ, 0, 1), Scalar.Clamp(base.b + (Math.random() - 0.5) * cJ, 0, 1), 1);
                        p.color = col;
                    }
                });
            }

            const fruitMesh = this.add(fruitSPS.buildMesh(), fruitMat);
            fruitMesh.material.useVertexColor = true;
            fruitMesh.parent = fruitCluster;
            fruitBaseMesh.dispose();

            A.popScale(fruitCluster, 25, 400, 'easeOutElastic');
        }

        // ======================================================
        // 🎬 ANIMATION (1 s, parallel)
        // ======================================================
        A.popScale(trunk, 25);
        A.popScale(crown, 25, 100, 'easeOutBack');
        A.popScale(frondsMesh, 25, 150, 'easeOutElastic');
        A.popScale(fruitCluster, 25, 400, 'easeOutElastic');
        setTimeout(() => this.finalize(), 1000);
    }
}

// ======================================================
// 🌿 BUSH
// ======================================================
export class Bush extends Plant {
    constructor(scene, pos, params = {}) {
        super(scene, pos, params);
        const MAT = window.GLOBAL_CACHE.MAT;
        const A = Animate;

        // === Deterministic PRNG (so bushes look same for same coords) ===
        const seed = Math.sin(pos.x * 12.9898 + pos.z * 78.233) * 43758.5453;
        let randState = (seed - Math.floor(seed)) * 1e6;
        const rand = () => {
            randState = (randState * 16807) % 2147483647;
            return (randState & 0x7fffffff) / 2147483647;
        };
        const rRange = (a, b) => a + (b - a) * rand();

        // === Environmental context ===
        const fertility = params.fertility ?? 0.5;
        const moisture = params.moisture ?? 0.5;

        // === Context-based palette ===
        const PALETTES = {
            lush: ['bluishGreen', 'aquamarine', 'emerald', 'lightTeal', 'cerulean'],
            temperate: ['peach', 'peachyPink', 'orangePink', 'goldenYellow', 'fadedOrange'],
            arid: ['lightMaroon', 'redViolet', 'watermelon', 'lipstick', 'mustardGreen']
        };

        let paletteType = 'temperate';
        if (fertility > 0.65 && moisture > 0.55) paletteType = 'lush';
        else if (fertility < 0.35 || moisture < 0.35) paletteType = 'arid';

        const palette = PALETTES[paletteType];
        const baseKey = palette[Math.floor(rand() * palette.length)];
        const baseColor = Color3.FromHexString(COLORS[baseKey]);

        // === Create main clumps ===
        const clumps = [];
        const n = 5 + Math.floor(rand() * 3);

        for (let i = 0; i < n; i++) {
            const diam = rRange(0.7, 1.0);
            const sph = this.add(MeshBuilder.CreateSphere('clump', { diameter: diam, segments: 5 }, scene), MAT.leaf);

            sph.position = new Vector3((rand() - 0.5) * 1.4, rand() * 0.6, (rand() - 0.5) * 1.4);

            // 🌈 Vertex-color tint (preserves wind plugin)
            const jitter = 0.1;
            const c = new Color4(Scalar.Clamp(baseColor.r + (rand() - 0.5) * jitter, 0, 1), Scalar.Clamp(baseColor.g + (rand() - 0.5) * jitter, 0, 1), Scalar.Clamp(baseColor.b + (rand() - 0.5) * jitter, 0, 1), 1);
            sph.setVerticesData(
                'color',
                new Array(sph.getTotalVertices() * 4).fill(0).map((_, i) => {
                    const m = i % 4;
                    return m === 0 ? c.r : m === 1 ? c.g : m === 2 ? c.b : c.a;
                })
            );

            sph.scaling.setAll(0);
            clumps.push(sph);
        }

        // === Occasional blossoms ===
        const petals = [];
        if (rand() > 0.5) {
            const petalsCount = 3 + Math.floor(rand() * 3);
            for (let i = 0; i < petalsCount; i++) {
                const p = this.add(emitPetal(scene, MAT.flower, 0.25, 0.12, 0.6), MAT.flower);
                p.position = new Vector3((rand() - 0.5) * 1.2, 0.5 + rand() * 0.4, (rand() - 0.5) * 1.2);

                // slight vertex tint for blossom
                const tint = Color3.Lerp(baseColor, new Color3(1, 0.8, 0.9), 0.5 + rand() * 0.5);
                p.setVerticesData(
                    'color',
                    new Array(p.getTotalVertices() * 4).fill(0).map((_, i) => {
                        const m = i % 4;
                        return m === 0 ? tint.r : m === 1 ? tint.g : m === 2 ? tint.b : 1;
                    })
                );

                p.scaling.setAll(0);
                petals.push(p);
            }
        }

        // === Compact 1-second animation ===
        const all = [...clumps, ...petals];
        all.forEach((m) => {
            const delay = rand() * 300;
            A.popScale(m, 20, delay, rand() < 0.5 ? 'easeOutBack' : 'easeOutElastic');
        });

        setTimeout(() => this.finalize(), 1000);
    }
}
// ======================================================
// 🎨 Cached Material Utilities
// ======================================================
function getFlowerMaterial(scene, hexColor) {
    if (!window.GLOBAL_CACHE.FlowerMats) window.GLOBAL_CACHE.FlowerMats = {};
    const cache = window.GLOBAL_CACHE.FlowerMats;
    if (cache[hexColor]) return cache[hexColor];

    const MAT = window.GLOBAL_CACHE.MAT;
    const mat = MAT.flower.clone('flower_' + hexColor);
    mat.albedoColor = Color3.FromHexString(hexColor);
    cache[hexColor] = scene.wrapWithWindSway(mat);
    return cache[hexColor];
}

function getFruitMaterial(scene, hexColor) {
    if (!window.GLOBAL_CACHE.FruitMats) window.GLOBAL_CACHE.FruitMats = {};
    const cache = window.GLOBAL_CACHE.FruitMats;
    if (cache[hexColor]) return cache[hexColor];

    const MAT = window.GLOBAL_CACHE.MAT;
    const mat = MAT.fruit.clone('fruit_' + hexColor);
    mat.albedoColor = Color3.FromHexString(hexColor);
    cache[hexColor] = scene.wrapWithWindSway(mat);
    return cache[hexColor];
}

// ======================================================
// 🌸 FLOWER (vertex-color based)
// ======================================================
export class Flower extends Plant {
    constructor(scene, pos, params = {}) {
        super(scene, pos, params);
        const A = Animate;

        // === Deterministic PRNG ===
        const seed = Math.sin(pos.x * 12.9898 + pos.z * 78.233) * 43758.5453;
        let randState = (seed - Math.floor(seed)) * 1e6;
        const rand = () => {
            randState = (randState * 16807) % 2147483647;
            return (randState & 0x7fffffff) / 2147483647;
        };
        const rRange = (a, b) => a + (b - a) * rand();

        // === Environmental context ===
        const fertility = params.fertility ?? 0.5;
        const moisture = params.moisture ?? 0.5;

        // === Palette selection ===
        const PALETTES = {
            lush: ['bluishGreen', 'aquamarine', 'emerald', 'lightTeal', 'cerulean', 'brightSkyBlue'],
            temperate: ['peach', 'peachyPink', 'orangePink', 'goldenYellow', 'fadedOrange', 'darkishPink'],
            arid: ['lightMaroon', 'redViolet', 'watermelon', 'lipstick', 'mustardGreen', 'yellowyBrown']
        };

        let paletteType = 'temperate';
        if (fertility > 0.65 && moisture > 0.55) paletteType = 'lush';
        else if (fertility < 0.35 || moisture < 0.35) paletteType = 'arid';

        const palette = PALETTES[paletteType];
        const baseKey = palette[Math.floor(rand() * palette.length)];
        const baseColor = Color3.FromHexString(COLORS[baseKey]);

        // === Shared plugin-safe materials ===
        const MAT = window.GLOBAL_CACHE.MAT;

        // === Stem ===
        const stemH = rRange(0.35, 0.6);
        const stem = this.add(MeshBuilder.CreateCylinder('stem', { height: stemH, diameter: 0.05 }, scene), MAT.trunk);
        stem.position.y = stemH / 2;
        stem.scaling.setAll(0);

        // === Head ===
        const head = new TransformNode('head', scene);
        head.parent = this.group;
        head.position.y = stemH;
        head.scaling.setAll(0);

        // === Petal layers (vertex-colored) ===
        const makePetalLayer = (count, radius, verticalOffset = 0) => {
            const petals = [];
            for (let i = 0; i < count; i++) {
                const angle = ((Math.PI * 2) / count) * i;
                const len = rRange(0.22, 0.32);
                const wid = rRange(0.08, 0.14);
                const curve = rRange(0.45, 0.7);

                const petal = this.add(emitPetal(scene, MAT.flower, len, wid, curve), MAT.flower);
                petal.parent = head;

                petal.position = new Vector3(Math.cos(angle) * radius, verticalOffset, Math.sin(angle) * radius);
                petal.lookAt(head.position);
                petal.rotation.x += rRange(-0.5, -0.25);
                petal.rotation.y += rRange(-0.25, 0.25);
                petal.rotation.z += rRange(-0.15, 0.15);

                // Assign per-vertex color (adds color buffer)
                const jitter = 0.08;
                const c = new Color4(Scalar.Clamp(baseColor.r + (rand() - 0.5) * jitter, 0, 1), Scalar.Clamp(baseColor.g + (rand() - 0.5) * jitter, 0, 1), Scalar.Clamp(baseColor.b + (rand() - 0.5) * jitter, 0, 1), 1);
                petal.hasVertexAlpha = false;
                petal.setVerticesData(
                    'color',
                    new Array(petal.getTotalVertices() * 4).fill(0).map((_, idx) => {
                        const m = idx % 4;
                        return m === 0 ? c.r : m === 1 ? c.g : m === 2 ? c.b : c.a;
                    })
                );

                petal.scaling.setAll(rRange(0.9, 1.2));
                petals.push(petal);
            }
            return petals;
        };

        const baseCount = 5 + Math.floor(rand() * 4);
        const outer = makePetalLayer(baseCount, 0.15);
        const inner = rand() < 0.25 ? makePetalLayer(baseCount - 1, 0.1, 0.01) : [];

        // === Core (fruit) ===
        const core = this.add(emitFruit(scene, MAT.fruit, 0.08), MAT.fruit);
        core.parent = head;
        const coreColor = Color3.Lerp(baseColor, new Color3(1, 0.95, 0.3), Scalar.Lerp(0.4, 0.7, fertility));
        core.setVerticesData(
            'color',
            new Array(core.getTotalVertices() * 4).fill(0).map((_, idx) => {
                const m = idx % 4;
                return m === 0 ? coreColor.r : m === 1 ? coreColor.g : m === 2 ? coreColor.b : 1;
            })
        );
        core.scaling.setAll(0);

        // === Animation (parallel 1s bloom) ===
        const petalsAll = [...outer, ...inner];
        A.popScale(stem, 20, 0, 'easeOutBack');
        A.popScale(head, 25, 100, 'easeOutBack');
        petalsAll.forEach((p) => A.popScale(p, 20, rand() * 300, rand() < 0.5 ? 'easeOutElastic' : 'easeOutBack'));
        setTimeout(() => A.popScale(core, 25, 0, 'easeOutBack'), 700);
        setTimeout(() => this.finalize(), 1000);
    }
}

// ======================================================
// 💐 FLOWER CLUSTER
// ======================================================
export class FlowerCluster extends Plant {
    constructor(scene, pos, params = {}) {
        super(scene, pos, params);
        const A = Animate;

        // ✅ Center cluster at given position
        this.group.position.copyFrom(pos);

        const count = 3 + Math.floor(Math.random() * 4);
        const groundMesh = scene.getMeshByName('island');
        const flowers = [];

        for (let i = 0; i < count; i++) {
            // random horizontal offset (local space)
            const off = new Vector3((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6);
            const testPos = pos.add(off);

            // shoot ray down from above terrain to find surface height
            const ray = new Ray(new Vector3(testPos.x, 50, testPos.z), Vector3.Down(), 100);
            const pick = scene.pickWithRay(ray, (m) => m === groundMesh);
            if (!pick?.hit) continue;

            const groundPos = pick.pickedPoint.clone();
            if (groundPos.y < 0.25) continue; // skip underwater or invalid points

            // 🌸 Spawn flower at terrain height
            const f = new Flower(scene, groundPos, {
                ...params,
                scale: 0.8 + Math.random() * 0.5
            });

            // parent to cluster
            f.group.parent = this.group;

            // ✅ Convert world position → cluster-local position
            f.group.position.subtractInPlace(pos);

            // start invisible for animation
            f.group.scaling.setAll(0);

            flowers.push(f.group);
        }

        // 🌷 Animate all flowers roughly together
        flowers.forEach((f) => setTimeout(() => A.popScale(f, 25, 0, 'easeOutBack'), Math.random() * 150));

        // finalize cluster after animation
        setTimeout(() => this.finalize(), 1000);
    }
}
// ======================================================
// 🌱 ANIMATION SYSTEM (NEW)
// ======================================================
class Animator {
    easeOutBack(t) {
        const s = 1.70158;
        return 1 + --t * t * ((s + 1) * t + s);
    }
    easeOutElastic(t) {
        const c4 = (2 * Math.PI) / 3;
        return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    }
    easeInOutQuad(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    animateProperty(target, property, from, to, duration = 30, easing = 'easeOutBack', onDone) {
        const anim = new Animation(property + '_anim', property, 60, typeof from === 'number' ? Animation.ANIMATIONTYPE_FLOAT : Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CONSTANT);
        const easeFn = this[easing] || ((t) => t);
        const keys = [];
        for (let f = 0; f <= duration; f++) {
            const t = f / duration;
            const e = easeFn(t);
            if (typeof from === 'number') keys.push({ frame: f, value: from + (to - from) * e });
            else
                keys.push({
                    frame: f,
                    value: new Vector3(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e, from.z + (to.z - from.z) * e)
                });
        }
        anim.setKeys(keys);
        target.animations = [anim];
        window.GLOBAL_CACHE.scene.beginDirectAnimation(target, [anim], 0, duration, false, 1, onDone);
    }

    popScale(node, duration = 30, delay = 0, easing = 'easeOutBack') {
        node.scaling.setAll(0);
        setTimeout(() => {
            this.animateProperty(node, 'scaling', new Vector3(0, 0, 0), new Vector3(1, 1, 1), duration, easing);
        }, delay);
    }

    sequence(steps, onDone) {
        let total = 0;
        for (const s of steps) {
            setTimeout(s.action, total + (s.delay || 0));
            total += s.delay || 0;
        }
        if (onDone) setTimeout(onDone, total + 100);
    }
}

export const Animate = new Animator();
