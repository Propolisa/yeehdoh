import { Constants, Effect, Mesh, MirrorTexture, Plane, RenderTargetTexture, ShaderMaterial, Vector4, VertexData } from '@babylonjs/core';
import GUI from 'lil-gui';
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
        this.refractionRTT = new RenderTargetTexture('water_refraction', { ratio: 0.75 }, scene, false, true);
        this.refractionRTT.wrapU = Constants.TEXTURE_MIRROR_ADDRESSMODE;
        this.refractionRTT.wrapV = Constants.TEXTURE_MIRROR_ADDRESSMODE;
        this.refractionRTT.refreshRate = 1;
        this.refractionRTT.renderList = [];
        this.refractionRTT.activeCamera = scene.activeCamera;

        // === Reflection RTT ===
        this.reflectionRTT = new MirrorTexture('water_reflection', { ratio: 0.5 }, scene, true);
        this.reflectionRTT.adaptiveBlurKernel = 64;
        this.reflectionRTT.mirrorPlane = new Plane(0, -1, 0, this.level);
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
        const u = {
             Foam: {
    foamStrength: { value: 1.2, range: [0, 3, 0.01] },
    foamThreshold: { value: 0.4, range: [0, 1, 0.01] },
    foamFalloff: { value: 1.2, range: [0, 3, 0.01] },
    foamShallowBoost: { value: 1.0, range: [0, 3, 0.01] },
    foamNoiseScale: { value: 1.0, range: [0.1, 3, 0.01] },
    wFoamColor: { value: new Vector4(0.95, 0.97, 1.0, 1.0), color: true },
  },


            Waves: {
                gravity: { value: 9.81, range: [0, 30, 0.01] },
                waterDepth: { value: 20.0, range: [0, 100, 0.1] },
                choppiness: { value: 1.1, range: [0, 3, 0.01] },
                waveAmpScale: { value: 1.0, range: [0, 3, 0.01] },
                waveLengthScale: { value: 1.0, range: [0, 3, 0.01] },
                waveSpeed: { value: 1.0, range: [0, 3, 0.01] }
            },

            Optics: {
                iorWater: { value: 1.333, range: [1, 2, 0.001] },
                iorAir: { value: 1.0, range: [0.5, 2, 0.001] },
                refrScale: { value: 0.18, range: [0, 1, 0.01] },
                reflScale: { value: 0.12, range: [0, 1, 0.01] },
                maxDepth: { value: 5.0, range: [0, 50, 0.1] }
            },

            Colors: {
                wDeepColor: { value: new Vector4(0.02, 0.25, 0.4, 1.0), color: true },
                wShallowColor: { value: new Vector4(0.03, 0.55, 0.7, 1.0), color: true }
            },

            Noise: {
                wNoiseScale: { value: 0.18, range: [0, 1, 0.001] },
                wNoiseOffset: { value: 0.015, range: [0, 0.1, 0.001] },
                fNoiseScale: { value: 1.8, range: [0, 5, 0.01] }
            }
        };

        // === Apply numeric uniforms ===
        for (const [key, def] of Object.entries(u)) {
            shaderMaterial.setFloat(key, def.value);
        }
