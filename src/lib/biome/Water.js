import { Constants, Effect, Mesh, MirrorTexture, Plane, RenderTargetTexture, ShaderMaterial, Vector4, VertexData } from '@babylonjs/core';

/**
 * Stylized physically-plausible water surface with Gerstner waves + natural horizon blending.
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
        this._registerShaders();

        // === Depth renderer ===
        const depthRenderer = scene.enableDepthRenderer(scene.activeCamera, false);
        this.depthTex = depthRenderer.getDepthMap();

        // === Refraction RTT ===
        this.refractionRTT = new RenderTargetTexture('water_refraction', { ratio: 0.25 }, scene, false, true);
        this.refractionRTT.wrapU = Constants.TEXTURE_MIRROR_ADDRESSMODE;
        this.refractionRTT.wrapV = Constants.TEXTURE_MIRROR_ADDRESSMODE;
        this.refractionRTT.refreshRate = 1;
        this.refractionRTT.renderList = [];
        this.refractionRTT.activeCamera = scene.activeCamera;

        // === Reflection RTT ===
        this.reflectionRTT = new MirrorTexture('water_reflection', { ratio: 0.5 }, scene, true);
        this.reflectionRTT.adaptiveBlurKernel = 64;
        this.reflectionRTT.mirrorPlane = new Plane(0, -1, 0, this.level + 1);
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
                    'cameraPosition',

                    // time & camera depth params
                    'time',
                    'camMinZ',
                    'camMaxZ',
                    'maxDepth',

                    // water colors
                    'wFoamColor',
                    'wDeepColor',
                    'wShallowColor',

                    // screen-space noise helpers
                    'wNoiseScale',
                    'wNoiseOffset',
                    'fNoiseScale',

                    // optics
                    'iorWater',
                    'iorAir',
                    'refrScale',
                    'reflScale',

                    // gerstner controls
                    'gravity',
                    'waterDepth',
                    'choppiness',
                    'waveA',
                    'waveB',
                    'waveC',
                    'waveD',
                    'steepness',
                    'windDir',
                    'sceneColor',
                    'exposure'
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

        shaderMaterial.setFloat('wNoiseScale', 0.18);
        shaderMaterial.setFloat('wNoiseOffset', 0.015);
        shaderMaterial.setFloat('fNoiseScale', 1.8);
        shaderMaterial.setFloat('maxDepth', 5.0);

        shaderMaterial.setVector4('wDeepColor', new Vector4(0.0, 0.3, 0.5, 1.0));
        shaderMaterial.setVector4('wShallowColor', new Vector4(0.0, 0.7, 0.9, 1.0));
        shaderMaterial.setVector4('wFoamColor', new Vector4(1, 1, 1, 1));

        shaderMaterial.setFloat('iorWater', 1.333);
        shaderMaterial.setFloat('iorAir', 1.0);
        shaderMaterial.setFloat('refrScale', 0.12);
        shaderMaterial.setFloat('reflScale', 0.22);

        shaderMaterial.setFloat('gravity', 9.81);
        shaderMaterial.setFloat('waterDepth', 20.0);
        shaderMaterial.setFloat('choppiness', 0.9);
        shaderMaterial.setVector4('waveA', new Vector4(1.0, 0.3, 0.0, 12.0)); // swell
        shaderMaterial.setVector4('waveB', new Vector4(-0.7, 1.0, 0.0, 7.0)); // swell 2
        shaderMaterial.setVector4('waveC', new Vector4(0.3, -1.0, 0.0, 3.0)); // chop
        shaderMaterial.setVector4('waveD', new Vector4(-1.0, -0.4, 0.0, 1.5)); // chop
        shaderMaterial.setVector4('steepness', new Vector4(0.75, 0.8, 0.65, 0.6));
        shaderMaterial.setVector4('windDir', new Vector4(0.8, -0.6, 0, 0));
        const cc = scene.clearColor;
        shaderMaterial.setVector4('sceneColor', new Vector4(cc.r, cc.g, cc.b, 1.0));
        shaderMaterial.setFloat('exposure', scene.imageProcessingConfiguration.exposure ?? 1.0);

        shaderMaterial.alpha = 1;

        this.material = shaderMaterial;
        this.mesh.material = shaderMaterial;

        // === Keep time and camera in sync ===
        this._renderObserver = scene.onBeforeRenderObservable.add(() => {
            shaderMaterial.setFloat('time', performance.now() * 0.0006);

            shaderMaterial.setVector3('cameraPosition', scene.activeCamera.position);
            this.refractionRTT.activeCamera = scene.activeCamera;
        });

        // === Handle resizing ===
        const engine = scene.getEngine();
        engine.onResizeObservable.add(() => {
            const w = engine.getRenderWidth();
            const h = engine.getRenderHeight();
            this.refractionRTT.resize({ width: w, height: h });
            this.reflectionRTT.resize({ width: w, height: h });
        });

        // === Link island ===
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

        // === Maintain reflection lists ===
        const updateRenderLists = () => {
            const list = scene.meshes.filter((m) => m !== this.mesh && m.isVisible && m.isEnabled());
            this.reflectionRTT.renderList = list;
            //   this.refractionRTT.renderList = list;
        };
        updateRenderLists();
        this._meshAddedObserver = scene.onNewMeshAddedObservable.add(updateRenderLists);
        this._meshRemovedObserver = scene.onMeshRemovedObservable?.add?.(updateRenderLists);
    }

    /** Circular water mesh */
    /** Circular water mesh with downward extruded edge ("barrel") */
    _makeCircularMesh(scene, name, radius = 128, radialSegments = 80, ringSegments = 80, edgeDepth = 2000) {
        const positions = [];
        const indices = [];
        const uvs = [];

        // --- main circular surface ---
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

        // --- extrude the outer ring downward ---
        const baseRingStart = ringSegments * stride;
        for (let j = 0; j <= radialSegments; j++) {
            const idx = baseRingStart + j;
            const x = positions[idx * 3 + 0];
            const z = positions[idx * 3 + 2];
            positions.push(x, -edgeDepth, z);
            uvs.push(j / radialSegments, 1.1); // push UV slightly beyond 1 for gradient safety
        }

        const newRingStart = positions.length / 3 - (radialSegments + 1);
        for (let j = 0; j < radialSegments; j++) {
            const topA = baseRingStart + j;
            const topB = baseRingStart + j + 1;
            const botA = newRingStart + j;
            const botB = newRingStart + j + 1;
            indices.push(topA, topB, botA, topB, botB, botA);
        }

        // --- reverse winding to match reflection ---
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
        return mesh;
    }

    /** Vertex + fragment shaders */
    _registerShaders() {
        // === Vertex shader unchanged (Gerstner) ===
       Effect.ShadersStore["customVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 worldView;
uniform mat4 worldViewProjection;
uniform float time;

varying vec3 vPositionW;
varying vec4 vClipSpace;
varying vec3 vPosVS;
varying vec3 vNormalW;
varying float vCrest;

// ---------------- Gerstner Waves (Shadertoy exact port) ----------------
#define NUM_WAVES 14
#define SEA_LEVEL 0.0

float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }

struct Wave { vec2 dir; float amp; float k; float w; float phase; };

void initWaves(out Wave W[NUM_WAVES], float t){
    float baseA = 0.7 + 0.2*sin(t*0.03);
    vec2 wind = normalize(vec2(cos(baseA), sin(baseA)));

    for(int i=0;i<NUM_WAVES;++i){
        float fi = float(i);
        float r0 = hash11(10.0+fi);
        float r1 = hash11(20.0+fi);
        bool swell = (i < NUM_WAVES/3);

        float L = swell ? mix(6.0,14.0,r0) : mix(0.18,2.8,r0);
        float k = 6.28318530718 / L;
        float w = sqrt(9.8*k);

        float aSpread = swell ? mix(-0.6,0.6,r1) : mix(-3.14159,3.14159,r1);
        vec2 dir = normalize(rot(baseA + aSpread) * vec2(1.0,0.0));

        float amp = swell ? mix(0.06,0.16,r0) : mix(0.006,0.035,r0);
        W[i] = Wave(dir, amp, k, w, r1*6.28318);
    }
}

float heightAt(vec2 xz, float t, Wave W[NUM_WAVES]){
    float y=0.0;
    for(int i=0;i<NUM_WAVES;++i){
        Wave w=W[i];
        float th = dot(w.dir,xz)*w.k - w.w*t + w.phase;
        y += w.amp * sin(th);
    }
    return y + SEA_LEVEL;
}

vec2 heightGrad(vec2 xz, float t, Wave W[NUM_WAVES]){
    vec2 g = vec2(0.0);
    for(int i=0;i<NUM_WAVES;++i){
        Wave w=W[i];
        float th = dot(w.dir,xz)*w.k - w.w*t + w.phase;
        g += w.amp * w.k * w.dir * cos(th);
    }
    return g;
}

void main(){
    Wave W[NUM_WAVES];
    initWaves(W, time);

    vec3 pos = position;
    float y = heightAt(pos.xz, time, W);
    vec2 grad = heightGrad(pos.xz, time, W);
    pos.y = y;

    // Normal from analytical slope
    vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));

    // A simple curvature proxy for foam
    float slope = length(grad);
    float crest = smoothstep(0.8, 1.6, slope);
    vCrest = crest;

    // Transformations
    vec4 worldPos = world * vec4(pos, 1.0);
    vPositionW = worldPos.xyz;
    vNormalW = normalize((world * vec4(n, 0.0)).xyz);
    vPosVS = (worldView * vec4(pos, 1.0)).xyz;
    vec4 clip = worldViewProjection * vec4(pos, 1.0);
    vClipSpace = clip;
    gl_Position = clip;
}
`;


        // === Fragment shader with horizon blending ===
        Effect.ShadersStore['customFragmentShader'] = `
