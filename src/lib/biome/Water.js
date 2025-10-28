// biomes/Water.js
import { Constants, Effect, Mesh, RenderTargetTexture, ShaderMaterial, Vector4, VertexBuffer, VertexData } from '@babylonjs/core';

/**
 * Stylized water surface using the original scene shader and refraction path.
 * - Depth map + refraction RTT share the SAME renderList (the 'island' mesh)
 * - RTT uses the active camera (exactly like the original)
 * - Exact shader strings + material wiring preserved
 */
export class Water {
    /**
     * @param {import('@babylonjs/core').Scene} scene
     * @param {{radius?:number, level?:number}} [opts]
     */
    constructor(scene, opts = {}) {
        this.scene = scene;
        this.radius = opts.radius ?? 1024; // original created a big circular mesh
        this.level = opts.level ?? 0;

        // === Mesh (same geometry approach as original) ===
        this.mesh = this._makeCircularMesh(scene, 'water', this.radius, 256, 256);
        this.mesh.position.y = this.level;

        // === Register EXACT original shaders (names: 'custom') ===
        this._registerOriginalShaders();

        // === Depth Renderer from active camera (same as original) ===
        const depthRenderer = scene.enableDepthRenderer(scene.activeCamera, false);
        this.depthTex = depthRenderer.getDepthMap();

        // === Refraction RTT (same params/order as original) ===
        this.refractionRTT = new RenderTargetTexture(
            'water_refraction',
            { width: 256, height: 256 }, // original used 256x256
            scene,
            false,
            true
        );
        this.refractionRTT.wrapU = Constants.TEXTURE_MIRROR_ADDRESSMODE;
        this.refractionRTT.wrapV = Constants.TEXTURE_MIRROR_ADDRESSMODE;
        this.refractionRTT.ignoreCameraViewport = true;
        this.refractionRTT.refreshRate = 1;
        this.refractionRTT.renderList = []; // will be set when 'island' appears
        // drive RTT from the active camera (matches on-screen view)
        this.refractionRTT.activeCamera = scene.activeCamera;

        scene.customRenderTargets.push(this.refractionRTT);

        // === Shader material (exact creation signature) ===
        const shaderMaterial = new ShaderMaterial(
            'shader',
            scene,
            { vertex: 'custom', fragment: 'custom' },
            {
                attributes: ['position', 'normal', 'uv'],
                uniforms: ['world', 'worldView', 'worldViewProjection', 'view', 'projection']
            }
        );
        shaderMaterial.backFaceCulling = false;

        // Wire uniforms exactly like original code did:
        shaderMaterial.setTexture('depthTex', this.depthTex);
        shaderMaterial.setTexture('refractionSampler', this.refractionRTT);
        shaderMaterial.setFloat('camMinZ', scene.activeCamera.minZ);
        shaderMaterial.setFloat('camMaxZ', scene.activeCamera.maxZ);
        shaderMaterial.setFloat('time', 0);
        shaderMaterial.setFloat('wNoiseScale', 0.25);
        shaderMaterial.setFloat('wNoiseOffset', 0.02);
        shaderMaterial.setFloat('fNoiseScale', 1.5);
        shaderMaterial.setFloat('maxDepth', 5.0);
        shaderMaterial.setVector4('wDeepColor', new Vector4(0.0, 0.3, 0.5, 1.0));
        shaderMaterial.setVector4('wShallowColor', new Vector4(0.0, 0.7, 0.9, 1.0));
        shaderMaterial.setVector4('wFoamColor', new Vector4(1, 1, 1, 1));
        shaderMaterial.alpha = 0.9;

        this.material = shaderMaterial;
        this.mesh.material = shaderMaterial;

        // === Drive time & keep camera in sync (safe) ===
        this._renderObserver = scene.onBeforeRenderObservable.add(() => {
            shaderMaterial.setFloat('time', performance.now() * 0.001);
            // keep RTT using current camera (ArcRotate is stable but this is harmless)
            this.refractionRTT.activeCamera = scene.activeCamera;
        });

        // === Order-independent registration of the island mesh ===
        const linkIsland = (m) => {
            if (m && m.name === 'island') {
                // EXACT original behavior: both render lists are the SAME array
                // (This guarantees the depth map and refraction sample the same objects)
                const list = [m];
                this.refractionRTT.renderList = list;
                this.depthTex.renderList = list;
            }
        };
        this._newMeshObserver = scene.onNewMeshAddedObservable.add(linkIsland);
        // catch any already-created island
        scene.meshes.forEach(linkIsland);
    }