shaderMaterial.setFloat('camMinZ', scene.activeCamera.minZ);
shaderMaterial.setFloat('camMaxZ', scene.activeCamera.maxZ);

        // === GUI setup ===
        const gui = new GUI({ title: 'Water Shader' });

        // helper for color4 uniforms
        const setColorUniform = (mat, key, vec) => {
            mat.setVector4(key, vec);
        };

        // main iteration
        for (const [groupName, group] of Object.entries(u)) {
            const folder = gui.addFolder(groupName);

            for (const [key, def] of Object.entries(group)) {
                const val = def.value;

                if (def.color) {
                    // --- COLOR UNIFORMS ---
                    setColorUniform(shaderMaterial, key, val);
                    const picker = { color: [val.x, val.y, val.z] };
                    folder
                        .addColor(picker, 'color')
                        .name(key)
                        .onChange((rgb) => {
                            const [r, g, b] = rgb;
                            setColorUniform(shaderMaterial, key, new Vector4(r, g, b, 1.0));
                        });
                } else {
                    // --- FLOAT UNIFORMS ---
                    shaderMaterial.setFloat(key, val);
                    if (def.range) {
                        folder
                            .add(def, 'value', def.range[0], def.range[1], def.range[2])
                            .name(key)
                            .onChange((v) => shaderMaterial.setFloat(key, v));
                    }
                }
            }
        }

        // === Textures ===
        shaderMaterial.setTexture('depthTex', this.depthTex);
        shaderMaterial.setTexture('refractionSampler', this.refractionRTT);
        shaderMaterial.setTexture('reflectionSampler', this.reflectionRTT);

        // === Waves A–D definitions ===
        shaderMaterial.setVector4('waveA', new Vector4(1.0, 0.3, 0.0, 12.0)); // swell
        shaderMaterial.setVector4('waveB', new Vector4(-0.7, 1.0, 0.0, 7.0)); // swell 2
        shaderMaterial.setVector4('waveC', new Vector4(0.3, -1.0, 0.0, 3.0)); // chop
        shaderMaterial.setVector4('waveD', new Vector4(-1.0, -0.4, 0.0, 1.5)); // chop

        shaderMaterial.alpha = 1;

        this.material = shaderMaterial;
        this.mesh.material = shaderMaterial;

        // === Keep time and camera in sync ===
        this._renderObserver = scene.onBeforeRenderObservable.add(() => {
            shaderMaterial.setFloat('time', performance.now() * 0.0009);

            shaderMaterial.setVector3('cameraPosition', scene.activeCamera.position);
            this.refractionRTT.activeCamera = scene.activeCamera;
        });

        // === Handle resizing ===
        const engine = scene.getEngine();
        engine.onResizeObservable.add(() => {
            this.refractionRTT.resize({ ratio: 0.75 });
            this.reflectionRTT.resize({ ratio: 0.5 });
            shaderMaterial.setTexture('refractionSampler', this.refractionRTT);
            shaderMaterial.setTexture('reflectionSampler', this.reflectionRTT);
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
            this.refractionRTT.renderList = list;
        };
        updateRenderLists();
        this._meshAddedObserver = scene.onNewMeshAddedObservable.add(updateRenderLists);
        this._meshRemovedObserver = scene.onMeshRemovedObservable?.add?.(updateRenderLists);
    }

    /** Circular water surface (double-sided), same topology approach */
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
        Effect.ShadersStore['customVertexShader'] = `precision highp float;
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 worldView;
uniform mat4 worldViewProjection;
uniform float time;

// === Tunables & physical parameters ===
uniform float gravity;         // affects wave period
uniform float waterDepth;      // affects directional coherence
uniform float choppiness;      // horizontal displacement strength
uniform float waveAmpScale;    // amplitude multiplier
uniform float waveLengthScale; // wavelength multiplier
uniform float waveSpeed;       // temporal speed
uniform float waveSeed;        // per-instance random offset
uniform vec4  windDir;         // direction + magnitude
uniform vec4  steepness;       // 4-component slope mod (currently applied globally)
uniform float windSeed;        // secondary random phase for gusts (optional)

// === Outputs ===
varying vec3 vPositionW;
varying vec4 vClipSpace;
varying vec3 vPosVS;
varying vec3 vNormalW;
varying float vCrest;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
float hash11(float p){ 
    p = fract(p*0.1031 + waveSeed*0.17);
    p *= p + 33.33; 
    p *= p + p; 
    return fract(p);
}

mat2 rot(float a){ 
    float c = cos(a), s = sin(a); 
    return mat2(c,-s,s,c); 
}

#define NUM_WAVES 5

struct Wave { vec2 dir; float amp; float k; float w; float phase; };

// ---------------------------------------------------------------------------
// Wave initialization — loosely aligned with wind direction, modulated by depth
// ---------------------------------------------------------------------------
void initWaves(out Wave W[NUM_WAVES], float t){
    // Compute wind properties
    float windMag = clamp(length(windDir.xy), 0.0, 3.0);           // strength
    vec2 windNorm = windMag > 0.001 ? normalize(windDir.xy) : vec2(1.0, 0.0);

    // Gentle time-based gust rotation
    float gust = sin(t * 0.05 + windSeed * 3.14159) * 0.15;        // ±0.15 radians
    mat2 gustRot = rot(gust);
    vec2 baseDir = gustRot * windNorm;

    // Coherence from depth & wind
    float depthAlign = clamp(waterDepth / 30.0, 0.0, 1.0);         // deep→aligned
    float windAlign  = smoothstep(0.2, 1.5, windMag);               // strong wind→aligned
    float alignment  = clamp(0.25 + 0.75 * windAlign * depthAlign, 0.0, 1.0);

    // Populate wave set
    for (int i=0; i<NUM_WAVES; ++i){
        float fi = float(i);
        float r0 = hash11(10.0 + fi);
        float r1 = hash11(20.0 + fi);
        bool swell = (i < NUM_WAVES/3);

        float L = swell ? mix(6.0,14.0,r0) : mix(0.4,3.0,r0);
        L *= waveLengthScale;
        float k = 6.28318530718 / L;
        float w = sqrt(gravity * k);

        // Direction spread inversely related to alignment
        float spread = radians(mix(60.0, 10.0, alignment));
        float deviation = radians(mix(-spread, spread, r1));
        vec2 dir = normalize(rot(deviation) * baseDir);

        // Amplitude scales with wind strength and global amp
        float amp = (swell ? mix(0.06,0.15,r0) : mix(0.008,0.035,r0));
        amp *= (0.8 + 0.4 * windAlign) * waveAmpScale;

        W[i] = Wave(dir, amp, k, w, r1 * 6.28318);
    }
}

// ---------------------------------------------------------------------------
// Analytical height and gradient
// ---------------------------------------------------------------------------
float heightAt(vec2 xz, float t, Wave W[NUM_WAVES]){
    float y=0.0;
    for (int i=0; i<NUM_WAVES; ++i){
        Wave w=W[i];
        float th = dot(w.dir, xz)*w.k - w.w*t*waveSpeed + w.phase;
        y += w.amp * sin(th);
    }
    return y;
}

vec2 heightGrad(vec2 xz, float t, Wave W[NUM_WAVES]){
    vec2 g=vec2(0.0);
    for (int i=0; i<NUM_WAVES; ++i){
        Wave w=W[i];
        float th = dot(w.dir, xz)*w.k - w.w*t*waveSpeed + w.phase;
        g += w.amp * w.k * w.dir * cos(th);
    }
    return g;
}

// ---------------------------------------------------------------------------
// Vertex main
// ---------------------------------------------------------------------------
void main(){
    Wave W[NUM_WAVES];
    initWaves(W, time);

    vec3 pos = position;

    // Skip deep skirt vertices (below edgeDepth)
    if (pos.y > -1500.0) {
        float y = heightAt(pos.xz, time, W);
        pos.y = y;
    }

    vec2 grad = heightGrad(pos.xz, time, W);

    // Apply horizontal choppiness (Gerstner-style)
    pos.xz += grad * (choppiness * 0.3);

    // Normal
    vec3 n = normalize(vec3(-grad.x * choppiness, 1.0, -grad.y * choppiness));

    // Foam crest proxy
    float slope = length(grad);
    vCrest = smoothstep(0.8, 1.6, slope);

    // World transforms
    vec4 worldPos = world * vec4(pos, 1.0);
    vPositionW = worldPos.xyz;
    vNormalW = normalize((world * vec4(n, 0.0)).xyz);
    vPosVS = (worldView * vec4(pos, 1.0)).xyz;
    vClipSpace = worldViewProjection * vec4(pos, 1.0);
    gl_Position = vClipSpace;
}

`;

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
uniform vec4  sceneColor;
uniform float exposure;
uniform float foamStrength;
uniform float foamThreshold;
uniform float foamFalloff;
uniform float foamShallowBoost;
uniform float foamNoiseScale;


