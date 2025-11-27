// biome/Landmass.js
import { WINDOW_CONTEXT } from '@/lib/helpers'; // same as Water
import { Color3, EffectRenderer, EffectWrapper, Engine, Mesh, RawTexture, RenderTargetTexture, Scene, StandardMaterial, Texture, Vector2, VertexData } from '@babylonjs/core';
import GUI from 'lil-gui';
/**
 * A cubic noise
 * @param {Number} width The width of the range that can be sampled
 * @param {Number} height The height of the range that can be sampled
 * @param {Random} randomizer A randomizer
 * @constructor
 */
const CubicNoise = function (width, height, randomizer) {
    this.width = width;
    this.values = new Array((width + 2) * (height + 2));

    for (let i = 0; i < this.values.length; ++i) this.values[i] = randomizer.getFloat();
};

/**
 * Cubic interpolation
 * @param {Number} a The first value
 * @param {Number} b The second value
 * @param {Number} c The third value
 * @param {Number} d The fourth value
 * @param {Number} x The position to be interpolated between the second and the third value in the range [0, 1]
 * @returns {Number} The interpolated value
 */
CubicNoise.prototype.interpolate = function (a, b, c, d, x) {
    const p = d - c - (a - b);

    return x * (x * (x * p + (a - b - p)) + (c - a)) + b;
};

/**
 * Sample the noise
 * @param {Number} x The X value within [0, width]
 * @param {Number} y The Y value within [0, height]
 * @returns {Number} The noise value at the given coordinates
 */
CubicNoise.prototype.sample = function (x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);

    return (
        this.interpolate(
            this.interpolate(this.values[yi * this.width + xi], this.values[yi * this.width + xi + 1], this.values[yi * this.width + xi + 2], this.values[yi * this.width + xi + 3], x - xi),
            this.interpolate(this.values[(yi + 1) * this.width + xi], this.values[(yi + 1) * this.width + xi + 1], this.values[(yi + 1) * this.width + xi + 2], this.values[(yi + 1) * this.width + xi + 3], x - xi),
            this.interpolate(this.values[(yi + 2) * this.width + xi], this.values[(yi + 2) * this.width + xi + 1], this.values[(yi + 2) * this.width + xi + 2], this.values[(yi + 2) * this.width + xi + 3], x - xi),
            this.interpolate(this.values[(yi + 3) * this.width + xi], this.values[(yi + 3) * this.width + xi + 1], this.values[(yi + 3) * this.width + xi + 2], this.values[(yi + 3) * this.width + xi + 3], x - xi),
            y - yi
        ) *
            0.5 +
        0.25
    );
};
// ───────────────────────────────────────────────────────────────────────────────
// Minimal upstream-derived helpers (in-file, no boilerplate)
// ───────────────────────────────────────────────────────────────────────────────

/** Upstream-style fast LCG RNG */
class Random {
    constructor(seed = Math.floor(Math.random() * 0xffffffff)) {
        this.n = seed >>> 0;
    }
}
Random.prototype.MULTIPLIER = 69069;
Random.prototype.MODULUS = 2 ** 32;
Random.prototype.INCREMENT = 1;
Random.prototype.getFloat = function () {
    this.n = (this.MULTIPLIER * this.n + this.INCREMENT) % this.MODULUS;
    return this.n / this.MODULUS;
};

/** Upstream GridSampler (bilinear sample / change / gaussian blur) */
class GridSampler {
    constructor(width, height, values, scale = 1, defaultValue = 0) {
        this.width = width;
        this.height = height;
        this.values = values;
        this.scale = scale;
        this.defaultValue = defaultValue;
    }
    sample(x, y) {
        if (x < 0 || y < 0) return this.defaultValue;

        x *= this.scale;
        y *= this.scale;

        const xi = Math.floor(x);
        const yi = Math.floor(y);
        if (xi >= this.width - 1 || yi >= this.height - 1) return this.defaultValue;

        const fx = x - xi;
        const fy = y - yi;
        const ylu = this.values[xi + yi * this.width];
        const yld = this.values[xi + (yi + 1) * this.width];
        const yru = this.values[xi + 1 + yi * this.width];
        const yrd = this.values[xi + 1 + (yi + 1) * this.width];
        const yl = ylu + (yld - ylu) * fy;
        const yr = yru + (yrd - yru) * fy;
        return yl + (yr - yl) * fx;
    }
    change(x, y, delta) {
        if (x < 0 || y < 0) return;

        x *= this.scale;
        y *= this.scale;

        const xi = Math.floor(x);
        const yi = Math.floor(y);
        if (xi >= this.width - 1 || yi >= this.height - 1) return;

        const fx = x - xi;
        const fy = y - yi;

        this.values[xi + yi * this.width] += fx * fy * delta;
        this.values[xi + 1 + yi * this.width] += (1 - fx) * fy * delta;
        this.values[xi + (yi + 1) * this.width] += fx * (1 - fy) * delta;
        this.values[xi + 1 + (yi + 1) * this.width] += (1 - fx) * (1 - fy) * delta;
    }
    blur() {
        const newValues = new Array((this.width - 2) * (this.height - 2));
        for (let y = 1; y < this.height - 1; ++y) {
            for (let x = 1; x < this.width - 1; ++x) {
                newValues[x - 1 + (y - 1) * (this.width - 2)] =
                    (this.values[x - 1 + y * this.width] + this.values[x + (y - 1) * this.width] + this.values[x + 1 + y * this.width] + this.values[x + (y + 1) * this.width]) * 0.125 +
                    (this.values[x - 1 + (y - 1) * this.width] + this.values[x + 1 + (y - 1) * this.width] + this.values[x + 1 + (y + 1) * this.width] + this.values[x - 1 + (y + 1) * this.width]) * 0.0625 +
                    this.values[x + y * this.width] * 0.25;
            }
        }
        for (let y = 1; y < this.height - 1; ++y) {
            for (let x = 1; x < this.width - 1; ++x) {
                this.values[x + y * this.width] = newValues[x - 1 + (y - 1) * (this.width - 2)];
            }
        }
    }
}

