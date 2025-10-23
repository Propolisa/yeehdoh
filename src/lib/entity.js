
// ======================================================
// 🌍 BASE ENTITY

import { TransformNode } from "@babylonjs/core";

// ======================================================
export class Entity {
    constructor(scene, pos, params = {}) {
        this.scene = scene;
        this.position = pos.clone();
        this.group = new TransformNode('entity', scene);
        this.group.position.copyFrom(pos);
        this.params = params;
        this.baseCenter = pos.clone();
        this.bounds = null;
    }

    add(mesh, mat = null) {
        // Optionally assign material or leave it as is.
        if (mat) mesh.material = mat;
        mesh.parent = this.group;
        return mesh;
    }

    computeBounds() {
        const meshes = this.group.getChildMeshes();
        if (meshes.length === 0) return;
        let minY = Infinity,
            maxY = -Infinity;
        for (const m of meshes) {
            const bb = m.getBoundingInfo().boundingBox;
            minY = Math.min(minY, bb.minimumWorld.y);
            maxY = Math.max(maxY, bb.maximumWorld.y);
        }
        this.bounds = { minY, maxY, height: maxY - minY };
    }

    finalize() {
        // optional: entity initialization complete
    }
}

// ======================================================
// 🪨 STATIC ENTITY (non-animated, non-living)
// ======================================================
export class StaticEntity extends Entity {
    constructor(scene, pos, params = {}) {
        super(scene, pos, params);
    }

    add(mesh, mat = null) {
        // No wind sway; direct attach
        if (mat) mesh.material = mat;
        mesh.parent = this.group;
        return mesh;
    }

    finalize() {
        this.computeBounds();
    }
}
