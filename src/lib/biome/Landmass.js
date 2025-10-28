// biome/Landmass.js
import {
  Mesh,
  Scene,
  StandardMaterial,
  Color3,
  VertexData,
  Scalar
} from "@babylonjs/core";

/**
 * Landmass — procedural terrain generator and query helper.
 *
 * Responsible for:
 *  - Generating the base island mesh and vertex colors
 *  - Providing height/color/aridity lookups
 *  - Managing Babylon mesh lifecycle
 */
export class Landmass {
  /**
   * @param {Scene} scene - The Babylon.js scene
   * @param {object} [opts] - Optional generation parameters
   * @param {number} [opts.size=100] - Terrain width/extent
   * @param {number} [opts.subdivisions=128] - Grid resolution
   * @param {number} [opts.seed] - Optional seed for reproducibility
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.size = opts.size ?? 100;
    this.subdivisions = opts.subdivisions ?? 128;
    this.seed = opts.seed ?? Math.floor(Math.random() * 9999);

    this.N = this.subdivisions + 1;
    this.mesh = null;

    // Cached data arrays
    this.positions = new Float32Array(this.N * this.N * 3);
    this.colors = new Float32Array(this.N * this.N * 4);
    this.heights = new Float32Array(this.N * this.N);

    this._buildTerrain();
  }

  /** @returns {Mesh} the Babylon mesh representing this landmass */
  getMesh() {
    return this.mesh;
  }

  /** Clean up any GPU resources */
  dispose() {
    this.mesh?.dispose();
  }

