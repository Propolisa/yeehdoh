// biome/Landmass.js
import { WINDOW_CONTEXT } from "@/lib/helpers"; // same as Water
import { Engine, RawTexture, Scene, Texture } from "@babylonjs/core";
import GUI from "lil-gui";
import { applyProceduralPBR, SkirtForHeightmap } from "./SkirtFromHeightmap";
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

    for (let i = 0; i < this.values.length; ++i) {
        this.values[i] = randomizer.getFloat();
    }
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
                this.interpolate(
                    this.values[yi * this.width + xi],
                    this.values[yi * this.width + xi + 1],
                    this.values[yi * this.width + xi + 2],
                    this.values[yi * this.width + xi + 3],
                    x - xi,
                ),
                this.interpolate(
                    this.values[(yi + 1) * this.width + xi],
                    this.values[(yi + 1) * this.width + xi + 1],
                    this.values[(yi + 1) * this.width + xi + 2],
                    this.values[(yi + 1) * this.width + xi + 3],
                    x - xi,
                ),
                this.interpolate(
                    this.values[(yi + 2) * this.width + xi],
                    this.values[(yi + 2) * this.width + xi + 1],
                    this.values[(yi + 2) * this.width + xi + 2],
                    this.values[(yi + 2) * this.width + xi + 3],
                    x - xi,
                ),
                this.interpolate(
                    this.values[(yi + 3) * this.width + xi],
                    this.values[(yi + 3) * this.width + xi + 1],
                    this.values[(yi + 3) * this.width + xi + 2],
                    this.values[(yi + 3) * this.width + xi + 3],
                    x - xi,
                ),
                y - yi,
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
        if (xi >= this.width - 1 || yi >= this.height - 1) {
            return this.defaultValue;
        }

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
        this.values[xi + 1 + (yi + 1) * this.width] += (1 - fx) * (1 - fy) *
            delta;
    }
    blur() {
        const newValues = new Array((this.width - 2) * (this.height - 2));
        for (let y = 1; y < this.height - 1; ++y) {
            for (let x = 1; x < this.width - 1; ++x) {
                newValues[x - 1 + (y - 1) * (this.width - 2)] =
                    (this.values[x - 1 + y * this.width] +
                            this.values[x + (y - 1) * this.width] +
                            this.values[x + 1 + y * this.width] +
                            this.values[x + (y + 1) * this.width]) * 0.125 +
                    (this.values[x - 1 + (y - 1) * this.width] +
                            this.values[x + 1 + (y - 1) * this.width] +
                            this.values[x + 1 + (y + 1) * this.width] +
                            this.values[x - 1 + (y + 1) * this.width]) *
                        0.0625 +
                    this.values[x + y * this.width] * 0.25;
            }
        }
        for (let y = 1; y < this.height - 1; ++y) {
            for (let x = 1; x < this.width - 1; ++x) {
                this.values[x + y * this.width] =
                    newValues[x - 1 + (y - 1) * (this.width - 2)];
            }
        }
    }
}

