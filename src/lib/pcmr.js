
export class PointCloudMeshRenderer {
    constructor(mesh, scene) {
        const vertexData = mesh.getVerticesData(
            BABYLON.VertexBuffer.PositionKind,
        );
        this.blocked = false;
        this.mesh = mesh;
        this.scene = scene;
        if (!vertexData) {
            this.not_a_mesh = true
            return
        }

        this.pcs = new BABYLON.PointsCloudSystem("pcs_" + mesh.uniqueId, 3, scene);
        // Add points based on the initial mesh vertex data
        this.pcs.addPoints(vertexData.length / 3, (particle, i) => {
            particle.position.x = vertexData[i * 3];
            particle.position.y = vertexData[i * 3 + 1];
            particle.position.z = vertexData[i * 3 + 2];
        });

        // Cache vertex count for optimization
        this.vertexCount = vertexData.length / 3;
    }
    async initialize() {
        return this?.not_a_mesh ? null : this.pcs.buildMeshAsync().then((mesh) => {
            mesh.alwaysSelectAsActiveMesh = true;
            this.pcs.mesh.parent = this.mesh.parent;
        });
    }

    render(positions_array_or_buffer) {
        let buffer, floats
        if (this.not_a_mesh) return

        if (positions_array_or_buffer instanceof BABYLON.StorageBuffer) {
            buffer = new BABYLON.VertexBuffer(this.scene.getEngine(), positions_array_or_buffer.getBuffer(), BABYLON.VertexBuffer.PositionKind)
        } else if (positions_array_or_buffer instanceof Float32Array) {
            floats = positions_array_or_buffer
        } else if (Array.isArray(positions_array_or_buffer)) {
            floats = new Float32Array(positions_array_or_buffer)
        } else {
            floats = this.mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        }

        const newVertexCount = buffer ? buffer.getBuffer().capacity / buffer.getSize(true) : floats.length / 3;

        if (newVertexCount > this.vertexCount) {
            this.vertexCount = newVertexCount;
            this.blocked = true;
            // Add new particles if the vertex count has increased
            const additionalPoints = newVertexCount - this.vertexCount;
            this.pcs.addPoints(additionalPoints);

            this.pcs.buildMeshAsync().then((e) => {e.alwaysSelectAsActiveMesh = true; this.blocked = false});
        }

        if (!this.blocked) {
            if (buffer) {
                this.pcs.mesh.setVerticesBuffer(buffer, false);
            } else if (floats) {
                this.pcs.mesh.setVerticesData("position", floats);
            }

        }
    }
}