  // ---------------------------------------------------------------------
  // 🏝️ Terrain generation core
  // ---------------------------------------------------------------------
  _buildTerrain() {
    const N = this.N;
    const SIZE = this.size;
    const maxD = (Math.sqrt(2) * N) / 2;

    // --- Randomized seed points for island shape ---
    const SEEDS = 8;
    const seedX = [], seedY = [];
    for (let i = 0; i < SEEDS; i++) {
      seedX.push(Math.random() * N);
      seedY.push(Math.random() * N);
    }

    // --- Jump Flood "distance" field for island shape ---
    const near = new Float32Array(N * N).fill(1e9);
    const idx = (x, y) => y * N + x;

    for (let i = 0; i < SEEDS; i++) near[idx(Math.floor(seedX[i]), Math.floor(seedY[i]))] = 0;
    let step = N / 2;
    while (step >= 1) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = idx(x, y);
          let best = near[i];
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = Math.floor(x + dx * step),
                ny = Math.floor(y + dy * step);
              if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
              const n = near[idx(nx, ny)] + Math.hypot(dx * step, dy * step);
              if (n < best) best = n;
            }
          }
          near[i] = best;
        }
      }
      step /= 2;
    }

    // --- Noise and shape ---
    function multiSine(x, z) {
      let n = 0, amp = 1, freq = 1, rot = 0.5;
      for (let o = 0; o < 5; o++) {
        const a = freq * 0.25;
        const px = x * a * Math.cos(rot) - z * a * Math.sin(rot);
        const pz = x * a * Math.sin(rot) + z * a * Math.cos(rot);
        n += (Math.sin(px + 3.1 * o) + Math.sin(pz + 1.7 * o)) * 0.5 * amp;
        freq *= 1.9;
        amp *= 0.55;
        rot += 1.1;
      }
      return n;
    }

    // --- Build vertex positions + color ---
    let p = 0, c = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const xn = x / N - 0.5;
        const zn = y / N - 0.5;
        const wx = xn * SIZE;
        const wz = zn * SIZE;
        const d = near[idx(x, y)] / maxD;

        let island = Math.max(0, 1 - d * 1.8);
        island = Math.pow(island, 2.5);
        let n = multiSine(x, y);
        let h = (island + n * 0.3 * (island + 0.2));
        h = Math.sign(h) * Math.pow(Math.abs(h), 1.3) * 4.2;

        // Circular falloff and depression
        const r = Math.sqrt(xn * xn + zn * zn);
        const fade = Math.exp(-5.0 * Math.pow(r / 0.45, 2.0));
        h -= (1.0 - fade) * 8.0;

        const waterLevel = 0.2;
        if (h < waterLevel) {
          const t2 = (waterLevel - h) / waterLevel;
          h -= t2 * 2.5;
        }

        this.positions[p++] = wx;
        this.positions[p++] = h;
        this.positions[p++] = wz;
        this.heights[idx(x, y)] = h;

        // Height-based color
        let rC = 0.6, gC = 0.85, bC = 0.6;
        if (h < 0.2) [rC, gC, bC] = [0.4, 0.6, 0.9];
        else if (h < 1.0) [rC, gC, bC] = [0.55, 0.8, 0.65];
        else if (h < 2.0) [rC, gC, bC] = [0.8, 0.7, 0.45];
        else [rC, gC, bC] = [0.7, 0.6, 0.6];

        this.colors[c++] = rC;
        this.colors[c++] = gC;
        this.colors[c++] = bC;
        this.colors[c++] = 1.0;
      }
    }

    // --- Indices ---
    const indices = [];
    for (let y = 0; y < this.subdivisions; y++) {
      for (let x = 0; x < this.subdivisions; x++) {
        const i = y * N + x;
        indices.push(i, i + 1, i + N, i + 1, i + N + 1, i + N);
      }
    }

    // --- Mesh creation ---
    const mesh = new Mesh("island", this.scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.indices = indices;
    vd.colors = this.colors;
    vd.normals = [];
    VertexData.ComputeNormals(this.positions, indices, vd.normals);
    vd.applyToMesh(mesh);

    const mat = new StandardMaterial("islandMat", this.scene);
    // mat.vertexColorUsed = true;

    mat.specularColor = Color3.Black();
    // mat.useFlatShading = true;
    mesh.material = mat;

    this.mesh = mesh;
  }

  // ---------------------------------------------------------------------
  // 🌈 Spatial lookups
  // ---------------------------------------------------------------------

  /**
   * Sample vertex color near given world XZ position.
   * @param {number} x
   * @param {number} z
   * @returns {Color3}
   */
  getColor(x, z) {
    const SIZE = this.size;
    const N = this.N;
    const xn = (x / SIZE + 0.5) * (N - 1);
    const zn = (z / SIZE + 0.5) * (N - 1);
    const xi = Math.floor(xn);
    const zi = Math.floor(zn);
    if (xi < 0 || zi < 0 || xi >= N - 1 || zi >= N - 1) return new Color3(0.5, 0.5, 0.5);
    const tx = xn - xi;
    const tz = zn - zi;
    const lerp = (a, b, t) => a + (b - a) * t;
    const cAt = (x, z) => {
      const i = (z * N + x) * 4;
      return new Color3(this.colors[i], this.colors[i + 1], this.colors[i + 2]);
    };
    const c00 = cAt(xi, zi), c10 = cAt(xi + 1, zi);
    const c01 = cAt(xi, zi + 1), c11 = cAt(xi + 1, zi + 1);
    const r = lerp(lerp(c00.r, c10.r, tx), lerp(c01.r, c11.r, tx), tz);
    const g = lerp(lerp(c00.g, c10.g, tx), lerp(c01.g, c11.g, tx), tz);
    const b = lerp(lerp(c00.b, c10.b, tx), lerp(c01.b, c11.b, tx), tz);
    return new Color3(r, g, b);
  }

  /**
   * Compute aridity from color (dryness factor).
   * @param {number} x
   * @param {number} z
   * @returns {number} 0=dry, 1=wet
   */
  getAridity(x, z) {
    const c = this.getColor(x, z);
    const wet = c.g + c.b * 0.5;
    const dry = c.r;
    return Scalar.Clamp(1.0 - (dry - wet + 0.5), 0, 1);
  }

  /**
   * Approximate height lookup (nearest-neighbor).
   * @param {number} x
   * @param {number} z
   * @returns {number} height (y)
   */
  getHeight(x, z) {
    const SIZE = this.size;
    const N = this.N;
    const xn = Math.floor((x / SIZE + 0.5) * (N - 1));
    const zn = Math.floor((z / SIZE + 0.5) * (N - 1));
    const i = zn * N + xn;
    return this.heights[i] ?? 0;
  }
}
