// Tiny synthesized sound effects (no audio files needed).
import { storage } from './util.js';

let ctx = null;
const audio = () => {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
};

// Browsers only allow audio after a user gesture; unlock on the first one.
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => audio(), { once: true, capture: true });
}

function tone({ freq, dur = 0.08, type = 'sine', gain = 0.25, at = 0, slide = 0, noise = false }) {
  const a = audio();
  if (!a || !storage.get('sound', true)) return;
  const t0 = a.currentTime + at;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  g.connect(a.destination);
  let src;
  if (noise) {
    const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    src = a.createBufferSource();
    src.buffer = buf;
    const filter = a.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    src.connect(filter);
    filter.connect(g);
  } else {
    src = a.createOscillator();
    src.type = type;
    src.frequency.setValueAtTime(freq, t0);
    if (slide) src.frequency.exponentialRampToValueAtTime(freq * slide, t0 + dur);
    src.connect(g);
  }
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

export const sound = {
  move() {
    tone({ freq: 1800, dur: 0.05, noise: true, gain: 0.6 });
    tone({ freq: 220, dur: 0.06, type: 'triangle', gain: 0.25, slide: 0.6 });
  },
  capture() {
    tone({ freq: 900, dur: 0.09, noise: true, gain: 0.8 });
    tone({ freq: 160, dur: 0.1, type: 'triangle', gain: 0.35, slide: 0.5 });
  },
  check() {
    tone({ freq: 1400, dur: 0.05, noise: true, gain: 0.5 });
    tone({ freq: 660, dur: 0.12, type: 'square', gain: 0.06 });
  },
  notify() {
    tone({ freq: 523, dur: 0.15, type: 'sine', gain: 0.2 });
    tone({ freq: 784, dur: 0.25, type: 'sine', gain: 0.2, at: 0.12 });
  },
  end() {
    tone({ freq: 784, dur: 0.18, type: 'sine', gain: 0.2 });
    tone({ freq: 523, dur: 0.3, type: 'sine', gain: 0.2, at: 0.15 });
  },
  lowTime() {
    tone({ freq: 880, dur: 0.06, type: 'square', gain: 0.05 });
  },
};
