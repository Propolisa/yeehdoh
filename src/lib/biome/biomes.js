// biome/biomes.js
/**
 * Yeeh Doh — Biome Definitions
 *
 * Each biome entry defines:
 * - name, description
 * - ambience: fog, water
 * - landmass: terrain generator seed and class
 * - entities: spawnable classes + optional constructor overrides
 *
 * A Biome class will read this data, set ambience (sky, fog, sea),
 * and call entity constructors with biome context.
 *
 * NOTE: All references (classes, functions) must be imported by the Biome class,
 * not here — this file is just configuration.
 */

export const biomes = {
  // ==========================================================
  // 🌋 Volcanic Highlands (your current default biome)
  // ==========================================================
  volcanic: {
    name: "Volcanic Highlands",
    description: "Green slopes over basalt, ringed by deep turquoise waters.",
    ambience: {
      fog: {
        color: [0.07, 0.35, 0.4],
        density: 1.5,
        radius: 400,
      },
      water: {
        deepColor: [0.0, 0.3, 0.5, 0.9],
        shallowColor: [0.1, 0.7, 0.9, 0.9],
        foamColor: [1.0, 1.0, 1.0, 1.0],
        maxDepth: 6.0,
        noiseScale: 0.25,
        noiseOffset: 0.02,
        foamNoiseScale: 1.5,
      },
    },
    landmass: {
      seed: 8271,
      class: "IslandVolcanic",
    },
    entities: [
      { class: "Tree", overrides: { scale: 4.5 } },
      { class: "Palm", overrides: { leafTint: [0.4, 0.8, 0.5] } },
      { class: "Bush", overrides: { density: 0.8 } },
      { class: "Flower", overrides: { density: 0.8 } },
      { class: "FlowerCluster", overrides: { density: 0.8 } },
      // {
      //   class: "Fish",
      //   overrides(ctx) {
      //     return {
      //       colorBias: [0.1 + ctx.altitude * 0.3, 0.6, 0.8],
      //       speed: 0.5 + Math.random() * 0.3,
      //     };
      //   },
      // },
    ],
  },

  // ==========================================================
  // 🪸 Coral Atoll
  // ==========================================================
  coral: {
    name: "Coral Atoll",
    description: "A bright reef ring enclosing a shallow blue-green lagoon.",
    ambience: {
      fog: {
        color: [0.45, 0.75, 0.85],
        density: 0.9,
        radius: 500,
      },
      water: {
        deepColor: [0.0, 0.55, 0.75, 0.8],
        shallowColor: [0.45, 0.9, 0.95, 0.9],
        foamColor: [1.0, 1.0, 1.0, 0.9],
        maxDepth: 4.0,
        noiseScale: 0.35,
        noiseOffset: 0.03,
        foamNoiseScale: 2.0,
      },
    },
    landmass: {
      seed: 9904,
      class: "IslandAtoll",
    },
    entities: [
      { class: "Palm", overrides: { height: 6.0, lean: 0.15 } },
      { class: "FlowerCluster", overrides: { colorShift: [0.9, 0.4, 0.5] } },
      { class: "Coral", overrides: { radius: 0.8 } },
      {
        class: "Fish",
        overrides() {
          return { colorBias: [Math.random(), 0.8, 1.0], speed: 1.0 };
        },
      },
    ],
  },

  // ==========================================================
  // 🌴 Tropical Jungle
  // ==========================================================
  tropical: {
    name: "Tropical Jungle",
    description: "Dense palms and ferns under a humid emerald canopy.",
    ambience: {
      fog: {
        color: [0.12, 0.35, 0.25],
        density: 1.2,
        radius: 350,
      },
      water: {
        deepColor: [0.05, 0.25, 0.3, 0.85],
        shallowColor: [0.1, 0.45, 0.5, 0.9],
        foamColor: [0.9, 0.95, 0.9, 0.9],
        maxDepth: 5.0,
        noiseScale: 0.2,
        noiseOffset: 0.015,
        foamNoiseScale: 1.2,
      },
    },
    landmass: {
      seed: 3345,
      class: "IslandJungle",
    },
    entities: [
      { class: "Tree", overrides: { height: 8.0, leafTint: [0.3, 0.7, 0.3] } },
      { class: "Palm", overrides: { droop: 0.9 } },
      { class: "Bush", overrides: { density: 1.2 } },
      { class: "FlowerCluster", overrides: { colorShift: [1.0, 0.5, 0.5] } },
      {
        class: "Butterfly",
        overrides(ctx) {
          return { color: [0.8, 0.6, 0.4], altitude: ctx.altitude + 2.0 };
        },
      },
    ],
  },

  // ==========================================================
  // 🪨 Bare Island
  // ==========================================================
  barren: {
    name: "Bare Island",
    description: "Wind-beaten rock, salt crusts, and almost no shade.",
    ambience: {
      fog: {
        color: [0.6, 0.7, 0.8],
        density: 0.6,
        radius: 500,
      },
      water: {
        deepColor: [0.15, 0.35, 0.55, 0.9],
        shallowColor: [0.25, 0.55, 0.65, 0.9],
        foamColor: [0.9, 0.9, 0.9, 0.8],
        maxDepth: 8.0,
        noiseScale: 0.2,
        noiseOffset: 0.02,
        foamNoiseScale: 1.3,
      },
    },
    landmass: {
      seed: 112,
      class: "IslandBare",
    },
    entities: [
      { class: "Rock", overrides: { scale: 1.5 } },
      { class: "Cactus", overrides: { height: 1.8 } },
      {
        class: "Bird",
        overrides(ctx) {
          return { altitude: ctx.altitude + 20, circling: true };
        },
      },
    ],
  },

  // ==========================================================
  // ❄️ Misty North
  // ==========================================================
  cold: {
    name: "Misty North",
    description: "Grey surf and cold air clinging to ash cliffs.",
    ambience: {
      fog: {
        color: [0.35, 0.45, 0.5],
        density: 2.0,
        radius: 300,
      },
      water: {
        deepColor: [0.0, 0.2, 0.35, 0.9],
        shallowColor: [0.1, 0.4, 0.5, 0.9],
        foamColor: [0.9, 0.95, 1.0, 0.9],
        maxDepth: 6.0,
        noiseScale: 0.15,
        noiseOffset: 0.01,
        foamNoiseScale: 1.0,
      },
    },
    landmass: {
      seed: 5502,
      class: "IslandCold",
    },
    entities: [
      { class: "Pine", overrides: { height: 6.5 } },
      { class: "Rock", overrides: { tint: [0.5, 0.55, 0.6] } },
      {
        class: "Fish",
        overrides() {
          return { colorBias: [0.2, 0.5, 0.7], speed: 0.4 };
        },
      },
      {
        class: "Seal",
        overrides(ctx) {
          return { position: { x: ctx.x, y: ctx.altitude, z: ctx.z } };
        },
      },
    ],
  },
};