/** Parameters (upstream defaults) */
class HeightMapParameters {
    constructor(octaves = 6, scale = 0.1, influenceFalloff = 0.5, scaleFalloff = 1.7, amplitude = 30, heightPower = 4.5) {
        this.octaves = octaves;
        this.scale = scale;
        this.influenceFalloff = influenceFalloff;
        this.scaleFalloff = scaleFalloff;
        this.amplitude = amplitude;
        this.heightPower = heightPower;
    }
}
class ErosionHydraulicParameters {
    constructor(dropsPerCell = 0.4, erosionRate = 0.04, depositionRate = 0.03, speed = 0.15, friction = 0.7, radius = 0.8, maxIterations = 80, iterationScale = 0.04) {
        this.dropsPerCell = dropsPerCell;
        this.erosionRate = erosionRate;
        this.depositionRate = depositionRate;
        this.speed = speed;
        this.friction = friction;
        this.radius = radius;
        this.maxIterations = maxIterations;
        this.iterationScale = iterationScale;
    }
}
class ErosionCoastalParameters {
    constructor(waveHeightMin = 0.4, waveHeightMax = 1.2, noiseScale = 0.5, power = 3) {
        this.waveHeightMin = waveHeightMin;
        this.waveHeightMax = waveHeightMax;
        this.noiseScale = noiseScale;
        this.power = power;
    }
}
class VolcanoesParameters {
    constructor(volcanoThreshold = 2.5, volcanoThresholdAmplitude = 2, volcanoThresholdScale = 0.2, volcanoMaxDepth = 0.5, volcanoCraterScale = 0.5) {
        this.volcanoThreshold = volcanoThreshold;
        this.volcanoThresholdAmplitude = volcanoThresholdAmplitude;
        this.volcanoThresholdScale = volcanoThresholdScale;
        this.volcanoMaxDepth = volcanoMaxDepth;
        this.volcanoCraterScale = volcanoCraterScale;
    }
}
class TerrainParameters {
    constructor(
        width = 25,
        height = 25,
        /* water */ _water = 0.5,
        shape = 'cone',
        shapePower = 1.6,
        resolution = 0.1,
        heightMapParameters = new HeightMapParameters(),
        erosionHydraulicParameters = new ErosionHydraulicParameters(),
        erosionCoastalParameters = new ErosionCoastalParameters(),
        volcanoesParameters = new VolcanoesParameters()
    ) {
        this.width = width;
        this.height = height;
        this.water = _water;
        this.shape = shape;
        this.shapePower = shapePower;
        this.resolution = resolution;
        this.heightMapParameters = heightMapParameters;
        this.erosionHydraulicParameters = erosionHydraulicParameters;
        this.erosionCoastalParameters = erosionCoastalParameters;
        this.volcanoesParameters = volcanoesParameters;
    }
}
TerrainParameters.SHAPE_CONE = 'cone';

/** Shape: cone (upstream) */
class ShapeCone {
    constructor(width, height, power) {
        this.width = width;
        this.height = height;
        this.power = power;
    }
    sample(x, y) {
        const dx = (this.width * 0.5 - x) / this.width;
        const dy = (this.height * 0.5 - y) / this.height;
        return Math.cos(Math.PI * Math.min(1, 2 * Math.sqrt(dx * dx + dy * dy)) ** this.power) * 0.5 + 0.5;
    }
}

/** HeightMap (upstream logic, including influences and CubicNoise stack) */
class HeightMap {
    constructor(parameters, xValues, yValues, resolution, shape, random) {
        this.parameters = parameters;
        this.xValues = xValues;
        this.yValues = yValues;
        this.resolution = resolution;
        this.shape = shape;
        this.random = random;
        this.values = new Array(xValues * yValues);
        this.sampler = new GridSampler(this.xValues, this.yValues, this.values, 1 / resolution);
        this.maxHeight = 0;
        this.generate();
    }
    createNoises() {
        const noises = new Array(this.parameters.octaves);
        let scale = this.parameters.scale;
        for (let octave = 0; octave < this.parameters.octaves; ++octave) {
            // Assumes global CubicNoise available (as you noted)
            noises[octave] = new CubicNoise(Math.ceil(scale * this.xValues), Math.ceil(scale * this.yValues), this.random);
            scale *= this.parameters.scaleFalloff;
        }
        return noises;
    }
    makeInfluences(octaves, falloff) {
        const influences = new Array(octaves);
        const iFalloff = 1 / falloff;
        let influence = ((iFalloff - 1) * iFalloff ** octaves) / (iFalloff ** octaves - 1) / iFalloff;
        for (let octave = 0; octave < octaves; ++octave) {
            influences[octave] = influence;
            if (octave !== octaves - 1) influence *= falloff;
        }
        return influences;
    }
    generate() {
        const noises = this.createNoises();
        const influences = this.makeInfluences(this.parameters.octaves, this.parameters.influenceFalloff);
        for (let y = 0; y < this.yValues; ++y) {
            for (let x = 0; x < this.xValues; ++x) {
                const index = x + y * this.xValues;
                let scale = this.parameters.scale * this.resolution;
                let height = 0;
                for (let octave = 0; octave < this.parameters.octaves; ++octave) {
                    height += noises[octave].sample(x * scale, y * scale) * influences[octave];
                    if (octave !== this.parameters.octaves - 1) scale *= this.parameters.scaleFalloff;
                }
                this.values[index] = height ** this.parameters.heightPower * this.parameters.amplitude * this.shape.sample(x * this.resolution, y * this.resolution);
                if (this.maxHeight < this.values[index]) this.maxHeight = this.values[index];
            }
        }
    }
    getWidth() {
        return (this.xValues - 1) * this.resolution;
    }
    getHeight() {
        return (this.yValues - 1) * this.resolution;
    }
    sampleNormal(x, y) {
        const doubleRadius = -(this.resolution + this.resolution);
        const left = this.sampler.sample(x - this.resolution, y);
        const top = this.sampler.sample(x, y - this.resolution);
        const right = this.sampler.sample(x + this.resolution, y);
        const bottom = this.sampler.sample(x, y + this.resolution);

        // Upstream’s exact normal math
        const nx = doubleRadius * (right - left);
        const ny = doubleRadius * doubleRadius;
        const nz = doubleRadius * (bottom - top);
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        return { x: nx / len, y: ny / len, z: nz / len };
    }
}

