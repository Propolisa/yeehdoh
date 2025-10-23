

  // ======================================================
  // 🧮 GEOMETRY HELPERS

import { Curve3, Matrix, Mesh, MeshBuilder, Quaternion, Vector3, VertexData } from "@babylonjs/core";

  // ======================================================
export function makeMeshFromData(name, verts, idx, scene, mat) {
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = verts;
    vd.indices = idx;
    const normals = [];
    VertexData.ComputeNormals(verts, idx, normals);
    vd.normals = normals;
    vd.applyToMesh(mesh);
    if (mat) mesh.material = mat;
    return mesh;
  }


// ======================================================
// 🪨 Low-poly Icosphere-based rock generator
//     - Convex hull base, nuggety crags, soft concavity
//     - Safe winding + flat shading
// ======================================================
export function emitRockIco(scene, mat, opts = {}) {
  const {
    radius = 1.0,
    roughness = 0.25,     // random nuggetiness (0..~0.4)
    cragginess = 0.25,    // anisotropy
    dentStrength = 0.12,  // concavity strength (0..~0.2)
    dentSpread = 0.9,     // concavity falloff width (0.5..1.2)
    flattenY = 0.18,      // vertical flattening
    flatShaded = true,
    tint = null           // optional vertex tint
  } = opts;

  // ---- Icosahedron base vertices ----
  const PHI = (1 + Math.sqrt(5)) / 2;
  const verts = [
    new Vector3(-1,  PHI, 0),
    new Vector3( 1,  PHI, 0),
    new Vector3(-1, -PHI, 0),
    new Vector3( 1, -PHI, 0),
    new Vector3(0, -1,  PHI),
    new Vector3(0,  1,  PHI),
    new Vector3(0, -1, -PHI),
    new Vector3(0,  1, -PHI),
    new Vector3( PHI, 0, -1),
    new Vector3( PHI, 0,  1),
    new Vector3(-PHI, 0, -1),
    new Vector3(-PHI, 0,  1)
  ];
  for (let i = 0; i < verts.length; i++) verts[i] = verts[i].normalize().scale(radius);

  // ---- 20 face indices ----
  const faces = [
    [0, 11, 5],  [0, 5, 1],   [0, 1, 7],   [0, 7, 10],  [0, 10, 11],
    [1, 5, 9],   [5, 11, 4],  [11, 10, 2], [10, 7, 6],  [7, 1, 8],
    [3, 9, 4],   [3, 4, 2],   [3, 2, 6],   [3, 6, 8],   [3, 8, 9],
    [4, 9, 5],   [2, 4, 11],  [6, 2, 10],  [8, 6, 7],   [9, 8, 1]
  ];

  // ---- Randomized deformation directions ----
  const randDir = () => {
    const a = Math.random() * Math.PI * 2;
    const z = Math.random() * 2 - 1;
    const r = Math.sqrt(1 - z * z);
    return new Vector3(Math.cos(a) * r, z, Math.sin(a) * r);
  };
  const dentDir = randDir().normalize();
  const anisoDir = randDir().normalize();

  // ---- Vertex deformation ----
  for (let i = 0; i < verts.length; i++) {
    const dir = verts[i].normalize();

    const nugget = 1 + (Math.random() - 0.5) * roughness;
    const aniso = 1 + (Math.abs(Vector3.Dot(dir, anisoDir)) - 0.5) * (cragginess * 2);

    // concave dent
    const d = Vector3.Dot(dir, dentDir);
    const falloff = Math.pow((1 - Math.max(0, d)) * 0.5 * (1 + dentSpread), 1.25);
    const dent = 1 - dentStrength * falloff;

    const flat = 1 - flattenY * Math.pow(Math.abs(dir.y), 1.5);

    const scale = Math.max(0.4, nugget * aniso * dent * flat);
    verts[i] = dir.scale(radius * scale);
  }

  // ---- Build vertex arrays ----
  const positions = [];
  const indices = [];

  for (const f of faces) {
    const a = verts[f[0]], b = verts[f[1]], c = verts[f[2]];
    const n = Vector3.Cross(c.subtract(a), b.subtract(a)).normalize();
    const center = a.add(b).add(c).scale(1 / 3);

    // Flip inward faces
    const flip = Vector3.Dot(n, center) < 0;
    const i0 = f[0], i1 = flip ? f[2] : f[1], i2 = flip ? f[1] : f[2];

    const base = positions.length / 3;
    const p0 = verts[i0], p1 = verts[i1], p2 = verts[i2];

    positions.push(
      p0.x, p0.y, p0.z,
      p1.x, p1.y, p1.z,
      p2.x, p2.y, p2.z
    );
    indices.push(base, base + 1, base + 2);
  }

  // ---- Build mesh ----
  const mesh = new Mesh("rockIco", scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  const normals = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vd.normals = normals;
  vd.applyToMesh(mesh);

  // ---- Optional vertex tint ----
  if (tint) {
    const colors = new Array((positions.length / 3) * 4);
    for (let i = 0; i < colors.length; i += 4) {
      colors[i] = tint.r;
      colors[i + 1] = tint.g;
      colors[i + 2] = tint.b;
      colors[i + 3] = tint.a;
    }
    mesh.setVerticesData("color", colors, true);
  }

  if (mat) mesh.material = mat;
  if (flatShaded) mesh.convertToFlatShadedMesh();

  return mesh;
}

// Drop-in replacement
export function makePalmFrond(scene, mat, opts = {}) {
  const {
    // original knobs
    length = 3.5,
    pinnae = 24,
    maxWidth = 0.55,
    droop = 0.8,
    bendForward = 0.4,
    shapePower = 1.8,
    droopAngle = 0.6,
    randomness = 0.2,
    tearChance = 0.15,
    tearDepth = 0.5,

    // NEW: variety & environment (all optional; safe defaults)
    frondType = "auto",        // "auto" | "coconut" | "date" | "fan" | "windswept"
    altitude = 0.3,            // 0 lowlands (lush), 1 highlands (arid/conservative)
    sideBend = null,           // override lateral bend (null = auto by type/altitude)
    twist = null,              // total twist along rachis in radians (null = auto)
    archBias = 0.0,            // -1..+1 bias arching earlier/later along length
    gapChance = 0.08,          // occasional pinna “gap” (no width)
    tipSplitChance = 0.12,     // ragged/split tip feel
    widthProfile = "elliptic", // "elliptic" | "tri" | "diamond"
    seed = undefined           // deterministic seed (number) or undefined
  } = opts;

  // --- tiny seeded RNG (deterministic if seed provided) ---
  let _s = (typeof seed === "number")
    ? (seed % 2147483647) : Math.floor(Math.random() * 1e9) % 2147483647;
  if (_s <= 0) _s += 2147483646;
  const rand = () => (_s = (_s * 16807) % 2147483647) / 2147483647;
  const rRange = (a, b) => a + (b - a) * rand();
  const rSign = () => (rand() < 0.5 ? -1 : 1);

  // --- type presets (light touch, everything is still continuous) ---
  const altF = Math.max(0, Math.min(1, altitude));
  let L = length, W = maxWidth, D = droop, BF = bendForward, dAngle = droopAngle;
  let side = (sideBend == null) ? rRange(-0.25, 0.25) * (1 - altF) : sideBend; // less lateral at high altitude
  let twistTotal = (twist == null) ? rRange(0.15, 0.7) * (1 - 0.5 * altF) * rSign() : twist;

  if (frondType === "coconut" || (frondType === "auto" && altF < 0.35)) {
    L *= rRange(1.1, 1.35);
    W *= rRange(0.8, 1.0);
    D *= rRange(1.0, 1.25);
    BF *= rRange(1.0, 1.3);
    dAngle *= rRange(1.0, 1.2);
    twistTotal *= rRange(1.1, 1.3);
  } else if (frondType === "date" || (frondType === "auto" && altF > 0.6)) {
    L *= rRange(0.75, 0.95);
    W *= rRange(1.0, 1.25);
    D *= rRange(0.7, 0.95);
    BF *= rRange(0.8, 1.0);
    dAngle *= rRange(0.8, 1.0);
    twistTotal *= rRange(0.6, 0.9);
    side *= 0.6; // stiffer lateral
  } else if (frondType === "fan") {
    L *= rRange(0.8, 1.0);
    W *= rRange(1.2, 1.5);
    D *= rRange(0.9, 1.2);
    BF *= rRange(0.8, 1.0);
    dAngle *= rRange(0.9, 1.1);
    twistTotal *= 0.5;
  } else if (frondType === "windswept") {
    side += rRange(0.2, 0.5) * rSign();
    twistTotal *= rRange(1.0, 1.4);
    D *= rRange(1.0, 1.2);
  }

  // --- adaptive sampling: fewer points mid-span, more near base/tip (lower poly, same silhouette) ---
  // We “virtually” have `pinnae`, but sample a subset with denser ends.
  const targetPoints = Math.max(8, Math.floor(pinnae * 0.6)); // cut ~40%
  const sampleTs = [];
  for (let i = 0; i < targetPoints; i++) {
    const u = i / (targetPoints - 1);
    // ease-in-out to bunch samples at ends
    const t = u < 0.5 ? 2*u*u : 1 - Math.pow(-2*u + 2, 2) / 2;
    // small arch bias to allow earlier/later expansion along length
    const tb = Math.max(0, Math.min(1, t + archBias * 0.15 * (t - 0.5)));
    sampleTs.push(tb);
  }

  // --- build rachis centerline (forward +Z, sagging −Y, with forward bend & side bend) ---
  const pts = [];
  for (let k = 0; k < sampleTs.length; k++) {
    const t = sampleTs[k];
    const z = t * L;
    const y = -Math.sin(Math.PI * t) * D;
    const x = Math.sin(t * Math.PI) * BF + side * t * L * 0.08; // lateral arc grows with t
    pts.push(new Vector3(x, y, z));
  }

  // --- local frame vars ---
  const globalUp = new Vector3(0, 1, 0);
  let prevSide = new Vector3(1, 0, 0);
  const tmpM = new Matrix();

  const rachisVerts = [], leftVerts = [], rightVerts = [];
  const rachisYs = [], tipsYs = [];

  // width profile function for variety
  const widthAt = (t) => {
    const s = Math.sin(Math.PI * t);
    if (widthProfile === "tri")      return W * Math.max(0, 1 - Math.abs(2*t - 1)); // triangle peak at mid
    if (widthProfile === "diamond")  return W * Math.pow(s, 0.8) * (1 - 0.15 * Math.abs(0.5 - t) * 2);
    // default elliptic/bell
    return W * Math.pow(s, shapePower);
  };

  // compute strips
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const T = p1.subtract(p0).normalize();

    // stable side axis (avoid twist “snap”)
    let sideAxis = Vector3.Cross(globalUp, T);
    if (sideAxis.lengthSquared() < 1e-6) sideAxis = prevSide.clone();
    sideAxis.normalize();

    // progressive twist around T
    const twistHere = twistTotal * (i / (pts.length - 1));
    const qTwist = Quaternion.RotationAxis(T, twistHere);
    const mTwist = new Matrix();
    Matrix.FromQuaternionToRef(qTwist, mTwist);
    sideAxis = Vector3.TransformNormal(sideAxis, mTwist).normalize();

    const up = Vector3.Cross(sideAxis, T).normalize().scale(-1);
    prevSide = sideAxis;

    const t = i / (pts.length - 1);
    // progressive droop angle (more near the tip), with tiny noise
    const localDroop = dAngle * (0.6 + 0.6 * t) * (1 + (rand() - 0.5) * randomness * 0.15);
    const qTilt = Quaternion.RotationAxis(sideAxis, -localDroop);
    Matrix.FromQuaternionToRef(qTilt, tmpM);
    const downDir = Vector3.TransformNormal(up, tmpM);

    // variable width with random micro-variation
    let halfW = widthAt(t) * (0.95 + (rand() - 0.5) * 0.1);

    // occasional pinna gap (visual “missing leaflet”)
    if (rand() < gapChance * (0.4 + 0.6 * t)) {
      halfW *= rRange(0.05, 0.2);
    }

    // ragged/split tip toward end
    const rag = (rand() < tipSplitChance && t > 0.65) ? rRange(0.7, 0.95) : 1;

    rachisVerts.push(p0);
    rachisYs.push(p0.y);

    // richer tear model: depth varies per side & increases toward tip
    const tearWeight = (t*t); // more likely & deeper further out
    const lTear = (rand() < tearChance * (0.5 + 0.8 * tearWeight)) ? (1 - tearDepth * rRange(0.6, 1.0)) : (1 - rand() * 0.2);
    const rTear = (rand() < tearChance * (0.5 + 0.8 * tearWeight)) ? (1 - tearDepth * rRange(0.6, 1.0)) : (1 - rand() * 0.2);

    const lateralNoise = (rand() - 0.5) * 0.06 * (1 - t); // micro feathering near base

    const leftTip = p0
      .add(sideAxis.scale(-(halfW * lTear * rag) + lateralNoise))
      .add(downDir.scale(halfW * 0.45 * (1 + (rand() - 0.5) * 0.1)));

    const rightTip = p0
      .add(sideAxis.scale((halfW * rTear * rag) + lateralNoise))
      .add(downDir.scale(halfW * 0.45 * (1 + (rand() - 0.5) * 0.1)));

    leftVerts.push(leftTip);
    rightVerts.push(rightTip);
    tipsYs.push((leftTip.y + rightTip.y) * 0.5);
  }

  // --- geometry strips (same pattern, fewer samples) ---
  const verts = [];
  const idx = [];
  function addStrip(a, b) {
    for (let i = 0; i < a.length - 1; i++) {
      const a0 = a[i], a1 = a[i + 1];
      const b0 = b[i], b1 = b[i + 1];
      const base = verts.length / 3;
      verts.push(
        a0.x, a0.y, a0.z,
        b0.x, b0.y, b0.z,
        a1.x, a1.y, a1.z,
        b1.x, b1.y, b1.z
      );
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  addStrip(rachisVerts, leftVerts);
  addStrip(rachisVerts, rightVerts);

  // --- auto-flip safety (unchanged) ---
  const avgR = rachisYs.reduce((a, b) => a + b, 0) / rachisYs.length;
  const avgT = tipsYs.reduce((a, b) => a + b, 0) / tipsYs.length;
  if (avgT > avgR) {
    const pivot = rachisVerts[0];
    const qFlip = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI);
    const mFlip = new Matrix();
    Matrix.FromQuaternionToRef(qFlip, mFlip);
    for (let i = 0; i < verts.length; i += 3) {
      const v = new Vector3(
        verts[i] - pivot.x,
        verts[i + 1] - pivot.y,
        verts[i + 2] - pivot.z
      );
      const vf = Vector3.TransformCoordinates(v, mFlip);
      verts[i] = vf.x + pivot.x;
      verts[i + 1] = vf.y + pivot.y;
      verts[i + 2] = vf.z + pivot.z;
    }
  }

  // --- normals & mesh (same pipeline) ---
  const mesh = new Mesh("palmFrond_diverse_lowpoly", scene);
  const vd = new VertexData();
  vd.positions = verts;
  vd.indices = idx;
  const normals = [];
  VertexData.ComputeNormals(verts, idx, normals);
  vd.normals = normals;
  vd.applyToMesh(mesh);
  if (mat) mesh.material = mat;

  return mesh;
}





export function latheProfile(profile, segments = 8, jitter = 0.0) {
    const verts = [], idx = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let j = 0; j < profile.length; j++) {
        const [x, y] = profile[j];
        const dx = (Math.random()-0.5)*jitter;
        const dz = (Math.random()-0.5)*jitter;
        verts.push(x*ca + dx, y, x*sa + dz);
      }
    }
    const stride = profile.length;
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < stride - 1; j++) {
        const a = i*stride + j;
        const b = a + stride;
        idx.push(a,b,a+1, b,a+1,b+1);
      }
    }
    return {verts, idx};
  }

  // ======================================================
  // 🌿 EMITTERS
  // ======================================================