/** Parameters (upstream defaults) */
class HeightMapParameters {
    constructor(
        octaves = 6,
        scale = 0.1,
        influenceFalloff = 0.5,
        scaleFalloff = 1.7,
        amplitude = 30,
        heightPower = 4.5,
    ) {
        this.octaves = octaves;
        this.scale = scale;
        this.influenceFalloff = influenceFalloff;
        this.scaleFalloff = scaleFalloff;
        this.amplitude = amplitude;
        this.heightPower = heightPower;
    }
}
class ErosionHydraulicParameters {
    constructor(
        dropsPerCell = 0.4,
        erosionRate = 0.04,
        depositionRate = 0.03,
        speed = 0.15,
        friction = 0.7,
        radius = 0.8,
        maxIterations = 80,
        iterationScale = 0.04,
    ) {
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
    constructor(
        waveHeightMin = 0.4,
        waveHeightMax = 1.2,
        noiseScale = 0.5,
        power = 3,
    ) {
        this.waveHeightMin = waveHeightMin;
        this.waveHeightMax = waveHeightMax;
        this.noiseScale = noiseScale;
        this.power = power;
    }
}
class VolcanoesParameters {
    constructor(
        volcanoThreshold = 2.5,
        volcanoThresholdAmplitude = 2,
        volcanoThresholdScale = 0.2,
        volcanoMaxDepth = 0.5,
        volcanoCraterScale = 0.5,
    ) {
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
        shape = "cone",
        shapePower = 1.6,
        resolution = 0.1,
        heightMapParameters = new HeightMapParameters(),
        erosionHydraulicParameters = new ErosionHydraulicParameters(),
        erosionCoastalParameters = new ErosionCoastalParameters(),
        volcanoesParameters = new VolcanoesParameters(),
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
TerrainParameters.SHAPE_CONE = "cone";

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
        return Math.cos(
                    Math.PI *
                        Math.min(1, 2 * Math.sqrt(dx * dx + dy * dy)) **
                            this.power,
                ) * 0.5 + 0.5;
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
        this.sampler = new GridSampler(
            this.xValues,
            this.yValues,
            this.values,
            1 / resolution,
        );
        this.maxHeight = 0;
        this.generate();
    }
    createNoises() {
        const noises = new Array(this.parameters.octaves);
        let scale = this.parameters.scale;
        for (let octave = 0; octave < this.parameters.octaves; ++octave) {
            // Assumes global CubicNoise available (as you noted)
            noises[octave] = new CubicNoise(
                Math.ceil(scale * this.xValues),
                Math.ceil(scale * this.yValues),
                this.random,
            );
            scale *= this.parameters.scaleFalloff;
        }
        return noises;
    }
    makeInfluences(octaves, falloff) {
        const influences = new Array(octaves);
        const iFalloff = 1 / falloff;
        let influence = ((iFalloff - 1) * iFalloff ** octaves) /
            (iFalloff ** octaves - 1) / iFalloff;
        for (let octave = 0; octave < octaves; ++octave) {
            influences[octave] = influence;
            if (octave !== octaves - 1) influence *= falloff;
        }
        return influences;
    }
    generate() {
        const noises = this.createNoises();
        const influences = this.makeInfluences(
            this.parameters.octaves,
            this.parameters.influenceFalloff,
        );
        for (let y = 0; y < this.yValues; ++y) {
            for (let x = 0; x < this.xValues; ++x) {
                const index = x + y * this.xValues;
                let scale = this.parameters.scale * this.resolution;
                let height = 0;
                for (
                    let octave = 0; octave < this.parameters.octaves; ++octave
                ) {
                    height += noises[octave].sample(x * scale, y * scale) *
                        influences[octave];
                    if (octave !== this.parameters.octaves - 1) {
                        scale *= this.parameters.scaleFalloff;
                    }
                }
                this.values[index] = height ** this.parameters.heightPower *
                    this.parameters.amplitude *
                    this.shape.sample(x * this.resolution, y * this.resolution);
                if (this.maxHeight < this.values[index]) {
                    this.maxHeight = this.values[index];
                }
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
        const noise = new CubicNoise(
            Math.ceil(
                heightMap.xValues * this.resolution *
                    this.parameters.noiseScale,
            ),
            Math.ceil(
                heightMap.yValues * this.resolution *
                    this.parameters.noiseScale,
            ),
            this.random,
        );
        for (let y = 0; y < heightMap.yValues; ++y) {
            for (let x = 0; x < heightMap.xValues; ++x) {
                const index = x + y * heightMap.xValues;
                const threshold = this.parameters.waveHeightMin +
                    noise.sample(
                            x * this.resolution * this.parameters.noiseScale,
                            y * this.resolution * this.parameters.noiseScale,
                        ) *
                        (this.parameters.waveHeightMax -
                            this.parameters.waveHeightMin);

                if (heightMap.values[index] < threshold) {
                    heightMap.values[index] *=
                        (heightMap.values[index] / threshold) **
                            this.parameters.power;
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
        const ox = (this.random.getFloat() * 2 - 1) * this.parameters.radius *
            this.resolution;
        const oy = (this.random.getFloat() * 2 - 1) * this.parameters.radius *
            this.resolution;
        let sediment = 0;
        let xp = x;
        let yp = y;
        let vx = 0;
        let vy = 0;

        for (let i = 0; i < this.parameters.maxIterations; ++i) {
            const n = heightMap.sampleNormal(x + ox, y + oy);
            if (n.y === 1) break;

            const deposit = sediment * this.parameters.depositionRate * n.y;
            const erosion = this.parameters.erosionRate * (1 - n.y) *
                Math.min(1, i * this.parameters.iterationScale);

            // Change at (xp, yp) using GridSampler-style "change"
            heightMap.sampler.change(xp, yp, deposit - erosion);

            vx = this.parameters.friction * vx +
                n.x * this.parameters.speed * this.resolution;
            vy = this.parameters.friction * vy +
                n.z * this.parameters.speed * this.resolution;

            xp = x;
            yp = y;
            x += vx;
            y += vy;
            sediment += erosion - deposit;
        }
    }
    apply(heightMap) {
        const drops = this.parameters.dropsPerCell * (heightMap.xValues - 1) *
            (heightMap.yValues - 1);

        for (let i = 0; i < drops; ++i) {
            this.trace(
                this.random.getFloat() * heightMap.xValues * this.resolution,
                this.random.getFloat() * heightMap.yValues * this.resolution,
                heightMap,
            );
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
        const rimNoise = new CubicNoise(
            Math.ceil(
                heightMap.xValues * heightMap.resolution *
                    this.parameters.volcanoThresholdScale,
            ),
            Math.ceil(
                heightMap.yValues * heightMap.resolution *
                    this.parameters.volcanoThresholdScale,
            ),
            this.random,
        );
        const volcanoThreshold = Math.max(
            this.parameters.volcanoThreshold,
            heightMap.maxHeight -
                this.parameters.volcanoMaxDepth *
                    (1 / this.parameters.volcanoCraterScale),
        );

        for (let y = 0; y < heightMap.yValues; ++y) {
            for (let x = 0; x < heightMap.xValues; ++x) {
                const height = heightMap.values[x + y * heightMap.xValues];
                const threshold =
                    (2 *
                                rimNoise.sample(
                                    x * heightMap.resolution *
                                        this.parameters.volcanoThresholdScale,
                                    y * heightMap.resolution *
                                        this.parameters.volcanoThresholdScale,
                                ) - 0.5) *
                        this.parameters.volcanoThresholdAmplitude +
                    volcanoThreshold;

                if (height > threshold) {
                    heightMap.values[x + y * heightMap.xValues] -=
                        (height - threshold) *
                        (1 + this.parameters.volcanoCraterScale);
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
                return new ShapeCone(
                    this.parameters.width,
                    this.parameters.height,
                    this.parameters.shapePower,
                );
        }
    }
    createHeightMap() {
        this.heightMap = new HeightMap(
            this.parameters.heightMapParameters,
            Math.ceil(this.parameters.width / this.parameters.resolution) + 1,
            Math.ceil(this.parameters.height / this.parameters.resolution) + 1,
            this.parameters.resolution,
            this.createShape(),
            this.random,
        );
    }
    erodeCoastal() {
        new ErosionCoastal(
            this.parameters.erosionCoastalParameters,
            this.parameters.resolution,
            this.random,
        ).apply(this.heightMap);
    }
    createVolcanoes() {
        new Volcanoes(this.parameters.volcanoesParameters, this.random).apply(
            this.heightMap,
        );
    }
    erodeHydraulic() {
        new ErosionHydraulic(
            this.parameters.erosionHydraulicParameters,
            this.parameters.resolution,
            this.random,
        ).apply(this.heightMap);
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
        this.size = opts.size ?? 50; // match upstream width default
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
            4.5, // heightPower
        );
        const defaultErosionHydraulicParams = new ErosionHydraulicParameters(
            0.4, // dropsPerCell
            0.04, // erosionRate
            0.03, // depositionRate
            0.15, // speed
            0.7, // friction
            0.8, // radius
            80, // maxIterations
            0.04, // iterationScale
        );
        const defaultErosionCoastalParams = new ErosionCoastalParameters(
            0.4, // waveHeightMin
            1.2, // waveHeightMax
            0.5, // noiseScale
            3, // power
        );
        const defaultVolcanoesParams = new VolcanoesParameters(
            2.5, // volcanoThreshold
            2, // volcanoThresholdAmplitude
            0.2, // volcanoThresholdScale
            0.5, // volcanoMaxDepth
            0.5, // volcanoCraterScale
        );

        // Combine defaults + overrides
        const params = {
            shapePower: opts.params?.shapePower ?? 1.6,
            heightMapParameters: opts.params?.heightMapParameters ??
                defaultHeightMapParams,
            erosionHydraulicParameters:
                opts.params?.erosionHydraulicParameters ??
                    defaultErosionHydraulicParams,
            erosionCoastalParameters: opts.params?.erosionCoastalParameters ??
                defaultErosionCoastalParams,
            volcanoesParameters: opts.params?.volcanoesParameters ??
                defaultVolcanoesParams,
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
            paramOverrides.volcanoesParameters,
        );

        const random = new Random(this.seed);
        const terrain = new Terrain(terrainParams, random);

        terrain.createHeightMap();
        terrain.erodeCoastal();
        terrain.createVolcanoes();
        terrain.erodeHydraulic();

        this.heightMap = terrain.heightMap;

        // Build mesh from height map

        this.createHeightmapDebugTexture();

        this.heightmap_skirt = this.heightmap_skirt ||
            new SkirtForHeightmap(this.heightmapDebugTexture, this.scene);
        this._waitForTexture(this.heightmapDebugTexture)
            .then(() =>
                this.heightmap_skirt.initialized
                    ? this.heightmap_skirt.update(this.heightmapDebugTexture)
                    : this.heightmap_skirt.initialize(
                        this.heightmapDebugTexture,
                    )
            ).then((mesh) => {
                applyProceduralPBR(mesh, this.scene);
            });

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

    /**
     * Create a normalized grayscale heightmap texture that appears in Babylon Inspector.
     * - Uses RawTexture
     * - 8-bit single channel (LUMINANCE)
     * - Not bound anywhere, only for debug/inspection
     */
    createHeightmapDebugTexture() {
        if (!this.scene || !this.heightMap) {
            console.warn("Heightmap or scene missing");
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
            false, // waitDataToBeReady
        );

        tex.name = "HeightmapDebugTexture";
        this.heightmapDebugTexture = tex;
        console.log(
            "Created HeightmapDebugTexture",
            tex,
            "min =",
            minH,
            "max =",
            maxH,
        );

        return tex;
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
            gui = new GUI({ title: "Procedural Controls", width: 380 });
            window.__GLOBAL_LIL_GUI__ = gui;
        }

        const existing = gui.folders?.find?.((f) =>
            f._title === "🏝️ Island Generator"
        );
        if (existing) existing.destroy();

        const folder = gui.addFolder("🏝️ Island Generator");

        const params = {
            // Shape
            shapePower: this.params.shapePower,

            // Noise basis
            octaves: this.params.heightMapParameters.octaves,
            scale: this.params.heightMapParameters.scale,
            influenceFalloff: this.params.heightMapParameters.influenceFalloff,
            scaleFalloff: this.params.heightMapParameters.scaleFalloff,
            amplitude: this.params.heightMapParameters.amplitude,
            heightPower: this.params.heightParameters?.heightPower ??
                this.params.heightMapParameters.heightPower,

            // Erosion - hydraulic
            dropsPerCell: this.params.erosionHydraulicParameters.dropsPerCell,
            erosionRate: this.params.erosionRate ??
                this.params.erosionHydraulicParameters.erosionRate,
            depositionRate: this.params.depositionRate ??
                this.params.erosionHydraulicParameters.depositionRate,
            speed: this.params.erosionHydraulicParameters.speed,
            friction: this.params.erosionHydraulicParameters.friction,
            radius: this.params.erosionHydraulicParameters.radius,
            maxIterations: this.params.erosionHydraulicParameters.maxIterations,
            iterationScale:
                this.params.erosionHydraulicParameters.iterationScale,

            // Erosion - coastal
            waveHeightMin: this.params.erosionCoastalParameters.waveHeightMin,
            waveHeightMax: this.params.erosionCoastalParameters.waveHeightMax,
            noiseScale: this.params.erosionCoastalParameters.noiseScale,
            coastalPower: this.params.erosionCoastalParameters.power,

            // Volcanoes
            volcanoThreshold: this.params.volcanoesParameters.volcanoThreshold,
            volcanoThresholdAmplitude:
                this.params.volcanoesParameters.volcanoThresholdAmplitude,
            volcanoThresholdScale:
                this.params.volcanoesParameters.volcanoThresholdScale,
            volcanoMaxDepth: this.params.volcanoesParameters.volcanoMaxDepth,
            volcanoCraterScale:
                this.params.volcanoesParameters.volcanoCraterScale,

            // Seabed shaping
            seabedWallWidth: this.size * 0.6,
            seabedDepth: this.size * 2,
            seabedExponent: 3,
            waterline: 3,
        };

        const rebuild = () => {
            this.dispose();
            const hmParams = new HeightMapParameters(
                params.octaves,
                params.scale,
                params.influenceFalloff,
                params.scaleFalloff,
                params.amplitude,
                params.heightPower,
            );

            const hydroParams = new ErosionHydraulicParameters(
                params.dropsPerCell,
                params.erosionRate,
                params.depositionRate,
                params.speed,
                params.friction,
                params.radius,
                params.maxIterations,
                params.iterationScale,
            );

            const coastalParams = new ErosionCoastalParameters(
                params.waveHeightMin,
                params.waveHeightMax,
                params.noiseScale,
                params.coastalPower,
            );

            const volcParams = new VolcanoesParameters(
                params.volcanoThreshold,
                params.volcanoThresholdAmplitude,
                params.volcanoThresholdScale,
                params.volcanoMaxDepth,
                params.volcanoCraterScale,
            );

            this.params = {
                shapePower: params.shapePower,
                heightMapParameters: hmParams,
                erosionHydraulicParameters: hydroParams,
                erosionCoastalParameters: coastalParams,
                volcanoesParameters: volcParams,
            };

            this._buildTerrain(this.params);
        };

        // GUI layout
        const fShape = folder.addFolder("Shape");
        fShape.add(params, "shapePower", 0.1, 8, 0.1).onChange(rebuild);

        const fNoise = folder.addFolder("Noise Basis");
        fNoise.add(params, "octaves", 1, 12, 1).onChange(rebuild);
        fNoise.add(params, "scale", 0.001, 2.0, 0.001).onChange(rebuild);
        fNoise.add(params, "influenceFalloff", 0.1, 2.0, 0.01).onChange(
            rebuild,
        );
        fNoise.add(params, "scaleFalloff", 0.5, 5.0, 0.01).onChange(rebuild);
        fNoise.add(params, "amplitude", 1, 300, 1).onChange(rebuild);
        fNoise.add(params, "heightPower", 0.1, 10, 0.1).onChange(rebuild);

        const fErosionH = folder.addFolder("Erosion — Hydraulic");
        fErosionH.add(params, "dropsPerCell", 0.1, 1.0, 0.01).onChange(rebuild);
        fErosionH.add(params, "erosionRate", 0.001, 0.5, 0.001).onChange(
            rebuild,
        );
        fErosionH.add(params, "depositionRate", 0.001, 0.5, 0.001).onChange(
            rebuild,
        );
        fErosionH.add(params, "speed", 0.01, 1.0, 0.01).onChange(rebuild);
        fErosionH.add(params, "friction", 0.0, 1.0, 0.01).onChange(rebuild);
        fErosionH.add(params, "radius", 0.1, 5.0, 0.1).onChange(rebuild);
        fErosionH.add(params, "maxIterations", 10, 300, 1).onChange(rebuild);
        fErosionH.add(params, "iterationScale", 0.001, 0.2, 0.001).onChange(
            rebuild,
        );

        const fErosionC = folder.addFolder("Erosion — Coastal");
        fErosionC.add(params, "waveHeightMin", 0.0, 5.0, 0.1).onChange(rebuild);
        fErosionC.add(params, "waveHeightMax", 0.0, 5.0, 0.1).onChange(rebuild);
        fErosionC.add(params, "noiseScale", 0.01, 2.0, 0.01).onChange(rebuild);
        fErosionC.add(params, "coastalPower", 0.1, 10, 0.1).onChange(rebuild);

        const fVolc = folder.addFolder("Volcanoes");
        fVolc.add(params, "volcanoThreshold", 0, 10, 0.1).onChange(rebuild);
        fVolc.add(params, "volcanoThresholdAmplitude", 0, 10, 0.1).onChange(
            rebuild,
        );
        fVolc.add(params, "volcanoThresholdScale", 0.01, 5, 0.01).onChange(
            rebuild,
        );
        fVolc.add(params, "volcanoMaxDepth", 0, 5, 0.05).onChange(rebuild);
        fVolc.add(params, "volcanoCraterScale", 0.1, 3, 0.05).onChange(rebuild);

        folder
            .add(
                {
                    randomizeSeed: () => {
                        this.seed = Math.floor(Math.random() * 0xffffffff);
                        rebuild();
                    },
                },
                "randomizeSeed",
            )
            .name("🎲 New Seed");

        folder.open();
    }
}