// --- helpers ---------------------------------------------------
float noise(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float n=dot(i, vec3(1.0,57.0,113.0));
  float n000=fract(sin(n+0.0)*43758.5453);
  float n100=fract(sin(n+1.0)*43758.5453);
  float n010=fract(sin(n+57.0)*43758.5453);
  float n110=fract(sin(n+58.0)*43758.5453);
  float n001=fract(sin(n+113.0)*43758.5453);
  float n101=fract(sin(n+114.0)*43758.5453);
  float n011=fract(sin(n+170.0)*43758.5453);
  float n111=fract(sin(n+171.0)*43758.5453);
  float nx00=mix(n000,n100,f.x);
  float nx10=mix(n010,n110,f.x);
  float nx01=mix(n001,n101,f.x);
  float nx11=mix(n011,n111,f.x);
  float nxy0=mix(nx00,nx10,f.y);
  float nxy1=mix(nx01,nx11,f.y);
  return mix(nxy0,nxy1,f.z);
}

// Reuse the SAME noise() function already declared above.
// Build a small fbm from that for a more pleasant basis.
float fbm(vec3 p){
  float a = 0.5;
  float s = 0.0;
  s += a * noise(p);         p *= 2.01; a *= 0.5;
  s += a * noise(p);         p *= 2.01; a *= 0.5;
  s += a * noise(p);
  return s;
}


float fresnelSchlick(float cosTheta, float F0){
  return F0 + (1.0 - F0)*pow(1.0 - cosTheta, 5.0);
}