precision highp float;

varying vec3 vPositionW;
varying vec4 vClipSpace;
varying vec3 vPosVS;
varying vec3 vNormalW;
varying float vCrest;

uniform sampler2D depthTex;
uniform sampler2D refractionSampler;
uniform sampler2D reflectionSampler;

uniform float camMinZ;
uniform float camMaxZ;
uniform float maxDepth;
uniform vec4  wFoamColor;
uniform vec4  wDeepColor;
uniform vec4  wShallowColor;
uniform float time;
uniform float wNoiseScale;
uniform float wNoiseOffset;
uniform float fNoiseScale;
uniform float iorWater;
uniform float iorAir;
uniform float refrScale;
uniform float reflScale;
uniform vec4  windDir;
uniform vec3  cameraPosition;
uniform vec4 sceneColor;
uniform float exposure;

// --- helpers ---
float mod289(float x){return x - floor(x*(1.0/289.0))*289.0;}
vec4  mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4  perm(vec4 x){return mod289(((x*34.0)+1.0)*x);}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = dot(i, vec3(1.0, 57.0, 113.0));
  float res = mix(
    mix(
      mix(fract(sin(n + 0.0) * 43758.5453),
          fract(sin(n + 1.0) * 43758.5453), f.x),
      mix(fract(sin(n + 57.0) * 43758.5453),
          fract(sin(n + 58.0) * 43758.5453), f.x),
      f.y),
    mix(
      mix(fract(sin(n + 113.0) * 43758.5453),
          fract(sin(n + 114.0) * 43758.5453), f.x),
      mix(fract(sin(n + 170.0) * 43758.5453),
          fract(sin(n + 171.0) * 43758.5453), f.x),
      f.y),
    f.z);
  return res;
}