/** Erosion: Coastal (upstream) */
class ErosionCoastal {
    constructor(parameters, resolution, random) {
        this.parameters = parameters;
        this.resolution = resolution;
        this.random = random;
    }
    apply(heightMap) {
        const noise = new CubicNoise(Math.ceil(heightMap.xValues * this.resolution * this.parameters.noiseScale), Math.ceil(heightMap.yValues * this.resolution * this.parameters.noiseScale), this.random);
        for (let y = 0; y < heightMap.yValues; ++y) {
            for (let x = 0; x < heightMap.xValues; ++x) {
                const index = x + y * heightMap.xValues;
                const threshold = this.parameters.waveHeightMin + noise.sample(x * this.resolution * this.parameters.noiseScale, y * this.resolution * this.parameters.noiseScale) * (this.parameters.waveHeightMax - this.parameters.waveHeightMin);

                if (heightMap.values[index] < threshold) {
                    heightMap.values[index] *= (heightMap.values[index] / threshold) ** this.parameters.power;
                }
            }
        }
    }
}

/** Erosion: Hydraulic (upstream droplet model) */
class ErosionHydraulic {
    constructor(parameters, resolution, random) {
        this.parameters = parameters;
        this.resolution = resolution;
        this.random = random;
    }
    trace(x, y, heightMap) {
        const ox = (this.random.getFloat() * 2 - 1) * this.parameters.radius * this.resolution;
        const oy = (this.random.getFloat() * 2 - 1) * this.parameters.radius * this.resolution;
        let sediment = 0;
        let xp = x;
        let yp = y;
        let vx = 0;
        let vy = 0;

        for (let i = 0; i < this.parameters.maxIterations; ++i) {
            const n = heightMap.sampleNormal(x + ox, y + oy);
            if (n.y === 1) break;

            const deposit = sediment * this.parameters.depositionRate * n.y;
            const erosion = this.parameters.erosionRate * (1 - n.y) * Math.min(1, i * this.parameters.iterationScale);

            // Change at (xp, yp) using GridSampler-style "change"
            heightMap.sampler.change(xp, yp, deposit - erosion);

            vx = this.parameters.friction * vx + n.x * this.parameters.speed * this.resolution;
            vy = this.parameters.friction * vy + n.z * this.parameters.speed * this.resolution;

            xp = x;
            yp = y;
            x += vx;
            y += vy;
            sediment += erosion - deposit;
        }
    }
    apply(heightMap) {
        const drops = this.parameters.dropsPerCell * (heightMap.xValues - 1) * (heightMap.yValues - 1);

        for (let i = 0; i < drops; ++i) {
            this.trace(this.random.getFloat() * heightMap.xValues * this.resolution, this.random.getFloat() * heightMap.yValues * this.resolution, heightMap);
        }
        heightMap.sampler.blur();
    }
}

/** Volcanoes (upstream) */
class Volcanoes {
    constructor(parameters, random) {
        this.parameters = parameters;
        this.random = random;
    }
    apply(heightMap) {
        const rimNoise = new CubicNoise(Math.ceil(heightMap.xValues * heightMap.resolution * this.parameters.volcanoThresholdScale), Math.ceil(heightMap.yValues * heightMap.resolution * this.parameters.volcanoThresholdScale), this.random);
        const volcanoThreshold = Math.max(this.parameters.volcanoThreshold, heightMap.maxHeight - this.parameters.volcanoMaxDepth * (1 / this.parameters.volcanoCraterScale));

        for (let y = 0; y < heightMap.yValues; ++y) {
            for (let x = 0; x < heightMap.xValues; ++x) {
                const height = heightMap.values[x + y * heightMap.xValues];
                const threshold =
                    (2 * rimNoise.sample(x * heightMap.resolution * this.parameters.volcanoThresholdScale, y * heightMap.resolution * this.parameters.volcanoThresholdScale) - 0.5) * this.parameters.volcanoThresholdAmplitude + volcanoThreshold;

                if (height > threshold) {
                    heightMap.values[x + y * heightMap.xValues] -= (height - threshold) * (1 + this.parameters.volcanoCraterScale);
                }
            }
        }
    }
}

