// biome/Landmass.js
import { WINDOW_CONTEXT } from '@/lib/helpers'; // same as Water
import { Color3, Engine, Mesh, RawTexture, Scene, StandardMaterial, Texture, VertexData } from '@babylonjs/core';
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
        this._conformUnderwaterToCircularBasin({
            waterline: 0,
            wallWidth: this.size * 0.6,
            maxDepth: this.size * 2,
            wallExponent: 3
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
     * Conform underwater geometry to a circular seabed with a volcano-like wall.
     * See your existing implementation.
     */
    /**
     * NEW seabed extruder with full diagnostics.
     * Rebuilds the mesh, extracts coastline, removes underwater tris,
     * generates skirt, merges, computes normals, updates mesh.
     */
    /**
     * Seabed generator using convex hull of near-water vertices.
     * - Fast, robust, no adjacency graph
     * - Works for smooth or flat shaded meshes
     * - Builds a low-poly skirt from hull, extruded outward & downward
     */
    /**
     * DEBUG: visualize where Marching Squares finds coastline crossings.
     * Produces small spheres at every detected edge intersection.
     * Does NOT modify the island mesh.
     */
   /**
 * Fully optimized, parameter-free seabed generator.
 * Uses marching-squares on the heightmap raster only.
 * Automatically:
 *  - extracts coastline loops at waterline = 0
 *  - extrudes a radial+downward seabed skirt
 *  - rebuilds the island mesh with merged geometry
 *
 * No GUI parameters. No inputs. Just works.
 */
_conformUnderwaterToCircularBasin() {
    const mesh = this.mesh;
    const hm = this.heightMap;
    if (!mesh || !hm) return;

    console.log("=== SEABED VIA OPTIMIZED MARCHING SQUARES ===");

    const W = hm.xValues;
    const H = hm.yValues;
    const vals = hm.values;
    const waterline = 0;

    const cell = this.size / (W - 1);
    const half = this.size * 0.5;

    // -----------------------------------------
    // 1) Build signed scalar field = (height - waterline)
    // -----------------------------------------
    const field = new Float32Array(W * H);
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < vals.length; i++) {
        const h = vals[i];
        field[i] = h - waterline;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
    }

    // -----------------------------------------
    // 2) Marching Squares — optimized
    // Produces raw "segments": [x1,y1, x2,y2]
    // -----------------------------------------
    const segments = [];

    const lerp = (a, b, fa, fb) => {
        const t = fa / (fa - fb);
        return a + t * (b - a);
    };

    let idx = (i,j) => field[i + j*W];

    for (let j = 0; j < H - 1; j++) {
        const y0 = j * cell - half;
        const y1 = (j+1) * cell - half;

        for (let i = 0; i < W - 1; i++) {
            const v00 = idx(i, j);
            const v10 = idx(i+1, j);
            const v11 = idx(i+1, j+1);
            const v01 = idx(i, j+1);

            const mask =
                (v00>0 ?1:0) |
                (v10>0 ?2:0) |
                (v11>0 ?4:0) |
                (v01>0 ?8:0);

            if (mask === 0 || mask === 15) continue;

            const x0 = i * cell - half;
            const x1 = (i+1) * cell - half;

            // gather up to two crossings
            // store in a tiny fixed array
            let px1 = 0, py1 = 0, px2 = 0, py2 = 0;
            let found = 0;

            // left edge (v00→v01)
            if ((v00>0)!==(v01>0)) {
                const yy = lerp(y0, y1, v00, v01);
                if (!found) { px1 = x0; py1 = yy; found=1; }
                else { px2 = x0; py2 = yy; found=2; }
            }

            // right edge (v10→v11)
            if ((v10>0)!==(v11>0)) {
                const yy = lerp(y0, y1, v10, v11);
                if (!found) { px1 = x1; py1 = yy; found=1; }
                else { px2 = x1; py2 = yy; found=2; }
            }

            // bottom edge (v00→v10)
            if ((v00>0)!==(v10>0)) {
                const xx = lerp(x0, x1, v00, v10);
                if (!found) { px1 = xx; py1 = y0; found=1; }
                else { px2 = xx; py2 = y0; found=2; }
            }

            // top edge (v01→v11)
            if ((v01>0)!==(v11>0)) {
                const xx = lerp(x0, x1, v01, v11);
                if (!found) { px1 = xx; py1 = y1; found=1; }
                else { px2 = xx; py2 = y1; found=2; }
            }

            if (found === 2) {
                segments.push([px1, py1, px2, py2]);
            }
        }
    }

    console.log(">>> marching segments:", segments.length);

    // -----------------------------------------
    // 3) Connect segments → loops (optimized)
    // Using spatial hashing for speed.
    // -----------------------------------------
    const EPS = 1e-3;
    const inv = 1 / EPS;

    const hash = (x,y)=> ((Math.round(x*inv)<<16) ^ Math.round(y*inv));

    // map hash→points
    const hmap = new Map();
    for (const s of segments) {
        const [x1,y1, x2,y2] = s;
        const h1 = hash(x1,y1);
        const h2 = hash(x2,y2);
        if (!hmap.has(h1)) hmap.set(h1, []);
        if (!hmap.has(h2)) hmap.set(h2, []);
        hmap.get(h1).push([x2,y2]);
        hmap.get(h2).push([x1,y1]);
    }

    const visited = new Set();
    const loops = [];

    for (const [hStart, nbrs] of hmap.entries()) {
        if (visited.has(hStart)) continue;
        if (!nbrs.length) continue;

        const loop = [];
        let h = hStart;
        let prevX = null, prevY = null;

        while (!visited.has(h)) {
            visited.add(h);

            // decode approximate point
            const kx = ( (h>>16) / inv );
            const ky = ( (h&0xffff) / inv );

            loop.push([kx, ky]);

            const list = hmap.get(h);
            let next = list[0];
            if (prevX !== null && list.length>1) {
                // choose neighbor not equal to previous
                const d0 = (next[0]-prevX)**2 + (next[1]-prevY)**2;
                const d1 = (list[1][0]-prevX)**2 + (list[1][1]-prevY)**2;
                if (d1 < d0) next = list[1];
            }

            prevX = kx; prevY = ky;
            h = hash(next[0], next[1]);
        }

        if (loop.length>2) loops.push(loop);
    }

    console.log(">>> loops:", loops.length);

    if (!loops.length) {
        console.warn("No coastline loops detected.");
        return;
    }

    // -----------------------------------------
    // 4) Build the seabed skirt for each loop
    // Fixed settings:
    //   rings = 8
    //   outward scale = 0.6 * size
    //   downward depth = 2 * size
    //   exponent = 3 for wall curve
    // -----------------------------------------
    const rings = 8;
    const outward = this.size * 0.6;
    const depth = this.size * 2;
    const exp = 3;

    // Acquire original mesh data
    const pos0 = mesh.getVerticesData("position");
    const col0 = mesh.getVerticesData("color");
    const ind0 = mesh.getIndices();
    const n0   = pos0.length / 3;

    const outPos = pos0.slice();
    const outCol = col0.slice();
    const outInd = ind0.slice();

    // helper to push vertices
    const addV = (x,y,z, r,g,b,a)=>{
        outPos.push(x,y,z);
        outCol.push(r,g,b,a);
        return (outPos.length/3)-1;
    };

    // wedge & depth function
    for (const loop of loops) {
        const cx = loop.reduce((s,p)=>s+p[0],0)/loop.length;
        const cy = loop.reduce((s,p)=>s+p[1],0)/loop.length;

        // build rings
        const ringIdx = []; // ringIdx[r][i] = vertex index

        for (let r=0; r<=rings; r++) {
            const t = r / rings;
            const rad = t**exp * outward;
            const dy  = -t**exp * depth;

            const arr = [];
            for (let i=0; i<loop.length; i++) {
                const [x0,y0] = loop[i];
                const dx = x0 - cx;
                const dz = y0 - cy;
                const norm = Math.hypot(dx,dz) || 1;
                const ux = dx/norm;
                const uz = dz/norm;

                const x = x0 + ux * rad;
                const z = y0 + uz * rad;
                const y = waterline + dy;

                const idx = addV(x,y,z, 0.2,0.2,0.25,1);
                arr.push(idx);
            }
            ringIdx[r] = arr;
        }

        // triangulate rings
        for (let r=0; r<rings; r++) {
            const A = ringIdx[r];
            const B = ringIdx[r+1];
            const L = A.length;

            for (let i=0; i<L; i++) {
                const i0 = A[i];
                const i1 = A[(i+1)%L];
                const i2 = B[i];
                const i3 = B[(i+1)%L];

                outInd.push(i0,i2,i1);
                outInd.push(i1,i2,i3);
            }
        }
    }

    // -----------------------------------------
    // 5) Compute normals and update mesh
    // -----------------------------------------
    const outNor = [];
    VertexData.ComputeNormals(outPos, outInd, outNor);

    mesh.updateVerticesData("position", outPos, true);
    mesh.updateVerticesData("normal"  , outNor, true);
    mesh.updateVerticesData("color"   , outCol, true);
    mesh.updateIndices(outInd);

    console.log("=== SEABED COMPLETE ===");
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

        console.log('Created HeightmapDebugTexture', tex, 'min =', minH, 'max =', maxH);

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
