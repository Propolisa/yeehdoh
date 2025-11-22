import { Sky } from '@/lib/biome/Sky.js';
import { Bush, Flower, FlowerCluster, Palm, Tree } from '@/lib/plants/classes.js';
import { Color3, Scene } from '@babylonjs/core';
import { Landmass } from './Landmass.js';
import { Water } from './Water.js';

const classes = { Tree, Bush, Palm, Flower, FlowerCluster };
/**
 * Represents a biome — a self-contained environmental system that manages
 * ambience, terrain (landmass), water, and entities within a Babylon.js scene.
 *
 * @example
 * ```js
 * const biome = new Biome(biomeDefinition, scene);
 * await biome.populate();
 * ```
 */
export class Biome {
    /**
     * The Babylon.js scene the biome belongs to.
     * @type {Scene}
     */
    scene;

    /**
     * The biome definition containing ambience, landmass, water, and entity configurations.
     * @type {Object}
     */
    def;

    /**
     * The biome name.
     * @type {string}
     */
    name;

    /**
     * A human-readable description of the biome.
     * @type {string}
     */
    description;

    /**
     * The landmass instance associated with this biome.
     * @type {Landmass | null}
     */
    landmass = null;

    /**
     * The water instance associated with this biome.
     * @type {Water | null}
     */
    water = null;

    /**
     * The entities that belong to this biome.
     * @type {Array<Object>}
     */
    entities = [];

    /**
     * The sky controller for this biome.
     * @type {Sky | undefined}
     */
    sky;

    /**
     * Creates a new Biome instance.
     *
     * @param {Object} def - The biome definition object.
     * @param {Scene} scene - The Babylon.js scene to attach the biome to.
     */
    constructor(def, scene) {
        this.scene = scene;
        this.def = def;
        this.name = def.name;
        this.description = def.description;
    }

    /**
     * Populates the biome by creating ambience, terrain, water, sky, and entities.
     * This should be called once during initialization.
     *
     * @async
     * @returns {Promise<void>}
     */
    async populate() {
        const scene = this.scene;

        if (this.def.ambience) this._applyAmbience(this.def.ambience);

        // Create landmass
        this.landmass = new Landmass(scene, this.def.landmass || {});
        scene.activeLandmass = this.landmass;

        // Create water (if defined in ambience)
        if (this.def.ambience?.water) {
            this.water = new Water(scene, this.def.ambience.water);
            scene.activeWater = this.water.mesh;
        }

        // Create sky
        this.sky = new Sky(scene, this.def.ambience?.sky || {});

        // Spawn entities
        if (Array.isArray(this.def.entities)) {
            for (const ent of this.def.entities) {
                const cls = classes[ent.class];
                if (!cls) continue;

                const overrides = typeof ent.overrides === 'function' ? ent.overrides(scene, this.landmass) : (ent.overrides ?? {});

                const instance = new cls(scene, this.landmass.getRandomSurfacePoint(), {
                    scene,
                    biome: this,
                    overrides,
                    landmass: this.landmass
                });

                this.entities.push(instance);
            }
        }

        // Optional post-populate callback
        if (typeof this.def.onPopulate === 'function') {
            await this.def.onPopulate(scene, this.landmass, this.water);
        }
    }

    /**
     * Applies ambience settings such as fog and sky color to the scene.
     *
     * @private
     * @param {Object} amb - The ambience definition.
     * @param {Object} [amb.fog] - Fog configuration.
     * @param {number} [amb.fog.mode] - Fog mode (e.g., Scene.FOGMODE_EXP2).
     * @param {number} [amb.fog.density] - Fog density.
     * @param {Array[number]} [amb.fog.color] - Fog color.
     * @param {Array[number]} [amb.skyColor] - Sky clear color.
     */
    _applyAmbience(amb) {
        const scene = this.scene;
        if (amb.fog) {
            scene.fogMode = amb.fog.mode ?? Scene.FOGMODE_EXP2;
            scene.fogDensity = amb.fog.density / 1000 || 0.00001;
            scene.fogColor = amb.fog.color ? new Color3(...amb.fog.color) : new Color3(0.5, 0.8, 0.9);
        }
        if (amb.skyColor) scene.clearColor = amb.skyColor;
    }

    /**
     * Disposes of all biome-related resources (entities, terrain, water, etc.).
     * This should be called before unloading or switching biomes to prevent memory leaks.
     *
     * @returns {void}
     */
    dispose() {
        this.entities.forEach((e) => e.dispose?.());
        this.entities = [];
        this.landmass?.dispose();
        this.water?.dispose();
        this.landmass = null;
        this.water = null;
    }
}
