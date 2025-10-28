import { Constants, Effect, Mesh, MirrorTexture, Plane, RenderTargetTexture, ShaderMaterial, Vector4, VertexBuffer, VertexData } from '@babylonjs/core';

/**
 * Stylized physically-plausible water surface:
 *  - Refraction RTT + mirror RTT (same resolution/aspect as scene)
 *  - Total internal reflection + Snell’s window (cheaply approximated)
 *  - Shared renderList for island mesh (depth/refraction/reflection)
 */
export class Water {
    /**
     * @param {import('@babylonjs/core').Scene} scene
     * @param {{radius?:number, level?:number}} [opts]
     */
    constructor(scene, opts = {}) {
        this.scene = scene;
        this.radius = opts.radius ?? 1024;
        this.level = opts.level ?? 0;

        // === Mesh ===
        this.mesh = this._makeCircularMesh(scene, 'water', this.radius, 256, 256);
        this.mesh.position.y = this.level;

        // === Register shaders ===
        this._registerOriginalShaders();

        // === Depth renderer ===
        const depthRenderer = scene.enableDepthRenderer(scene.activeCamera, false);
        this.depthTex = depthRenderer.getDepthMap();

        // === Determine RTT size to match scene aspect ratio ===
        const engine = scene.getEngine();

        // === Refraction RTT ===
        this.refractionRTT = new RenderTargetTexture('water_refraction', { ratio: 0.25 }, scene, false, true);
        this.refractionRTT.wrapU = Constants.TEXTURE_MIRROR_ADDRESSMODE;
        this.refractionRTT.wrapV = Constants.TEXTURE_MIRROR_ADDRESSMODE;
        // this.refractionRTT.ignoreCameraViewport = true;
        this.refractionRTT.refreshRate = 1;
        this.refractionRTT.renderList = [];
        this.refractionRTT.activeCamera = scene.activeCamera;

        // === Reflection RTT (using MirrorTexture for proper mirroring) ===
        this.reflectionRTT = new MirrorTexture('water_reflection', { ratio: 0.25 }, scene, true);
        this.reflectionRTT.mirrorPlane = new Plane(0, -1, 0, this.level +1);
        
        // this.reflectionRTT.ignoreCameraViewport = true;
        this.reflectionRTT.refreshRate = 1;
        this.reflectionRTT.renderList = [];

        scene.customRenderTargets.push(this.refractionRTT);
        scene.customRenderTargets.push(this.reflectionRTT);

        // === Shader material ===
        const shaderMaterial = new ShaderMaterial(
            'shader',
            scene,
            { vertex: 'custom', fragment: 'custom' },
            {
                attributes: ['position', 'normal', 'uv'],
                uniforms: [
                    'world',
                    'worldView',
                    'worldViewProjection',
                    'view',
                    'projection',
                    // you were missing all of these:
                    'time',
                    'wNoiseScale',
                    'wNoiseOffset',
                    'fNoiseScale',
                    'camMinZ',
                    'camMaxZ',
                    'maxDepth',
                    'wFoamColor',
                    'wDeepColor',
                    'wShallowColor',
                    'iorWater',
                    'iorAir',
                    'refrScale',
                    'reflScale',
                    'skyColor',
                    // add this if you use a reflection matrix (section 2)
                    'reflectionMatrix'
                ],
                samplers: ['depthTex', 'refractionSampler', 'reflectionSampler']
            }
        );
        shaderMaterial.backFaceCulling = false;

        // === Uniforms ===
        shaderMaterial.setTexture('depthTex', this.depthTex);
        shaderMaterial.setTexture('refractionSampler', this.refractionRTT);
        shaderMaterial.setTexture('reflectionSampler', this.reflectionRTT);

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
        shaderMaterial.setFloat('iorWater', 1.333);
        shaderMaterial.setFloat('iorAir', 1.0);
        shaderMaterial.setFloat('refrScale', 0.15);
        shaderMaterial.setFloat('reflScale', 0.2);
        shaderMaterial.setVector4('skyColor', new Vector4(0.65, 0.8, 1.0, 1.0));
        shaderMaterial.alpha = 0.9;

        this.material = shaderMaterial;
        this.mesh.material = shaderMaterial;

        // === Keep time and RTTs in sync ===
        this._renderObserver = scene.onBeforeRenderObservable.add(() => {
            shaderMaterial.setFloat('time', performance.now() * 0.001);
            this.refractionRTT.activeCamera = scene.activeCamera;
        });

        // === Handle resizing to keep aspect ratio ===
        engine.onResizeObservable.add(() => {
            const w = engine.getRenderWidth();
            const h = engine.getRenderHeight();
            this.refractionRTT.resize({ width: w, height: h });
            this.reflectionRTT.resize({ width: w, height: h });
        });

        // === Link island mesh to RTTs ===
        const linkIsland = (m) => {
            if (m && m.name === 'island') {
                const list = [m];
                this.refractionRTT.renderList = list;
                this.reflectionRTT.renderList = list;
                this.depthTex.renderList = list;
            }
        };
        this._newMeshObserver = scene.onNewMeshAddedObservable.add(linkIsland);
        scene.meshes.forEach(linkIsland);

        // === Build & maintain render lists dynamically ===
        const updateRenderLists = () => {
            const list = scene.meshes.filter((m) =>  m !== this.mesh && m.isVisible && m.isEnabled());
            this.reflectionRTT.renderList = list;
            //   this.depthTex.renderList = list;
        };

        // Initial population
        updateRenderLists();

        // Keep up to date when new meshes appear or disappear
        this._meshAddedObserver = scene.onNewMeshAddedObservable.add(updateRenderLists);
        this._meshRemovedObserver = scene.onMeshRemovedObservable?.add?.(updateRenderLists);
    }