export function emitNeedleCard(scene, mat, length = 1.0, width = 0.4) {
  // just two crossed quads
  const verts = [
    -width, 0, 0,   width, 0, 0,   width, 0, length,   -width, 0, length,
    0, -width, 0,   0, width, 0,   0, width, length,   0, -width, length,
  ];
  const idx = [
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
  ];
  const mesh = makeMeshFromData("needleCard", verts, idx, scene, mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}


export function emitPinecone(scene, mat, options={}) {
    const {height=0.4, radius=0.15, scales=6, jitter=0.02} = options;
    const verts=[], idx=[];
    const steps=scales, segs=6;
    for(let i=0;i<=steps;i++){
      const t=i/steps;
      const y=height*(t-0.5);
      const r=radius*(1-0.5*t*t);
      const twist=t*Math.PI*2*1.5;
      for(let s=0;s<segs;s++){
        const ang=(s/segs)*Math.PI*2+twist;
        const x=r*Math.cos(ang)+(Math.random()-0.5)*jitter;
        const z=r*Math.sin(ang)+(Math.random()-0.5)*jitter;
        verts.push(x,y,z);
      }
    }
    for(let i=0;i<steps;i++){
      for(let s=0;s<segs;s++){
        const a=i*segs+s;
        const b=i*segs+((s+1)%segs);
        const c=(i+1)*segs+s;
        const d=(i+1)*segs+((s+1)%segs);
        idx.push(a,b,c,b,d,c);
      }
    }
    return makeMeshFromData("pinecone",verts,idx,scene,mat);
  }

export function emitPetal(scene, mat, length=0.25, width=0.12, curvature=0.6, jitter=0.01){
    const steps=6, profile=[];
    for(let i=0;i<=steps;i++){
      const t=i/steps;
      const x=width*Math.sin(Math.PI*t)*(1-t*0.2);
      const y=length*(t*t)*(1+curvature*0.3);
      profile.push([x,y]);
    }
    const {verts, idx}=latheProfile(profile,5,jitter);
    const mesh=makeMeshFromData("petal",verts,idx,scene,mat);
    mesh.rotation.x=-Math.PI/2;
    return mesh;
  }

export function emitLeaf(scene, mat, length=0.4, width=0.15){
    const steps=5, verts=[], idx=[];
    for(let i=0;i<=steps;i++){
      const t=i/steps;
      const y=t*length;
      const w=Math.sin(t*Math.PI)*width*(0.8+Math.random()*0.2);
      verts.push(-w,0,y);
      verts.push(w,0,y);
    }
    for(let i=0;i<steps;i++){
      const a=i*2,b=a+2;
      idx.push(a,a+1,b,b,b+1,a+1);
    }
    const mesh=makeMeshFromData("leaf",verts,idx,scene,mat);
    mesh.rotation.x=-Math.PI/2;
    return mesh;
  }

export function emitFrond(scene, mat, options={}) {
    const {length=3,width=0.25,archUp=1.2,droop=1.0,segments=3}=options;
    const p0=new Vector3(0,0,0);
    const p1=new Vector3(0,archUp,length*0.4);
    const p2=new Vector3(0,-droop,length);
    const curve=Curve3.CreateQuadraticBezier(p0,p1,p2,segments);
    const pts=curve.getPoints();
    const verts=[], idx=[];
    for(let i=0;i<pts.length;i++){
      const t=i/(pts.length-1);
      const w=width*(1.0-t*0.7);
      verts.push(-w,pts[i].y,pts[i].z,w,pts[i].y,pts[i].z);
    }
    for(let i=0;i<pts.length-1;i++){
      const a=i*2;
      idx.push(a,a+1,a+2,a+1,a+3,a+2);
    }
    return makeMeshFromData("frond",verts,idx,scene,mat);
  }

export function emitFruit(scene, mat, r=0.15){
    const profile=[], steps=5;
    for(let i=0;i<=steps;i++){
      const t=i/steps;
      const y=r*(t-0.5)*2;
      const x=Math.sqrt(Math.max(0,r*r-y*y))*(0.9+Math.random()*0.2);
      profile.push([x,y]);
    }
    const {verts,idx}=latheProfile(profile,8,0.01);
    return makeMeshFromData("fruit",verts,idx,scene,mat);
  }

export function emitCone(scene, mat, height=0.3, radius=0.12){
    const profile=[[0,0],[radius*0.8,height*0.2],[radius*0.4,height*0.6],[0,height]];
    const {verts, idx}=latheProfile(profile,6,0.02);
    return makeMeshFromData("cone",verts,idx,scene,mat);
  }