    /** Circular water surface (double-sided), same topology approach */
    _makeCircularMesh(scene, name, radius = 128, radialSegments = 80, ringSegments = 80) {
        const positions = [];
        const indices = [];
        const uvs = [];

        // Concentric rings; denser near center (as in your scene)
        for (let i = 0; i <= ringSegments; i++) {
            const t = i / ringSegments;
            const r = radius * Math.pow(t, 2.2);
            for (let j = 0; j <= radialSegments; j++) {
                const theta = (j / radialSegments) * Math.PI * 2;
                const x = r * Math.cos(theta);
                const z = r * Math.sin(theta);
                positions.push(x, 0, z);
                uvs.push(j / radialSegments, i / ringSegments);
            }
        }
        const stride = radialSegments + 1;
        for (let i = 0; i < ringSegments; i++) {
            for (let j = 0; j < radialSegments; j++) {
                const a = i * stride + j;
                const b = a + 1;
                const c = a + stride;
                const d = c + 1;
                indices.push(a, b, c, b, d, c);
            }
        }
        // reverse (as original did) – optional, harmless here
        indices.reverse();

        const mesh = new Mesh(name, scene);
        const vd = new VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.uvs = uvs;
        const normals = [];
        VertexData.ComputeNormals(positions, indices, normals);
        vd.normals = normals;
        vd.applyToMesh(mesh);

        // Rebuild as double-sided
        VertexData._ComputeSides(
            Mesh.DOUBLESIDE,
            mesh.getVerticesData(VertexBuffer.PositionKind),
            mesh.getIndices(),
            mesh.getVerticesData(VertexBuffer.NormalKind),
            mesh.getVerticesData(VertexBuffer.UVKind),
            new Vector4(0, 0, 1, 1),
            new Vector4(0, 0, 1, 1)
        );

        return mesh;
    }