float fresnelSchlick(float cosTheta, float F0){
  return F0 + (1.0 - F0)*pow(1.0 - cosTheta, 5.0);
}

void main(void){
  vec2 ndc = (vClipSpace.xy / vClipSpace.w) * 0.5 + 0.5;
  float ripple = noise(vec3(vPositionW.xz * wNoiseScale * 1.8, time*1.3)) * wNoiseOffset;
  float depthBehind = texture2D(depthTex, ndc + ripple).r;
  float linearWaterDepth = (vClipSpace.z + camMinZ) / (camMaxZ + camMinZ);
  float waterDepth = camMaxZ * (depthBehind - linearWaterDepth);
  float wdepth = clamp(waterDepth / maxDepth, 0.0, 1.0);

  bool isUnder = !gl_FrontFacing;
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(-vPosVS);

  // === Correct IORs depending on inside/outside ===
  float n1 = isUnder ? iorWater : iorAir;
  float n2 = isUnder ? iorAir : iorWater;
  float eta = n1 / n2;
  float cosI = clamp(dot(N, V), 0.0, 1.0);
  float F0 = pow((n1 - n2) / (n1 + n2), 2.0);
  float Fr = fresnelSchlick(cosI, F0);

  // === compute refraction direction properly ===
  vec3 T = refract(-V, N, eta);
  vec3 R = reflect(-V, N);

  bool TIR = all(lessThan(abs(T), vec3(1e-6)));
  if (TIR) Fr = 1.0;

  // === Screen-space UV offsets for reflection/refraction ===
  vec2 refrUV = ndc + refrScale * (T.xy) + ripple * 0.6;
  vec2 reflUV = ndc + reflScale * (R.xy) - ripple * 0.6;

  // === For underwater: invert sense of refraction ===
  if (isUnder) {
    // flip refraction direction vertically to look upward
    refrUV = ndc - refrScale * (T.xy) - ripple * 0.6;
  }

  refrUV = clamp(refrUV, 0.001, 0.999);
  reflUV = clamp(reflUV, 0.001, 0.999);

  // === sample world ===
  vec3 refrColor = texture2D(refractionSampler, refrUV).rgb;
  vec3 reflColor = texture2D(reflectionSampler, reflUV).rgb;

// === physically-consistent sky and exposure ===

vec3 envColor = sceneColor.rgb * exposure;

// absorption (clear tropical water baseline) scaled by scene brightness
float envLum = max(0.001, dot(envColor, vec3(0.2126, 0.7152, 0.0722)));



// generate an approximate sky gradient around that color
// zenith slightly darker, horizon slightly lighter, scaled by luminance
vec3 skyZenith  = envColor * 0.85; // slightly darker upward
vec3 skyHorizon = envColor * 1.05; // slightly lighter near horizon

// horizon mix based on view angle
vec3 Vworld = normalize(vPositionW - cameraPosition);
if (isUnder) Vworld = -Vworld; // look "up" from underwater
float horizonBlend = smoothstep(0.25, 0.95, 1.0 - abs(dot(Vworld, vec3(0.0, 1.0, 0.0))));
vec3 skyColor = mix(skyZenith, skyHorizon, horizonBlend);


float lumScale = clamp(envLum * 1.3, 0.3, 1.3);
vec3 absorb = vec3(0.08, 0.045, 0.02) / lumScale;

// slightly slower attenuation for realistic clarity
vec3 transmittance = exp(-absorb * (4.0 * clamp(wdepth + 0.15, 0.0, 1.0)));



  vec3 deepCol = mix(wDeepColor.rgb, wShallowColor.rgb, 0.3);
  vec3 transColor = deepCol * transmittance;

  // === foam ===
  vec2 wind = normalize(windDir.xy + 1e-4);
  vec2 advect = wind * time * 0.03;
  float foamNoise = noise(vec3((vPositionW.xz + advect) * fNoiseScale, time * 0.5));
  float shallowFoam = 1.0 - smoothstep(0.15, 0.8, wdepth);
  float crestFoam = smoothstep(0.4, 0.9, vCrest);
  float foamMask = clamp(foamNoise * (0.4 * shallowFoam + 0.8 * crestFoam), 0.0, 1.0);

  // === combine reflection and refraction ===
  float roughness = 0.15;
  Fr *= mix(1.0, 0.75, roughness);
  vec3 fresnelMix = mix(transColor, reflColor, Fr * 0.85);
  if (TIR) fresnelMix = mix(fresnelMix, reflColor, 0.6);
  vec3 withFoam = mix(fresnelMix, wFoamColor.rgb, foamMask * 0.6);

  // === ABOVE WATER ===
  if (!isUnder) {
    float airFade = smoothstep(0.0, 1.0, horizonBlend);
    vec3 airMix = mix(withFoam, skyColor, airFade * 0.12);
    float fog = exp(-pow(horizonBlend * 1.3, 2.0));
    gl_FragColor = vec4(mix(skyColor, airMix, fog), 0.9);
  }
  // === UNDERWATER ===
  else {
    // Snell's window weighting
    vec3 viewDir = normalize(-V);
    float cosView = dot(viewDir, vec3(0.0, 1.0, 0.0));
    float snellWindow = smoothstep(0.45, 0.97, cosView);

    // attenuation (Beer–Lambert)
    float depthMeters = abs(vPositionW.y) * 0.25;
    vec3 attenuation = exp(-absorb * depthMeters);

    // see *through* the water surface up at sky via flipped refraction
    vec3 aboveColor = texture2D(reflectionSampler, refrUV).rgb;
    aboveColor = mix(aboveColor, skyColor, 0.4);
    aboveColor *= attenuation;

// --- better underwater scattering ---
vec3 baseWaterColor = vec3(0.0, 0.45, 0.65);  // deep aqua
float upness = clamp(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
vec3 scatter = mix(vec3(0.0, 0.25, 0.4), baseWaterColor, pow(upness, 2.0));
scatter *= attenuation * 0.9;

vec3 color = mix(scatter, aboveColor, snellWindow * 1.1);
color = mix(color, reflColor, Fr * 0.2);      // subtle reflection



    // total internal reflection darkening
    if (TIR) color *= 0.35;

    // soften edges
    float edgeDarken = pow(1.0 - cosView, 2.0);
    color *= mix(1.0, 0.65, edgeDarken);

    gl_FragColor = vec4(color, 0.85);
  }
}

`;
    }

    /** Dispose */
    dispose() {
        const { scene } = this;
        if (this._renderObserver) scene.onBeforeRenderObservable.remove(this._renderObserver);
        if (this._newMeshObserver) scene.onNewMeshAddedObservable.remove(this._newMeshObserver);
        if (this.reflectionRTT) {
            scene.customRenderTargets.splice(scene.customRenderTargets.indexOf(this.reflectionRTT), 1);
            this.reflectionRTT.dispose();
        }
        if (this.refractionRTT) {
            scene.customRenderTargets.splice(scene.customRenderTargets.indexOf(this.refractionRTT), 1);
            this.refractionRTT.dispose();
        }
        this.material?.dispose();
        this.mesh?.dispose();
    }
}
