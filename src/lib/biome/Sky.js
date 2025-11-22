import {
  Color3,
  Color4,
  Effect,
  GPUParticleSystem,
  Mesh,
  ShaderMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";

export class Sky {
  constructor(scene, options) {
    // 🌌 Create the gradient sky sphere
    const skybox = Mesh.CreateSphere("skyBox", 10.0, 800, scene);

    Effect.ShadersStore.gradientVertexShader = `
      precision mediump float;
      attribute vec3 position;
      attribute vec3 normal;
      attribute vec2 uv;
      uniform mat4 worldViewProjection;
      varying vec4 vPosition;
      varying vec3 vNormal;
      void main(){
          vec4 p = vec4(position,1.0);
          vPosition = p;
          vNormal = normal;
          gl_Position = worldViewProjection * p;
      }`;

    Effect.ShadersStore.gradientPixelShader = `
      precision mediump float;
      uniform mat4 worldView;
      varying vec4 vPosition;
      varying vec3 vNormal;
      uniform float offset;
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      void main(void){
          float h = normalize(vPosition + offset).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), 0.6), 0.0)), 1.0);
      }`;

    const skyGradient = new ShaderMaterial("gradient", scene, "gradient", {});
    skyGradient.setFloat("offset", 10);
    skyGradient.setColor3("topColor", Color3.FromInts(54, 93, 162));
    skyGradient.setColor3("bottomColor", Color3.FromInts(123, 173, 233));
    skyGradient.backFaceCulling = false;
    skybox.material = skyGradient;

    // 🌥️ 4K cloud textures
    const cloudImages = ["76.png", "77.png", "78.png", "79.png", "85.png", "86.png", "87.png"];
    const basePath = "/yeehdoh/images/clouds/";

    // Invisible emitter placeholder
    const emitter = Mesh.CreateBox("cloudEmitter", 0.01, scene);
    emitter.visibility = 0;

    // ☁️ Create one GPU particle system per texture
    cloudImages.forEach((img) => {
      const texture = new Texture(new URL(`${basePath}${img}`, window.location.href).href, scene);
      const sys = new GPUParticleSystem(`clouds_${img}`, { capacity: 50000 }, scene);

      // Attach emitter
      sys.emitter = emitter;

      // Use this cloud texture
      sys.particleTexture = texture.clone();

      // Color + transparency like fog/smoke demo
      sys.color1 = new Color4(0.8, 0.8, 0.8, 0.1);
      sys.color2 = new Color4(0.95, 0.95, 0.95, 0.15);
      sys.colorDead = new Color4(0.9, 0.9, 0.9, 0.1);

      // Cloud size
      sys.minSize = 25.5;
      sys.maxSize = 200.0;

      // Static lifetime
      sys.minLifeTime = Number.MAX_SAFE_INTEGER;
      sys.maxLifeTime = Number.MAX_SAFE_INTEGER;

      // Emit all at once — already distributed
      sys.manualEmitCount = 200;
      sys.activeParticleCount = sys.manualEmitCount;

      // Wide sky box distribution
      sys.minEmitBox = new Vector3(-300, 120, -5300);
      sys.maxEmitBox = new Vector3(300, 200, 300);

      // Soft blending
      sys.blendMode = GPUParticleSystem.BLENDMODE_STANDARD;
      sys.gravity = Vector3.Zero();

      // Minimal angular rotation and slow drift
      sys.minAngularSpeed = -0.01;
      sys.maxAngularSpeed = 0.1;
      sys.minEmitPower = 0.5;
      sys.maxEmitPower = 1.0;

      // Almost static speed
      sys.updateSpeed = 0.005;

      // Randomize initial direction slightly (almost flat)
      sys.direction1 = new Vector3(-0.01, 0, -0.01);
      sys.direction2 = new Vector3(0.01, 0.01, 0.01);

      // Start immediately
      sys.start();
    });
  }
}