/** Terrain wrapper (upstream sequence, minus ocean) */
class Terrain {
    constructor(parameters, random) {
        this.random = random;
        this.parameters = parameters;
        this.heightMap = null;
    }
    createShape() {
        switch (this.parameters.shape) {
            default:
            case TerrainParameters.SHAPE_CONE:
                return new ShapeCone(this.parameters.width, this.parameters.height, this.parameters.shapePower);
        }
    }
    createHeightMap() {
        this.heightMap = new HeightMap(
            this.parameters.heightMapParameters,
            Math.ceil(this.parameters.width / this.parameters.resolution) + 1,
            Math.ceil(this.parameters.height / this.parameters.resolution) + 1,
            this.parameters.resolution,
            this.createShape(),
            this.random
        );
    }
    erodeCoastal() {
        new ErosionCoastal(this.parameters.erosionCoastalParameters, this.parameters.resolution, this.random).apply(this.heightMap);
    }
    createVolcanoes() {
        new Volcanoes(this.parameters.volcanoesParameters, this.random).apply(this.heightMap);
    }
    erodeHydraulic() {
        new ErosionHydraulic(this.parameters.erosionHydraulicParameters, this.parameters.resolution, this.random).apply(this.heightMap);
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// Landmass (same class API, but upstream geometry pipeline inside)
// ───────────────────────────────────────────────────────────────────────────────
// Landmass.js

// (Assuming you already have the supporting classes imported or in-file: Random, CubicNoise, GridSampler,
//  HeightMapParameters, ErosionHydraulicParameters, ErosionCoastalParameters, VolcanoesParameters,
//  HeightMap, TerrainParameters, Terrain, etc. Adjust paths accordingly.)

export class Landmass {
    /**
     * @param {Scene} scene
     * @param {{
     *   size?: number,              // visual size (world units)
     *   subdivisions?: number,      // grid resolution (N-1)
     *   seed?: number,              // RNG seed
     *   params?: {                  // optional overrides for defaults
     *     shapePower?: number,
     *     heightMapParameters?: HeightMapParameters,
     *     erosionHydraulicParameters?: ErosionHydraulicParameters,
     *     erosionCoastalParameters?: ErosionCoastalParameters,
     *     volcanoesParameters?: VolcanoesParameters,
     *   }
     * }} opts
     */
    constructor(scene, opts = {}) {
        this.scene = scene;
        this.size = opts.size ?? 25; // match upstream width default
        this.subdivisions = opts.subdivisions ?? Math.ceil(this.size / 0.1); // since resolution = 0.1 => subdivisions = size/0.1
        this.seed = (opts.seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
        this.mesh = null;

        // Set up default parameters to match upstream exactly
        const defaultHeightMapParams = new HeightMapParameters(
            6, // octaves
            0.1, // scale
            0.5, // influenceFalloff
            1.7, // scaleFalloff
            30, // amplitude
            4.5 // heightPower
        );
        const defaultErosionHydraulicParams = new ErosionHydraulicParameters(
            0.4, // dropsPerCell
            0.04, // erosionRate
            0.03, // depositionRate
            0.15, // speed
            0.7, // friction
            0.8, // radius
            80, // maxIterations
            0.04 // iterationScale
        );
        const defaultErosionCoastalParams = new ErosionCoastalParameters(
            0.4, // waveHeightMin
            1.2, // waveHeightMax
            0.5, // noiseScale
            3 // power
        );
        const defaultVolcanoesParams = new VolcanoesParameters(
            2.5, // volcanoThreshold
            2, // volcanoThresholdAmplitude
            0.2, // volcanoThresholdScale
            0.5, // volcanoMaxDepth
            0.5 // volcanoCraterScale
        );

        // Combine defaults + overrides
        const params = {
            shapePower: opts.params?.shapePower ?? 1.6,
            heightMapParameters: opts.params?.heightMapParameters ?? defaultHeightMapParams,
            erosionHydraulicParameters: opts.params?.erosionHydraulicParameters ?? defaultErosionHydraulicParams,
            erosionCoastalParameters: opts.params?.erosionCoastalParameters ?? defaultErosionCoastalParams,
            volcanoesParameters: opts.params?.volcanoesParameters ?? defaultVolcanoesParams
        };

        this.params = params;

        // Build the initial terrain
        this._buildTerrain(params);

        this.attachGUI();
    }

    getMesh() {
        return this.mesh;
    }

    dispose() {
        if (this.mesh) {
            this.mesh.dispose();
            this.mesh = null;
        }
    }

    _buildTerrain(paramOverrides) {
        const N = this.subdivisions + 1;
        const resolution = this.size / (N - 1);

        // Build parameters for TerrainParameters
        const terrainParams = new TerrainParameters(
            this.size, // width
            this.size, // height (match original width=25, height=25*2)
            0.5, // water level, match original
            TerrainParameters.SHAPE_CONE,
            paramOverrides.shapePower,
            resolution,
            paramOverrides.heightMapParameters,
            paramOverrides.erosionHydraulicParameters,
            paramOverrides.erosionCoastalParameters,
            paramOverrides.volcanoesParameters
        );

        const random = new Random(this.seed);
        const terrain = new Terrain(terrainParams, random);

        terrain.createHeightMap();
        terrain.erodeCoastal();
        terrain.createVolcanoes();
        terrain.erodeHydraulic();

        this.heightMap = terrain.heightMap;

        // Build mesh from height map
        this._buildMeshFromHeightMap();
        this.createHeightmapDebugTexture();
        this.createSignedDistanceDebugTexture(0.5);
        // this._conformUnderwaterToCircularBasin();
    }

    _waitForTexture(tex) {
        return new Promise((resolve) => {
            if (!tex) return resolve();

            // Already ready?
            if (tex.isReady()) {
                resolve();
                return;
            }

            // Poll until ready (Babylon textures often become ready next frame)
            const check = () => {
                if (tex.isReady()) resolve();
                else requestAnimationFrame(check);
            };
            check();
        });
    }

    _buildMeshFromHeightMap() {
        const hm = this.heightMap;
        const xValues = hm.xValues;
        const yValues = hm.yValues;

        const positions = new Float32Array(xValues * yValues * 3);
        const colors = new Float32Array(xValues * yValues * 4);
        const indices = [];

        let p = 0,
            c = 0;
        const half = this.size * 0.5;

        for (let y = 0; y < yValues; ++y) {
            for (let x = 0; x < xValues; ++x) {
                const h = hm.values[x + y * xValues];
                positions[p++] = (x / (xValues - 1)) * this.size - half; // X
                positions[p++] = h; // Y
                positions[p++] = (y / (yValues - 1)) * this.size - half; // Z

                // Simple height-based color
                let r, g, b;
                if (h < 0.25) {
                    r = 0.2;
                    g = 0.3;
                    b = 0.6;
                } else if (h < 5.0) {
                    r = 0.4;
                    g = 0.7;
                    b = 0.4;
                } else if (h < 15.0) {
                    r = 0.6;
                    g = 0.5;
                    b = 0.35;
                } else {
                    r = 0.82;
                    g = 0.82;
                    b = 0.82;
                }

                colors[c++] = r;
                colors[c++] = g;
                colors[c++] = b;
                colors[c++] = 1.0;
            }
        }

        for (let y = 0; y < yValues - 1; ++y) {
            for (let x = 0; x < xValues - 1; ++x) {
                const iLT = x + y * xValues;
                const iRT = iLT + 1;
                const iLB = x + (y + 1) * xValues;
                const iRB = iLB + 1;

                const hLT = hm.values[iLT];
                const hRT = hm.values[iRT];
                const hLB = hm.values[iLB];
                const hRB = hm.values[iRB];

                if (Math.abs(hRB - hLT) > Math.abs(hRT - hLB)) {
                    indices.push(iLB, iLT, iRT, iRT, iRB, iLB);
                } else {
                    indices.push(iLT, iRT, iRB, iRB, iLB, iLT);
                }
            }
        }

        const mesh = new Mesh('island', this.scene);
        const vd = new VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.colors = colors;
        vd.normals = [];
        VertexData.ComputeNormals(positions, indices, vd.normals);
        vd.applyToMesh(mesh, true);

        const mat = new StandardMaterial('islandMat', this.scene);
        mat.specularColor = Color3.Black();
        mat.diffuseColor = Color3.White();
        mesh.material = mat;

        this.mesh = mesh;

        // After mesh build, optionally apply seabed shaping or other post-process
        // (you may call this later from GUI updates)
    }
    /**
     * FINAL — AUTONOMOUS SEABED GENERATOR
     * Uses SDF extrusion. Produces a NEW mesh and replaces this.mesh.
     */
    _conformUnderwaterToCircularBasin() {
        const mesh = this.mesh;
        const hm = this.heightMap;
        if (!mesh || !hm) return;

        console.log('=== SEABED (SDF) START ===');

        const W = hm.xValues;
        const H = hm.yValues;
        const vals = hm.values;
        const size = this.size;
        const half = size * 0.5;

        // -------------------------------------------------------
        // 1. Auto-detect waterline (15% lowest values = water)
        // -------------------------------------------------------
        const sorted = [...vals].sort((a, b) => a - b);
        const waterline = sorted[Math.floor(sorted.length * 0.15)];

        let minH = sorted[0];
        let maxH = sorted[sorted.length - 1];

        console.log('autoWaterline =', waterline, '(minH:', minH, 'maxH:', maxH, ')');

        // -------------------------------------------------------
        // 2. Build land/water mask
        //   mask[k] = 1 → water, 0 → land
        // -------------------------------------------------------
        const mask = new Uint8Array(W * H);
        for (let k = 0; k < vals.length; k++) mask[k] = vals[k] < waterline ? 1 : 0;

        // -------------------------------------------------------
        // 3. Compute SDF (signed distance field)
        // -------------------------------------------------------
        const sdf = this._edtSigned(mask, W, H);

        // -------------------------------------------------------
        // 4. Extract original mesh data and CONVERT TO JS ARRAYS
        // -------------------------------------------------------
        const pos0 = mesh.getVerticesData('position');
        const col0 = mesh.getVerticesData('color') || new Float32Array((pos0.length / 3) * 4);
        const ind0 = mesh.getIndices();

        const outPos = Array.from(pos0);
        const outCol = Array.from(col0);
        const outInd = Array.from(ind0);

        // Add vertex helper
        const addV = (x, y, z, c) => {
            outPos.push(x, y, z);
            outCol.push(c[0], c[1], c[2], 1);
            return outPos.length / 3 - 1;
        };

        // -------------------------------------------------------
        // 5. Build seabed vertices (one per heightmap sample)
        // -------------------------------------------------------
        const seabedIdx = new Array(W * H);

        const maxDepth = size * 2;
        const falloff = size * 0.35;

        const seabedY = (d) => {
            // d > 0 = inside water → go down
            // d < 0 = inside land  → use terrain height
            if (d <= 0) return null;
            return waterline - maxDepth * (1 - Math.exp(-d / falloff));
        };

        // seabed color
        const seabedColor = [0.15, 0.19, 0.23];

        for (let j = 0; j < H; j++) {
            for (let i = 0; i < W; i++) {
                const k = i + j * W;
                const x = (i / (W - 1)) * size - half;
                const z = (j / (H - 1)) * size - half;

                let y;

                if (mask[k] === 0) {
                    // land → place seabed exactly at terrain height (flat underside)
                    y = vals[k];
                } else {
                    // water → SDF extruded depth
                    y = seabedY(sdf[k]);
                    if (y === null) y = vals[k];
                }

                seabedIdx[k] = addV(x, y, z, seabedColor);
            }
        }

        // -------------------------------------------------------
        // 6. Build watertight underside triangles
        // -------------------------------------------------------
        for (let j = 0; j < H - 1; j++) {
            for (let i = 0; i < W - 1; i++) {
                const k00 = seabedIdx[i + j * W];
                const k10 = seabedIdx[i + 1 + j * W];
                const k11 = seabedIdx[i + 1 + (j + 1) * W];
                const k01 = seabedIdx[i + (j + 1) * W];

                // Two triangles per cell
                outInd.push(k00, k10, k11);
                outInd.push(k00, k11, k01);
            }
        }

        // -------------------------------------------------------
        // 7. Recompute normals & build NEW mesh
        // -------------------------------------------------------
        const normals = [];
        VertexData.ComputeNormals(outPos, outInd, normals);

        const newMesh = new Mesh('island_with_seabed', this.scene);

        const vd = new VertexData();
        vd.positions = new Float32Array(outPos);
        vd.indices = outInd;
        vd.normals = new Float32Array(normals);
        vd.colors = new Float32Array(outCol);
        vd.applyToMesh(newMesh);

        // Replace original mesh
        mesh.dispose();
        this.mesh = newMesh;

        console.log('=== SEABED (SDF) COMPLETE ===');
    }

    _edtSigned(mask, W, H) {
        // 0 = land 1 = water
        const INF = 1e12;

        const f = new Float32Array(W * H);

        // init: coastline = 0, others = INF
        for (let j = 0; j < H; j++) {
            for (let i = 0; i < W; i++) {
                const k = i + j * W;
                const m = mask[k];
                let edge = false;
                if (i > 0 && mask[k - 1] !== m) edge = true;
                if (i < W - 1 && mask[k + 1] !== m) edge = true;
                if (j > 0 && mask[k - W] !== m) edge = true;
                if (j < H - 1 && mask[k + W] !== m) edge = true;
                f[k] = edge ? 0 : INF;
            }
        }

        const edt1D = (f, n) => {
            const d = new Float32Array(n),
                v = new Int32Array(n),
                z = new Float32Array(n + 1);
            let k = 0;
            v[0] = 0;
            z[0] = -Infinity;
            z[1] = Infinity;
            for (let q = 1; q < n; q++) {
                let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
                while (s <= z[k]) {
                    k--;
                    s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
                }
                k++;
                v[k] = q;
                z[k] = s;
                z[k + 1] = Infinity;
            }
            k = 0;
            for (let q = 0; q < n; q++) {
                while (z[k + 1] < q) k++;
                const dx = q - v[k];
                d[q] = dx * dx + f[v[k]];
            }
            return d;
        };

        // pass 1 (horizontal)
        let tmp = new Float32Array(W * H);
        for (let j = 0; j < H; j++) {
            const row = f.subarray(j * W, j * W + W);
            tmp.set(edt1D(row, W), j * W);
        }

        // pass 2 (vertical)
        for (let i = 0; i < W; i++) {
            const col = new Float32Array(H);
            for (let j = 0; j < H; j++) col[j] = tmp[i + j * W];
            const d = edt1D(col, H);
            for (let j = 0; j < H; j++) f[i + j * W] = Math.sqrt(d[j]);
        }

        // signed distance
        const sdf = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) sdf[i] = mask[i] ? f[i] : -f[i];

        return sdf;
    }

    /**
     * Create a normalized grayscale heightmap texture that appears in Babylon Inspector.
     * - Uses RawTexture
     * - 8-bit single channel (LUMINANCE)
     * - Not bound anywhere, only for debug/inspection
     */
    createHeightmapDebugTexture() {
        if (!this.scene || !this.heightMap) {
            console.warn('Heightmap or scene missing');
            return null;
        }

        const hm = this.heightMap;
        const W = hm.xValues;
        const H = hm.yValues;
        const vals = hm.values;

        // Compute min/max
        let minH = Infinity,
            maxH = -Infinity;
        for (let i = 0; i < vals.length; i++) {
            const h = vals[i];
            if (h < minH) minH = h;
            if (h > maxH) maxH = h;
        }

        const range = maxH - minH || 1;

        // Create 8-bit grayscale buffer
        const buffer = new Uint8Array(W * H);

        for (let i = 0; i < vals.length; i++) {
            const norm = (vals[i] - minH) / range; // 0–1
            buffer[i] = Math.floor(norm * 255); // 0–255
        }

        // Create the RawTexture correctly with full signature
        const tex = new RawTexture(
            buffer,
            W,
            H,
            Engine.TEXTUREFORMAT_LUMINANCE, // single channel
            this.scene,
            false, // generateMipMaps
            false, // invertY
            Texture.NEAREST_SAMPLINGMODE, // keep it sharp in inspector
            Engine.TEXTURETYPE_UNSIGNED_INT, // type (UInt8)
            undefined, // creationFlags
            false, // useSRGBBuffer
            false // waitDataToBeReady
        );

        tex.name = 'HeightmapDebugTexture';
        this.heightmapDebugTexture = tex;
        console.log('Created HeightmapDebugTexture', tex, 'min =', minH, 'max =', maxH);

        return tex;
    }
    _waitForEffect(effectWrapper) {
        return new Promise((resolve) => {
            if (effectWrapper.effect && effectWrapper.effect.isReady()) {
                resolve();
                return;
            }
            effectWrapper.onCompiled = () => resolve();
            // force compilation
            effectWrapper.effect._prepareEffect();
        });
    }

    /**
     * Create a signed distance field from the heightmap texture.
     * Output:
     *   this.signedDistanceDebugTexture  → RawTexture (R32F)
     *   this.signedDistanceCPU           → Float32Array of size W*H
     */
    async createSignedDistanceDebugTexture(waterline = 0.5) {

    if (!this.heightmapDebugTexture)
        this.createHeightmapDebugTexture();

    await this._waitForTexture(this.heightmapDebugTexture);

    const scene   = this.scene;
    const engine  = scene.getEngine();
    const srcTex  = this.heightmapDebugTexture;

    const W = srcTex.getSize().width;
    const H = srcTex.getSize().height;
    const resolution = new Vector2(W, H);

    // =============================================================
    // FIXED SHADERS (WebGL2 + MRT-safe)
    // =============================================================

    const seedFS = `
        #version 300 es
        precision highp float;

        in vec2 vUV;
        layout(location = 0) out vec4 fragColor;

        uniform sampler2D heightmap;
        uniform float waterline;
        uniform vec2 resolution;

        void main() {

            float h = texture(heightmap, vUV).r;

            vec2 uv = vUV * resolution;
            bool isWater = h < waterline;

            vec2 ext = isWater ? vec2(1e6) : uv;
            vec2 inn = isWater ? uv : vec2(1e6);

            fragColor = vec4(ext, inn);
        }
    `;

    const jfaFS = `
        #version 300 es
        precision highp float;

        in vec2 vUV;
        layout(location = 0) out vec4 fragColor;

        uniform sampler2D prev;
        uniform float jump;
        uniform vec2 resolution;

        float d2(vec2 a, vec2 b) {
            vec2 d = a - b;
            return dot(d, d);
        }

        void main() {
            vec2 uv = vUV * resolution;
            vec4 root = texture(prev, vUV);

            vec2 bestExt = root.xy;
            vec2 bestInn = root.zw;

            for (int dx = -1; dx <= 1; dx++) {
                for (int dy = -1; dy <= 1; dy++) {

                    vec2 offs = vec2(float(dx), float(dy)) * jump;
                    vec2 uv2  = (uv + offs) / resolution;

                    vec4 cand = texture(prev, uv2);

                    if (d2(uv, cand.xy) < d2(uv, bestExt)) bestExt = cand.xy;
                    if (d2(uv, cand.zw) < d2(uv, bestInn)) bestInn = cand.zw;
                }
            }

            fragColor = vec4(bestExt, bestInn);
        }
    `;

    const finalFS = `
        #version 300 es
        precision highp float;

        in vec2 vUV;
        layout(location = 0) out vec4 fragColor;

        uniform sampler2D roots;
        uniform vec2 resolution;

        void main() {
            vec2 uv = vUV * resolution;
            vec4 r  = texture(roots, vUV);

            float distExt = length(uv - r.xy);
            float distInn = length(uv - r.zw);

            float signedDist = distExt - distInn;

            fragColor = vec4(signedDist, 0.0, 0.0, 1.0);
        }
    `;

    // =============================================================
    // RTT setup (single attachment)
    // =============================================================

    const seedRT  = new RenderTargetTexture("sdf_seed",  { width: W, height: H }, scene, false, true, Texture.BILINEAR_SAMPLINGMODE);
    const jfaA    = new RenderTargetTexture("sdf_jfaA",  { width: W, height: H }, scene, false, true, Texture.BILINEAR_SAMPLINGMODE);
    const jfaB    = new RenderTargetTexture("sdf_jfaB",  { width: W, height: H }, scene, false, true, Texture.BILINEAR_SAMPLINGMODE);
    const finalRT = new RenderTargetTexture("sdf_final", { width: W, height: H }, scene, false, true, Texture.BILINEAR_SAMPLINGMODE);

    const renderer = new EffectRenderer(engine);

    // utility
    const waitFor = wrapper =>
        new Promise(res => {
            wrapper.onCompiled = () => res();
            wrapper.effect._prepareEffect();
        });

    // EffectWrappers
    const seedFX = new EffectWrapper({
        engine,
        name: "seed",
        fragmentShader: seedFS,
        samplerNames: ["heightmap"],
        uniformNames: ["waterline", "resolution"],
    });

    const jfaFX = new EffectWrapper({
        engine,
        name: "jfa",
        fragmentShader: jfaFS,
        samplerNames: ["prev"],
        uniformNames: ["jump", "resolution"],
    });

    const finalFX = new EffectWrapper({
        engine,
        name: "final",
        fragmentShader: finalFS,
        samplerNames: ["roots"],
        uniformNames: ["resolution"],
    });

    await waitFor(seedFX);
    await waitFor(jfaFX);
    await waitFor(finalFX);

    // =============================================================
    // Seed
    // =============================================================

    seedFX.effect.setTexture("heightmap", srcTex);
    seedFX.effect.setFloat("waterline", waterline);
    seedFX.effect.setVector2("resolution", resolution);

    renderer.render(seedFX, seedRT);

    // =============================================================
    // JFA passes
    // =============================================================

    let src = seedRT;
    let dst = jfaA;
    const steps = Math.ceil(Math.log2(Math.max(W, H)));

    for (let i = steps; i >= 0; i--) {
        const jump = Math.pow(2, i);

        jfaFX.effect.setTexture("prev", src);
        jfaFX.effect.setFloat("jump", jump);
        jfaFX.effect.setVector2("resolution", resolution);

        renderer.render(jfaFX, dst);

        const tmp = src;
        src = dst;
        dst = tmp === jfaA ? jfaB : jfaA;
    }

    // =============================================================
    // Final
    // =============================================================

    finalFX.effect.setTexture("roots", src);
    finalFX.effect.setVector2("resolution", resolution);

    renderer.render(finalFX, finalRT);

    this.signedDistanceDebugTexture = finalRT;

    console.log("SDF generated", finalRT);

    return finalRT;
}

    /**
     * Adds a debug GUI for live tweaking of parameters.
     * Call after construction when you want interactive controls.
     */
    attachGUI() {
        if (!WINDOW_CONTEXT?.is_dev) return;

        let gui;
        if (window.__GLOBAL_LIL_GUI__) gui = window.__GLOBAL_LIL_GUI__;
        else {
            gui = new GUI({ title: 'Procedural Controls', width: 380 });
            window.__GLOBAL_LIL_GUI__ = gui;
        }

        const existing = gui.folders?.find?.((f) => f._title === '🏝️ Island Generator');
        if (existing) existing.destroy();

        const folder = gui.addFolder('🏝️ Island Generator');

        const params = {
            // Shape
            shapePower: this.params.shapePower,

            // Noise basis
            octaves: this.params.heightMapParameters.octaves,
            scale: this.params.heightMapParameters.scale,
            influenceFalloff: this.params.heightMapParameters.influenceFalloff,
            scaleFalloff: this.params.heightMapParameters.scaleFalloff,
            amplitude: this.params.heightMapParameters.amplitude,
            heightPower: this.params.heightParameters?.heightPower ?? this.params.heightMapParameters.heightPower,

            // Erosion - hydraulic
            dropsPerCell: this.params.erosionHydraulicParameters.dropsPerCell,
            erosionRate: this.params.erosionRate ?? this.params.erosionHydraulicParameters.erosionRate,
            depositionRate: this.params.depositionRate ?? this.params.erosionHydraulicParameters.depositionRate,
            speed: this.params.erosionHydraulicParameters.speed,
            friction: this.params.erosionHydraulicParameters.friction,
            radius: this.params.erosionHydraulicParameters.radius,
            maxIterations: this.params.erosionHydraulicParameters.maxIterations,
            iterationScale: this.params.erosionHydraulicParameters.iterationScale,

            // Erosion - coastal
            waveHeightMin: this.params.erosionCoastalParameters.waveHeightMin,
            waveHeightMax: this.params.erosionCoastalParameters.waveHeightMax,
            noiseScale: this.params.erosionCoastalParameters.noiseScale,
            coastalPower: this.params.erosionCoastalParameters.power,

            // Volcanoes
            volcanoThreshold: this.params.volcanoesParameters.volcanoThreshold,
            volcanoThresholdAmplitude: this.params.volcanoesParameters.volcanoThresholdAmplitude,
            volcanoThresholdScale: this.params.volcanoesParameters.volcanoThresholdScale,
            volcanoMaxDepth: this.params.volcanoesParameters.volcanoMaxDepth,
            volcanoCraterScale: this.params.volcanoesParameters.volcanoCraterScale,

            // Seabed shaping
            seabedWallWidth: this.size * 0.6,
            seabedDepth: this.size * 2,
            seabedExponent: 3,
            waterline: 3
        };

        const rebuild = () => {
            this.dispose();
            const hmParams = new HeightMapParameters(params.octaves, params.scale, params.influenceFalloff, params.scaleFalloff, params.amplitude, params.heightPower);

            const hydroParams = new ErosionHydraulicParameters(params.dropsPerCell, params.erosionRate, params.depositionRate, params.speed, params.friction, params.radius, params.maxIterations, params.iterationScale);

            const coastalParams = new ErosionCoastalParameters(params.waveHeightMin, params.waveHeightMax, params.noiseScale, params.coastalPower);

            const volcParams = new VolcanoesParameters(params.volcanoThreshold, params.volcanoThresholdAmplitude, params.volcanoThresholdScale, params.volcanoMaxDepth, params.volcanoCraterScale);

            this.params = {
                shapePower: params.shapePower,
                heightMapParameters: hmParams,
                erosionHydraulicParameters: hydroParams,
                erosionCoastalParameters: coastalParams,
                volcanoesParameters: volcParams
            };

            this._buildTerrain(this.params);
        };

        const updateSeabed = () => {
            this._conformUnderwaterToCircularBasin({
                wallWidth: params.seabedWallWidth,
                maxDepth: params.seabedDepth,
                wallExponent: params.seabedExponent,
                waterline: params.waterline
            });
        };

        // GUI layout
        const fShape = folder.addFolder('Shape');
        fShape.add(params, 'shapePower', 0.1, 8, 0.1).onChange(rebuild);

        const fNoise = folder.addFolder('Noise Basis');
        fNoise.add(params, 'octaves', 1, 12, 1).onChange(rebuild);
        fNoise.add(params, 'scale', 0.001, 2.0, 0.001).onChange(rebuild);
        fNoise.add(params, 'influenceFalloff', 0.1, 2.0, 0.01).onChange(rebuild);
        fNoise.add(params, 'scaleFalloff', 0.5, 5.0, 0.01).onChange(rebuild);
        fNoise.add(params, 'amplitude', 1, 300, 1).onChange(rebuild);
        fNoise.add(params, 'heightPower', 0.1, 10, 0.1).onChange(rebuild);

        const fErosionH = folder.addFolder('Erosion — Hydraulic');
        fErosionH.add(params, 'dropsPerCell', 0.1, 1.0, 0.01).onChange(rebuild);
        fErosionH.add(params, 'erosionRate', 0.001, 0.5, 0.001).onChange(rebuild);
        fErosionH.add(params, 'depositionRate', 0.001, 0.5, 0.001).onChange(rebuild);
        fErosionH.add(params, 'speed', 0.01, 1.0, 0.01).onChange(rebuild);
        fErosionH.add(params, 'friction', 0.0, 1.0, 0.01).onChange(rebuild);
        fErosionH.add(params, 'radius', 0.1, 5.0, 0.1).onChange(rebuild);
        fErosionH.add(params, 'maxIterations', 10, 300, 1).onChange(rebuild);
        fErosionH.add(params, 'iterationScale', 0.001, 0.2, 0.001).onChange(rebuild);

        const fErosionC = folder.addFolder('Erosion — Coastal');
        fErosionC.add(params, 'waveHeightMin', 0.0, 5.0, 0.1).onChange(rebuild);
        fErosionC.add(params, 'waveHeightMax', 0.0, 5.0, 0.1).onChange(rebuild);
        fErosionC.add(params, 'noiseScale', 0.01, 2.0, 0.01).onChange(rebuild);
        fErosionC.add(params, 'coastalPower', 0.1, 10, 0.1).onChange(rebuild);

        const fVolc = folder.addFolder('Volcanoes');
        fVolc.add(params, 'volcanoThreshold', 0, 10, 0.1).onChange(rebuild);
        fVolc.add(params, 'volcanoThresholdAmplitude', 0, 10, 0.1).onChange(rebuild);
        fVolc.add(params, 'volcanoThresholdScale', 0.01, 5, 0.01).onChange(rebuild);
        fVolc.add(params, 'volcanoMaxDepth', 0, 5, 0.05).onChange(rebuild);
        fVolc.add(params, 'volcanoCraterScale', 0.1, 3, 0.05).onChange(rebuild);

        const fSea = folder.addFolder('Seabed');
        fSea.add(params, 'seabedWallWidth', 5, 200, 1).onChange(updateSeabed);
        fSea.add(params, 'seabedDepth', 10, 500, 1).onChange(updateSeabed);
        fSea.add(params, 'seabedExponent', 0.5, 10, 0.1).onChange(updateSeabed);
        fSea.add(params, 'waterline', -50, 50, 1).onChange(updateSeabed);

        folder
            .add(
                {
                    randomizeSeed: () => {
                        this.seed = Math.floor(Math.random() * 0xffffffff);
                        rebuild();
                    }
                },
                'randomizeSeed'
            )
            .name('🎲 New Seed');

        folder.open();
    }
}
