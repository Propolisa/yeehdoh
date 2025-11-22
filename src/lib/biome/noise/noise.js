import FastNoiseLite from "fastnoise-lite";

const noise = new FastNoiseLite();

// --------------------
// Core Noise Settings
// --------------------
noise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
noise.SetSeed(1337);
noise.SetFrequency(0.003);

// --------------------
// Fractal shaping
// --------------------
noise.SetFractalType(FastNoiseLite.FractalType.DomainWarpProgressive);
noise.SetFractalOctaves(12);
noise.SetFractalLacunarity(-0.05);
noise.SetFractalGain(1.0);
noise.SetFractalWeightedStrength(1.54);
noise.SetFractalPingPongStrength(2.0);

// --------------------
// Domain Warp (and its fractal behaviour)
// --------------------
// Uses same _Frequency, _Seed, _Octaves, _Gain, _Lacunarity as above
noise._DomainWarpType = FastNoiseLite.DomainWarpType.OpenSimplex2Reduced;
noise._WarpTransformType3D = FastNoiseLite.TransformType3D.ImproveXYPlanes;
noise._DomainWarpAmp = 196.5;

noise._Octaves = 1;
noise._Lacunarity = 2.04;
noise._Gain = -0.56; // negative gain is unusual but valid in your build


export default noise;
