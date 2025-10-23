// src/lib/SurfaceReprojector.js
import {
  Color3,
  Matrix,
  MeshBuilder,
  StandardMaterial,
  Vector3,
  VertexBuffer
} from "@babylonjs/core";

/**
 * Feature point bound to skeleton bones in rest pose,
 * reprojectable to any compatible Mixamo rig.
 */
class SkinnedFeaturePoint {
  constructor(indices, weights, localPositions, localNormals, radius = 0.05) {
    this.indices = indices;
    this.weights = weights;
    this.localPositions = localPositions;
    this.localNormals = localNormals;
    this.radius = radius;
    this.debugSphere = null;
  }

  /**
   * Compute world position/normal given the current skeleton and armature transform.
   */
  getWorldPosAndNormal(skeleton, armatureWorld) {
    let worldPos = Vector3.Zero();
    let worldNormal = Vector3.Zero();

    this.indices.forEach((bi, i) => {
      const w = this.weights[i];
      if (w <= 0) return;

      const bone = skeleton.bones[bi];
      const boneMat = bone.getAbsoluteTransform();
      const worldMat = armatureWorld.multiply(boneMat);

      worldPos.addInPlace(
        Vector3.TransformCoordinates(this.localPositions[i], worldMat).scale(w)
      );

      const nm = worldMat.clone();
      nm.setTranslation(Vector3.Zero());
      worldNormal.addInPlace(
        Vector3.TransformNormal(this.localNormals[i], nm).scale(w)
      );
    });

    if (worldNormal.lengthSquared() > 1e-6) {
      worldNormal.normalize();
    }

    return { worldPos, worldNormal };
  }
}

export class SurfaceReprojector {
  constructor(skinnedMesh, scene) {
    this.mesh = skinnedMesh;
    this.scene = scene;
    this.skeleton = skinnedMesh.skeleton;
    this.influences = skinnedMesh.numBoneInfluencers || 4;
    this.features = [];

    if (!this.skeleton) {
      throw new Error("SurfaceReprojector: mesh has no skeleton");
    }
  }

  /**
   * Capture a feature point at the pick location and bind it in skeleton-relative space.
   */
  addFeature(pickInfo) {
    if (!pickInfo.hit || pickInfo.pickedMesh !== this.mesh) return;

    this.skeleton.computeAbsoluteTransforms();

    const { faceId, pickedPoint } = pickInfo;
    const normalWorld = pickInfo.getNormal(true) || Vector3.Up();

    const indices = this.mesh.getIndices();
    const posBuf = this.mesh.getVerticesData(VertexBuffer.PositionKind);
    const wBuf = this.mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
    const jBuf = this.mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);

    const vi = [
      indices[faceId * 3 + 0],
      indices[faceId * 3 + 1],
      indices[faceId * 3 + 2],
    ];

    // barycentric (on bind positions)
    const a = Vector3.FromArray(posBuf, vi[0] * 3);
    const b = Vector3.FromArray(posBuf, vi[1] * 3);
    const c = Vector3.FromArray(posBuf, vi[2] * 3);
    const bary = (() => {
      const v0 = b.subtract(a);
      const v1 = c.subtract(a);
      const v2 = pickedPoint.subtract(a);
      const d00 = Vector3.Dot(v0, v0);
      const d01 = Vector3.Dot(v0, v1);
      const d11 = Vector3.Dot(v1, v1);
      const d20 = Vector3.Dot(v2, v0);
      const d21 = Vector3.Dot(v2, v1);
      const denom = d00 * d11 - d01 * d01;
      if (Math.abs(denom) < 1e-6) return new Vector3(1 / 3, 1 / 3, 1 / 3);
      const v = (d11 * d20 - d01 * d21) / denom;
      const w = (d00 * d21 - d01 * d20) / denom;
      const u = 1 - v - w;
      return new Vector3(u, v, w);
    })();

    const boneMap = {};
    const armatureWorld = this.mesh.parent?.getWorldMatrix() ?? Matrix.Identity();

    vi.forEach((vIdx, corner) => {
      const cw = corner === 0 ? bary.x : corner === 1 ? bary.y : bary.z;
      if (cw <= 0) return;
      for (let j = 0; j < this.influences; j++) {
        const bi = jBuf[vIdx * this.influences + j];
        const w = wBuf[vIdx * this.influences + j] * cw;
        if (w <= 0) continue;

        if (!boneMap[bi]) {
          boneMap[bi] = { weight: 0, localPos: Vector3.Zero(), localNormal: Vector3.Zero() };
        }
        boneMap[bi].weight += w;

        // rest pose matrix, with armature
        const bindMat = this.skeleton.bones[bi].getRestPose();
        const bindWorld = armatureWorld.multiply(bindMat);
        const invBind = bindWorld.clone().invert();

        const localPos = Vector3.TransformCoordinates(pickedPoint, invBind);
        const localNormal = Vector3.TransformNormal(normalWorld, invBind);

        boneMap[bi].localPos.addInPlace(localPos.scale(w));
        boneMap[bi].localNormal.addInPlace(localNormal.scale(w));
      }
    });

    const boneIndices = [];
    const boneWeights = [];
    const localPositions = [];
    const localNormals = [];

    for (let [bi, { weight, localPos, localNormal }] of Object.entries(boneMap)) {
      boneIndices.push(parseInt(bi, 10));
      boneWeights.push(weight);
      localPositions.push(localPos.scale(1 / weight));
      localNormals.push(localNormal.scale(1 / weight).normalize());
    }

    // normalize weights
    const totalW = boneWeights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < boneWeights.length; i++) boneWeights[i] /= totalW;

    const feature = new SkinnedFeaturePoint(
      boneIndices,
      boneWeights,
      localPositions,
      localNormals
    );

    // debug sphere parented to armature
    const sphere = MeshBuilder.CreateSphere(
      "featureSphere",
      { diameter: feature.radius * 2 },
      this.scene
    );
    const sphereMat = new StandardMaterial("debugMat", this.scene);
    sphereMat.diffuseColor = Color3.Random();
    sphere.material = sphereMat;
    sphere.parent = this.mesh.parent;

    const { worldPos } = feature.getWorldPosAndNormal(this.skeleton, armatureWorld);
    sphere.position.copyFrom(worldPos);
    feature.debugSphere = sphere;

    this.features.push(feature);

    console.log("[SurfaceReprojector] Added feature:");
    console.log("  Bones:", boneIndices);
    console.log("  Weights:", boneWeights);
    console.log("  Local positions:", localPositions.map((v) => v.toString()));
    console.log("  Local normals:", localNormals.map((v) => v.toString()));
  }

  /**
   * Update shader + debug spheres each frame.
   */
  updateMaterial() {
    if (!this.features.length) return;

    this.skeleton.computeAbsoluteTransforms();
    const armatureWorld = this.mesh.parent?.getWorldMatrix() ?? Matrix.Identity();

    for (const feature of this.features) {
      const { worldPos } = feature.getWorldPosAndNormal(this.skeleton, armatureWorld);
      if (feature.debugSphere) {
        feature.debugSphere.position.copyFrom(worldPos);
        feature.debugSphere.scaling.setAll(feature.radius * 2);
      }
    }

    // TODO: also update your custom shader with feature positions/radii if needed
  }
}
