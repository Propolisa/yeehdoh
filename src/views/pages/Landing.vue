<template>
    <div class="fullscreen-scene">
        <!-- Game Canvas (always visible behind the splash) -->
        <canvas ref="canvas" class="game-canvas"></canvas>

        <!-- Splash overlay (fades out on click) -->
        <SplashScreen v-if="showSplash" @done="showSplash = false" />

        <!-- Info toggle button -->
        <button class="credit-toggle" @click="showCredits = !showCredits">
            {{ showCredits ? '✕' : 'ℹ︎' }}
        </button>

        <!-- Credits box -->
        <div class="credit-box" v-if="showCredits">
            <h4>Credits</h4>
            <p>
                Thanks to:<br />
                <strong>@inteja</strong> — vertex sway concept<br />
                <strong>@phaselock</strong> — water shader<br />
                <strong>@Nevergrind</strong> — modified wave shader
            </p>
        </div>
    </div>
</template>
<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
// Babylon core + loaders
import { Engine } from '@babylonjs/core';
// register the GLTF loader plugin
import SplashScreen from '@/components/SplashScreen.vue';
import '@babylonjs/core/Debug/debugLayer';
import '@babylonjs/core/Legacy/legacy';
import '@babylonjs/inspector';
import '@babylonjs/loaders/glTF';
import { setupDebugTrigger } from '../../lib/babylon_functions.js';
import { createScene } from '../../lib/sceneSetup.js';

const showSplash = ref(false);
setTimeout(() => (showSplash.value = false), 5000);
const canvas = ref(null);
const showCredits = ref(false);
let engine, scene;
let animGroups = [];
let currentAnim = 0;
let handleKeydown; // reference to the listener for cleanup
onMounted(async () => {
    // give Vue a tick so canvas.value exists
    await new Promise((r) => setTimeout(r, 0));

    // inside onMounted:
    engine = new Engine(canvas.value, true);
    engine.setHardwareScalingLevel(1 / window.devicePixelRatio); // ✅ High-DPI fix
    let scene = await createScene(engine, canvas.value);
    setupDebugTrigger(scene);

    engine.runRenderLoop(() => scene.render());
    window.addEventListener('resize', () => engine.resize());

    // ensure resize after splash disappears
    watch(showSplash, (v) => {
        if (!v && engine) setTimeout(() => engine.resize(), 100);
    });
});

onBeforeUnmount(() => {
    if (handleKeydown) {
        window.removeEventListener('keydown', handleKeydown);
    }
    if (engine) {
        engine.stopRenderLoop();
        engine.dispose();
    }
});
</script>

<style>
html,
body,
#app,
.fullscreen-scene,
canvas {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    display: block;
    overflow: hidden;
}

/* toggle button */
.credit-toggle {
    position: absolute;
    bottom: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    border: none;
    border-radius: 50%;
    width: 36px;
    height: 36px;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
}

/* info box */
.credit-box {
    position: absolute;
    bottom: 0;
    right: 0;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    padding: 12px;
    max-width: 220px;
    font-size: 13px;
}

.credit-box h4 {
    margin: 0 0 6px;
    font-size: 15px;
}

.credit-box a {
    color: #4faaff;
    text-decoration: underline;
}
</style>
