import { Color3, Scene } from "@babylonjs/core";
import { Landmass } from "./Landmass.js";
import { Water } from "./Water.js";

/**
 * Biome — manages ambience, landmass, water, and entities.
 */
export class Biome {
  constructor(def, scene) {
    this.scene = scene;
    this.def = def;
    this.name = def.name;
    this.description = def.description;
    this.landmass = null;
    this.water = null;
    this.entities = [];
  }

  async populate() {
    const scene = this.scene;

    if (this.def.ambience) this._applyAmbience(this.def.ambience);

    // landmass
    this.landmass = new Landmass(scene, this.def.landmass || {});
    scene.activeLandmass = this.landmass;

    // water
    if (this.def.ambience?.water) {
      this.water = new Water(scene, this.def.ambience.water);
      scene.activeWater = this.water.mesh;
    }

    // entities
    if (Array.isArray(this.def.entities)) {
      for (const ent of this.def.entities) {
        const cls = ent.class;
        if (!cls) continue;
        const overrides =
          typeof ent.overrides === "function"
            ? ent.overrides(scene, this.landmass)
            : ent.overrides ?? {};
        const instance = new cls({
          scene,
          biome: this,
          overrides,
          landmass: this.landmass,
        });
        this.entities.push(instance);
      }
    }

    if (typeof this.def.onPopulate === "function") {
      await this.def.onPopulate(scene, this.landmass, this.water);
    }
  }

  _applyAmbience(amb) {
    const scene = this.scene;
    if (amb.fog) {
      scene.fogMode = amb.fog.mode ?? Scene.FOGMODE_EXP2;
      scene.fogDensity = amb.fog.density ?? 0.01;
      scene.fogColor = amb.fog.color ?? new Color3(0.5, 0.8, 0.9);
    }
    if (amb.skyColor) scene.clearColor = amb.skyColor;
  }

  dispose() {
    this.entities.forEach((e) => e.dispose?.());
    this.entities = [];
    this.landmass?.dispose();
    this.water?.dispose();
    this.landmass = null;
    this.water = null;
  }
}