    /** Circular water surface */
    _makeCircularMesh(scene, name, radius = 128, radialSegments = 80, ringSegments = 80) {
        const positions = [];
        const indices = [];
        const uvs = [];

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

    /** Vertex + fragment shaders */
    _registerOriginalShaders() {
        if (!Effect.ShadersStore['customVertexShader']) {
            Effect.ShadersStore['customVertexShader'] = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 worldView;
uniform mat4 worldViewProjection;
uniform float time;

out float newY;
varying vec3 vPosition;
varying vec4 vClipSpace;
varying vec3 vPosVS;
varying vec3 vNormalVS;

void main(void) {
  float scale = 6.0;
  float amp   = 0.07;
  float speed = 1.2;

  float a1 = (position.x + position.z) / scale + time * speed;
  float a2 = (position.x - position.z) / (scale * 1.3) + time * speed * 1.1;

  float wave1 = sin(a1);
  float wave2 = sin(a2);
  newY = (wave1 + wave2) * 0.5 * amp;

  float dhdx = 0.5 * amp * (cos(a1) * (1.0/scale) + cos(a2) * (1.0/(scale*1.3)));
  float dhdz = 0.5 * amp * (cos(a1) * (1.0/scale) - cos(a2) * (1.0/(scale*1.3)));
  vec3 nW = normalize(vec3(-dhdx, 1.0, -dhdz));

  vec3 posW = vec3(position.x, newY, position.z);
  vec4 posVS = worldView * vec4(posW, 1.0);
  vPosVS = posVS.xyz;
  vNormalVS = normalize((worldView * vec4(nW, 0.0)).xyz);

  gl_Position = worldViewProjection * vec4(posW, 1.0);
  vPosition = position;
  vClipSpace = gl_Position;
}
`;
        }

        Effect.ShadersStore['customFragmentShader'] = `
precision highp float;

varying vec3 vPosition;
varying vec4 vClipSpace;
varying vec3 vPosVS;
varying vec3 vNormalVS;
in float newY;

uniform sampler2D depthTex;
uniform sampler2D refractionSampler;
uniform sampler2D reflectionSampler;

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

uniform float iorWater;
uniform float iorAir;
uniform float refrScale;
uniform float reflScale;
uniform vec4  skyColor;

// ---- noise helper ----
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

float fresnelSchlick(float cosTheta, float F0) {
  return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

void main(void) {
  float waveNoise = noise(vec3(0., time, 0.) + vPosition * wNoiseScale) * wNoiseOffset;
  vec2 ndc = (vClipSpace.xy / vClipSpace.w) * 0.5 + 0.5;

  float depthBehind = texture2D(depthTex, ndc + waveNoise).r;
  float linearWaterDepth = (vClipSpace.z + camMinZ) / (camMaxZ + camMinZ);
  float waterDepth = camMaxZ * (depthBehind - linearWaterDepth);
  float wdepth = clamp((waterDepth / maxDepth), 0.0, 1.0);

  bool isUnder = !gl_FrontFacing;
  vec3 N = normalize(vNormalVS);
  vec3 V = normalize(-vPosVS);

  float n1 = isUnder ? iorWater : iorAir;
  float n2 = isUnder ? iorAir   : iorWater;
  float eta = n1 / n2;

  float cosI = clamp(dot(N, V), 0.0, 1.0);
  float F0 = pow((n1 - n2) / (n1 + n2), 2.0);

  vec3 T = refract(-V, N, eta);
  vec3 R = reflect(-V, N);

  bool TIR = all(lessThan(abs(T), vec3(1e-6)));
  float Fr = TIR ? 1.0 : fresnelSchlick(cosI, F0);

  vec2 refrUV = ndc + refrScale * (T.xy) + vec2(newY * 0.5) + waveNoise;
  vec2 reflUV = ndc + reflScale * (R.xy) + vec2(-newY * 0.35) - waveNoise;
//   reflUV.y = 1.0 - reflUV.y; // flip vertically for mirror

  refrUV = clamp(refrUV, 0.001, 0.999);
  reflUV = clamp(reflUV, 0.001, 0.999);

  vec3 refrColor = texture2D(refractionSampler, refrUV).rgb;
  vec3 reflColor = texture2D(reflectionSampler, reflUV).rgb;

  if (!isUnder) {
    float visibility = exp(-3.5 * wdepth);
    vec3 fogged = mix(wDeepColor.rgb, refrColor, visibility);
    vec3 base = mix(wShallowColor.rgb, fogged, wdepth);
    vec3 fresnelMix = mix(base, reflColor, Fr);
    float foam = 1.0 - smoothstep(0.05, 0.2, wdepth);
    float foamNoise = noise(vec3(vPosition.xz * fNoiseScale, time * 0.7));
    vec3 withFoam = mix(fresnelMix, wFoamColor.rgb, foam * foamNoise * 0.5);
    gl_FragColor = vec4(withFoam, 0.9);
  } else {
    float scatter = exp(-abs(vPosition.y) * 0.25);
    vec3 haze = mix(wDeepColor.rgb * 0.8, wShallowColor.rgb * 1.2, scatter);
    vec3 mixRT = mix(refrColor, reflColor, Fr);
    vec3 color = mix(haze, mixRT, 0.7);
    float rim = smoothstep(0.7, 1.0, Fr);
    color *= mix(1.0, 0.85, rim);
    gl_FragColor = vec4(color, 0.7);
  }
}
`;
    }

    /** Dispose everything cleanly */
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

        if (this.reflectionRTT) {
            const i = scene.customRenderTargets.indexOf(this.reflectionRTT);
            if (i !== -1) scene.customRenderTargets.splice(i, 1);
            this.reflectionRTT.dispose();
            this.reflectionRTT = null;
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
