<template>
  <div v-if="visible" class="splash-screen" @click="handleClick">
    <img class="splash-logo" src="@/assets/logo.png" alt="Yeeh Doh!!" />
    <div class="hint">click to enter paradise</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import * as Tone from "tone";
import { playYeehDohThemeHuman } from "@/lib/theme";

const visible = ref(true);
let ambientAudio = null;
let started = false;

onMounted(() => {
  ambientAudio = new Audio(
    "https://sound-effects-media.bbcrewind.co.uk/mp3/NHU05080068.mp3?download&rename=BBC_Waves---Wa_NHU0508006"
  );
  ambientAudio.loop = true;
  ambientAudio.volume = 0;
});

async function startMusic() {
  if (started) return;
  started = true;

  try {
    await Tone.start();
    await playYeehDohThemeHuman();

    ambientAudio.play().then(() => {
      try {
        ambientAudio.currentTime = 3;
      } catch {}
      let v = 0;
      const fade = setInterval(() => {
        v += 0.03;
        ambientAudio.volume = Math.min(v, 0.35);
        if (v >= 0.35) clearInterval(fade);
      }, 80);
    });
  } catch (err) {
    console.warn("Audio start failed:", err);
  }
}

function handleClick() {
  startMusic();
  const el = document.querySelector(".splash-screen");
  el.classList.add("exit");

  // tell Babylon camera to zoom in
  window.dispatchEvent(new CustomEvent("YEEHDOH_START"));

  // remove splash after motion completes
  setTimeout(() => (visible.value = false), 1000);
}
</script>

<style scoped>
.splash-screen {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, #b6efe8 0%, #81d8cf 70%, #5ac3c0 100%);
  cursor: pointer;
  z-index: 10;
  animation: subtle-pulse 4s ease-in-out infinite;
  overflow: hidden;
  perspective: 1200px;
  transition: background-color 1s ease;
}

.splash-logo {
  width: 55%;
  max-width: 600px;
  transform: translateZ(0) scale(1);
  filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.6))
          drop-shadow(0 0 20px rgba(0, 0, 0, 0.4));
}

/* Hint text */
.hint {
  margin-top: 1.5rem;
  font-size: 1rem;
  color: rgba(255, 255, 255, 0.85);
  letter-spacing: 1px;
  text-transform: uppercase;
  animation: hintPulse 2s ease-in-out infinite;
}

@keyframes hintPulse {
  0%, 100% { opacity: 0.8; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-3px); }
}

/* 🎥 Logo zooms toward camera, background fades transparent */
.splash-screen.exit {
  animation: bgFade 2.2s ease forwards;
}

.splash-screen.exit .splash-logo {
  animation: logoZoomForward 2.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes logoZoomForward {
  0% {
    transform: translateZ(0) scale(1);
    filter: brightness(1.1) blur(0px);
  }
  40% {
    transform: translateZ(150px) scale(1.6);
    filter: brightness(1.4) blur(2px);
  }
  100% {
    transform: translateZ(600px) scale(3.5);
    filter: brightness(1.2) blur(8px);
    opacity: 0;
  }
}

@keyframes bgFade {
  0% { background: linear-gradient(180deg, #b6efe8 0%, #81d8cf 70%, #5ac3c0 100%); }
  60% { background: rgba(150, 230, 220, 0.2); }
  100% { background: rgba(0, 0, 0, 0); }
}

/* gentle background pulse while idle */
@keyframes subtle-pulse {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.05); }
}
</style>
