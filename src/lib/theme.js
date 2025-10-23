import * as Tone from 'tone';

export async function playYeehDohThemeHuman() {
    // === MASTER BUS ===
    const limiter = new Tone.Limiter(-6).toDestination();
    const verb = new Tone.Reverb({ decay: 2.0, wet: 0.2 }).connect(limiter);
    const master = new Tone.Gain(0.9).connect(verb);

    // === MELODY ===
    const steel = new Tone.FMSynth({
        harmonicity: 2,
        modulationIndex: 3.8,
        modulation: { type: 'sine' },
        carrier: { type: 'triangle' },
        envelope: { attack: 0.01, decay: 0.25, sustain: 0.05, release: 0.4 },
        modulationEnvelope: { attack: 0.005, decay: 0.15, sustain: 0 }
    }).chain(new Tone.Filter(400, 'highpass'), new Tone.Gain(0.9), verb);

    // === BASS ===
    const bass = new Tone.PluckSynth({
        attackNoise: 0.75,
        dampening: 2200,
        resonance: 0.9
    }).chain(new Tone.Filter(650, 'lowpass'), new Tone.Compressor({ threshold: -22, ratio: 2.5, attack: 0.004, release: 0.12 }), new Tone.Gain(0.95), master);

    // === DRUMS ===
    const kick = new Tone.MembraneSynth({
        pitchDecay: 0.02,
        octaves: 4,
        envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 }
    }).chain(new Tone.Gain(0.35), master);

    const rim = new Tone.MetalSynth({
        frequency: 2000,
        envelope: { attack: 0.001, decay: 0.1, release: 0.05 },
        resonance: 4000,
        modulationIndex: 2
    }).chain(new Tone.Gain(0.1), master);

    const conga = new Tone.MembraneSynth({
        pitchDecay: 0.004,
        octaves: 3,
        envelope: { attack: 0.001, decay: 0.13, sustain: 0, release: 0.06 }
    }).chain(new Tone.Gain(0.18), master);

    const shaker = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.001, decay: 0.04, sustain: 0 }
    }).chain(new Tone.Gain(0.1), master);

    const chords = [
        ['C4', 'E4', 'G4'],
        ['A3', 'C4', 'E4'],
        ['F3', 'A3', 'C4'],
        ['G3', 'B3', 'D4']
    ];
    const phrases = [
        ['E5', 'G5', 'A5', 'G5', 'E5', 'D5', 'C5', null],
        ['G5', 'A5', 'C6', 'B5', 'A5', 'G5', 'E5', null],
        ['C5', 'E5', 'G5', 'A5', 'G5', 'E5', 'F5', 'E5'],
        ['D5', 'E5', 'G5', 'A5', 'C6', 'B5', 'A5', null]
    ];

    const to = (n, s) => Tone.Frequency(n).transpose(s).toNote();
    const bassPlanForBar = (i) => {
        const [r, , f] = chords[i];
        const root = to(r, -24);
        const fifth = to(f, -24);
        const pickups = ['A2', 'G2', 'A2', 'B2'];
        return { root, fifth, pickup: pickups[i] };
    };

    let step = 0,
        phraseIndex = 0,
        section = 'intro';
    Tone.Transport.scheduleRepeat((time) => {
        const bar = Math.floor(step / 8) % chords.length;
        const phrase = phrases[phraseIndex];
        const note = phrase[step % phrase.length];
        if (note && section !== 'outro') steel.triggerAttackRelease(note, '8n', time, 0.9);
        if (section !== 'outro') {
            const pos = step % 8;
            const { root, fifth, pickup } = bassPlanForBar(bar);
            if (pos === 0) bass.triggerAttackRelease(root, '8n', time);
            if (pos === 4) bass.triggerAttackRelease(fifth, '16n', time);
            if (pos === 7) bass.triggerAttackRelease(pickup, '16n', time);
        }
        if (section !== 'intro') {
            if (step % 8 === 0 || step % 8 === 4) kick.triggerAttackRelease('C2', '8n', time);
            if (step % 8 === 2 || step % 8 === 6) rim.triggerAttackRelease('8n', time);
            if (step % 2 === 1 && Math.random() < 0.8) conga.triggerAttackRelease('E4', '16n', time);
            if (Math.random() < 0.95) shaker.triggerAttackRelease('16n', time);
        }
        const beats = step / 8;
        if (beats === 4) section = 'groove';
        if (beats === 12) section = 'outro';
        if (step % 16 === 0) phraseIndex = (phraseIndex + 1) % phrases.length;
        if (section === 'outro' && step > 14 * 8) master.gain.rampTo(0, 4);
        step++;
    }, '8n');

    Tone.Transport.bpm.value = 112;
    Tone.Transport.start();
}