    /** EXACT original shader strings (names: 'customVertexShader'/'customFragmentShader') */
    _registerOriginalShaders() {
        if (!Effect.ShadersStore['customVertexShader']) {
            Effect.ShadersStore['customVertexShader'] = `
        precision highp float;
        attribute vec3 position;
        attribute vec2 uv;
        uniform mat4 worldViewProjection;
        uniform float time;
        out float newY;
        varying vec3 vPosition;
        varying vec4 vClipSpace;

        void main(void) {
            // === Water surface waves ===
            float scale = 6.0;       // wavelength (~6 units)
            float amp   = 0.07;      // amplitude (~7 cm visually)
            float speed = 1.2;       // time multiplier

            // combine 2 angled waves for variety
            float wave1 = sin((position.x + position.z) / scale + time * speed);
            float wave2 = sin((position.x - position.z) / (scale * 1.3) + time * speed * 1.1);
            newY = (wave1 + wave2) * 0.5 * amp;

            vec3 newPositionM = vec3(position.x, newY, position.z);
            gl_Position = worldViewProjection * vec4(newPositionM, 1.0);
            vPosition = position;
            vClipSpace = gl_Position;
        }
      `;
        }
        // Your original had two fragment definitions; the second overwrote the first.
        // We register the final one you pasted verbatim:
        Effect.ShadersStore['customFragmentShader'] = `
precision highp float;
varying vec3 vPosition;
varying vec4 vClipSpace;

uniform sampler2D depthTex;
uniform sampler2D refractionSampler;
uniform float camMinZ;
uniform float camMaxZ;
uniform float maxDepth;

uniform vec4 wFoamColor;
uniform vec4 wDeepColor;
uniform vec4 wShallowColor;

uniform float time;
uniform float wNoiseScale;
uniform float wNoiseOffset;
uniform float fNoiseScale;
in float newY;

float mod289(float x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
vec4 perm(vec4 x){return mod289(((x * 34.0) + 1.0) * x);}
float noise(vec3 p){
  vec3 a = floor(p);
  vec3 d = p - a;
  d = d * d * (3.0 - 2.0 * d);
  vec4 b = a.xxyy + vec4(0.0, 1.0, 0.0, 1.0);
  vec4 k1 = perm(b.xyxy);
  vec4 k2 = perm(k1.xyxy + b.zzww);
  vec4 c = k2 + a.zzzz;
  vec4 k3 = perm(c);
  vec4 k4 = perm(c + 1.0);
  vec4 o1 = fract(k3 * (1.0 / 41.0));
  vec4 o2 = fract(k4 * (1.0 / 41.0));
  vec4 o3 = o2 * d.z + o1 * (1.0 - d.z);
  vec2 o4 = o3.yw * d.x + o3.xz * (1.0 - d.x);
  return o4.y * d.y + o4.x * (1.0 - d.y);
}

void main(void) {
  float waveNoise = noise(vec3(0., time, 0.) + vPosition * wNoiseScale) * wNoiseOffset;
  vec2 ndc = (vClipSpace.xy / vClipSpace.w) / 2.0 + 0.5;

  float depthBehind = texture2D(depthTex, ndc + waveNoise).r;
  float linearWaterDepth = (vClipSpace.z + camMinZ) / (camMaxZ + camMinZ);
  float waterDepth = camMaxZ * (depthBehind - linearWaterDepth);
  float wdepth = clamp((waterDepth / maxDepth), 0.0, 1.0);

  bool isUnder = !gl_FrontFacing;

  vec2 refrOffset = waveNoise * vec2((isUnder ? -6.0 : 6.0), (isUnder ? -4.0 : 4.0));
  vec4 refrColor = texture(refractionSampler, ndc + refrOffset + vec2(newY * 0.5));

  if (!isUnder) {
    // Above surface: brighter and foamy
    float visibility = exp(-3.5 * wdepth);
    vec3 fogged = mix(wDeepColor.rgb, refrColor.rgb, visibility);
    vec3 color = mix(wShallowColor.rgb, fogged, wdepth);
    float foam = 1.0 - smoothstep(0.05, 0.2, wdepth);
    float foamNoise = noise(vec3(vPosition.xz * fNoiseScale, time * 0.7));
    color = mix(color, wFoamColor.rgb, foam * foamNoise * 0.5);
    gl_FragColor = vec4(color, 0.9);
  } else {
    // Below surface: refracted and bluish but transparent
    float scatter = exp(-abs(vPosition.y) * 0.25);
    vec3 base = mix(wDeepColor.rgb * 0.8, wShallowColor.rgb * 1.2, scatter);
    // Mix refracted world with underwater haze
    vec3 color = mix(base, refrColor.rgb, 0.7);
    gl_FragColor = vec4(color, 0.7);
  }
}
`;
    }

    /** Clean teardown */
    dispose() {
        const { scene } = this;

        if (this._renderObserver) {
            scene.onBeforeRenderObservable.remove(this._renderObserver);
            this._renderObserver = null;
        }
        if (this._newMeshObserver) {
            scene.onNewMeshAddedObservable.remove(this._newMeshObserver);
            this._newMeshObserver = null;
        }

        if (this.refractionRTT) {
            const i = scene.customRenderTargets.indexOf(this.refractionRTT);
            if (i !== -1) scene.customRenderTargets.splice(i, 1);
            this.refractionRTT.dispose();
            this.refractionRTT = null;
        }

        this.material?.dispose();
        this.material = null;

        this.mesh?.dispose();
        this.mesh = null;
    }
}