// Henyey–Greenstein-ish forward phase (g≈0.6)
float phaseHG(float mu){
  float g = 0.6;
  float gg = g*g;
  return (1.0 - gg) / (4.0 * 3.14159 * pow(1.0 + gg - 2.0*g*mu, 1.5));
}

void main(void){
  // Screen coords + ripple (use 2D distortion; this is important)
  vec2 ndc = (vClipSpace.xy / vClipSpace.w) * 0.5 + 0.5;
  float ripple = noise(vec3(vPositionW.xz * wNoiseScale * 1.8, time * 1.3)) * wNoiseOffset;
  vec2 distort = ripple * vec2(6.0, 4.0);     // <<< 2D offset like the working version

  // WORKING FOAM BASIS: compare scene depth vs current surface depth in the SAME space
  float depthBehind = texture2D(depthTex, ndc + distort).r; // sample with 2D offset

  // "Surface depth" in the same normalized space the working shader used
  float surfaceDepth = (vClipSpace.z + camMinZ) / (camMaxZ + camMinZ);

  // Positive when terrain is behind the water surface (shallows → small positive)
  float depthDelta = depthBehind - surfaceDepth;

  // Normalize to 0..1 range using your artistic 'maxDepth' in meters
  // (the original scaled by camMaxZ before dividing; we mimic that)
  float wdepth = clamp((camMaxZ * depthDelta) / maxDepth, 0.0, 1.0);

  // *** BUGFIX #1: Work consistently in WORLD space ***
  vec3 N  = normalize(vNormalW);
  vec3 Vw = normalize(cameraPosition - vPositionW); // view dir (toward camera) in world space
if ((cameraPosition.y + 0.02) < vPositionW.y) Vw = -Vw; // flip when under water

  // Robust "are we underwater?" test (don’t rely on gl_FrontFacing)
  bool isUnder = !gl_FrontFacing;

  // IOR & Fresnel
  float n1 = isUnder ? iorWater : iorAir;
  float n2 = isUnder ? iorAir   : iorWater;
  float eta = n1 / n2;
  float cosI = clamp(dot(N, Vw), 0.0, 1.0);
  float F0 = pow((n1 - n2) / (n1 + n2), 2.0);
  float Fr = fresnelSchlick(cosI, F0);

  // Reflect / Refract in WORLD space against WORLD normal
  vec3 T = refract(-Vw, N, eta);
  vec3 R = reflect(-Vw,  N);

  bool TIR = all(lessThan(abs(T), vec3(1e-6)));
  if (TIR) Fr = 1.0;

  // UV offsets in screen space (heuristic)
  vec2 refrUV = ndc + refrScale * (T.xy) + ripple * 0.6;
  vec2 reflUV = ndc + reflScale * (R.xy) - ripple * 0.6;
  if (isUnder) {
    // already flipped view vector, so use same sign as above
    refrUV = ndc + refrScale * (T.xy) + ripple * 0.6;
}

  // *** BUGFIX #2: DO NOT CLAMP UVs ***
  // (RTTs are in mirror address mode; clamping forces grey edge samples.)

  // RTT fetches
  vec3 refrColor = texture2D(refractionSampler, refrUV).rgb;
  vec3 reflColor = texture2D(reflectionSampler,  reflUV).rgb;

  // Sky model / env color
  vec3 env = sceneColor.rgb * exposure;

  // *** BUGFIX #3: If env is too desaturated or too dark, fall back to a blue sky ***
  float envLum = max(0.0001, dot(env, vec3(0.2126,0.7152,0.0722)));
  vec3 envNorm = env / envLum;
  float envMax = max(max(envNorm.r, envNorm.g), envNorm.b);
  float envMin = min(min(envNorm.r, envNorm.g), envNorm.b);
  float envSat = (envMax - envMin) / max(envMax, 1e-3);
  vec3 fallbackSky = vec3(0.18, 0.36, 0.85); // pleasant sky blue
  vec3 envSafe = mix(fallbackSky, env, clamp(envSat * envLum * 3.0, 0.0, 1.0));

  vec3 skyZenith  = envSafe * 0.85;
  vec3 skyHorizon = envSafe * 0.95;

  vec3 up = vec3(0.0, 1.0, 0.0);
  float horizonBlend = smoothstep(0.45, 0.85, 1.0 - abs(dot(Vw, up)));
  horizonBlend = mix(0.35, 0.65, horizonBlend);
  vec3 skyColor = mix(skyZenith, skyHorizon, horizonBlend);

 // === Foam (driven by wave motion + shallow depth) ===

// Advect foam using the same Gerstner-like motion basis
// This matches how waves actually move horizontally
vec2 foamFlow = vec2(
    sin(vPositionW.x * 0.05 + time * 0.6),
    cos(vPositionW.z * 0.05 + time * 0.6)
);

// Build coherent fbm noise basis
float foamPhase = fbm(vec3(vPositionW.xz * foamNoiseScale * 0.5 + foamFlow, time * 0.4));

// Combine depth-based foam (shore) and crest-based foam (vCrest)
float shallowFoam = smoothstep(0.05, 0.25, 1.0 - wdepth);
float crestFoam   = pow(vCrest, 1.2); // sharper crests

// Merge them and modulate by evolving noise pattern
float foamCombined = mix(shallowFoam, crestFoam, 0.5);
float foamMask = clamp(foamCombined * foamPhase * foamStrength, 0.0, 1.0);




  // =========================
  //       ABOVE WATER
  // =========================
  if (!isUnder) {
    vec3 deepCol = mix(wDeepColor.rgb, wShallowColor.rgb, 0.3);
    float roughness = 0.15;
    Fr *= mix(1.0, 0.75, roughness);

    vec3 absorbA = vec3(0.08, 0.045, 0.02) / clamp(envLum * 1.3, 0.3, 1.3);
    vec3 trans   = exp(-absorbA * (4.0 * clamp(wdepth + 0.15, 0.0, 1.0)));
    vec3 transCol = deepCol * trans;

    vec3 fresnelMix = mix(transCol, reflColor, Fr * 0.85);
    if (TIR) fresnelMix = mix(fresnelMix, reflColor, 0.6);
    // Final mix (slightly boosted for visibility)
vec3 withFoam = mix(fresnelMix, wFoamColor.rgb, foamMask * 0.8);


    float airFade = smoothstep(0.0, 1.0, horizonBlend);
    vec3 airMix = mix(withFoam, skyColor, airFade * 0.12);
    float fog = exp(-pow(horizonBlend * 1.3, 2.0));
    gl_FragColor = vec4(mix(skyColor, airMix, fog), 0.9);
    return;
  }



// =========================
//       UNDER WATER
// =========================

// =========================
//       UNDER WATER
// =========================

// Physical model: air-light through Snell's window + single scattering + extinction.
float d = distance(cameraPosition, vPositionW);

// --- Improved Snell’s window brightness model ---

// Spectral coefficients (tuned for clearer, brighter near-surface light)
vec3 sigma_a = vec3(0.06, 0.035, 0.015);  // absorption (reds fade faster)
vec3 sigma_s = vec3(0.015, 0.025, 0.040); // scattering (more blue scatter)
vec3 sigma_t = sigma_a + sigma_s;

// Softer attenuation curve to prevent overly dark appearance
float attenuation = clamp(exp(-0.25 * d), 0.35, 1.0);

// Compute Snell’s window angle weight
float mu = clamp(dot(Vw, up), 0.0, 1.0);
float snellWindow = smoothstep(0.30, 0.96, mu);

// Approximate refraction mix underwater
 refrUV = ndc + refrScale * (-T.xy) + ripple * 0.8;
 refrColor = texture2D(refractionSampler, refrUV).rgb;
 reflColor = texture2D(reflectionSampler, ndc).rgb;
vec3 skyTint = mix(refrColor, reflColor, 0.4);

// Brighten inside Snell’s cone for realistic luminous window
vec3 L_window = skyTint * (1.3 + 0.7 * snellWindow);

// Single forward scattering contribution
float phase = phaseHG(mu);
vec3 waterHue = normalize(vec3(0.05, 0.25, 0.55) + wShallowColor.rgb * 0.3);
vec3 L_scatter = waterHue * phase * 0.8 * (1.0 - attenuation);

// Subtle Fresnel reflection from below (rim highlight)
vec3 L_surface = reflColor * (Fr * 0.3) * snellWindow;

// Combine all contributions
vec3 color = L_window * attenuation + L_scatter + L_surface;

// Extra boost at the center of Snell’s window (direct skylight through surface)
float windowLift = smoothstep(0.6, 1.0, mu);
color += vec3(0.25, 0.3, 0.35) * windowLift;

// Add mild distance haze for depth perception
float farHaze = clamp(d / (camMaxZ * 0.6), 0.0, 1.0);
vec3 hazeTint = waterHue * 0.25;
color = mix(color, hazeTint, farHaze * 0.35);

// Gentle gamma lift for perceptual brightness
color = pow(color, vec3(0.9));

// Final output
gl_FragColor = vec4(clamp(color, 0.0, 1.0), 0.9);




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
