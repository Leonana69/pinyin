'use strict';

/* Everything worth tuning lives here. */
const CONFIG = {
  overlap: 2,           // seconds: the next clip starts this long before the current one ends
  slideDuration: 0.75,  // seconds: the slide-in; clips open their mouth about this far in
  restStagger: 0.07,    // seconds between each card settling, left to right
  lookahead: 3,         // clips to buffer ahead of the one playing
  startPatience: 2,     // seconds to wait for the first clip to buffer before starting anyway
  maxStartLag: 0.5,     // seconds: upper limit on the audio delay we compensate for
  maxCards: 60,         // longest word performed; browsers cap live video elements near 75
  umlautClip: 'v',      // ü has no clip of its own; v is how pinyin keyboards type it
  clipPath: (letter) => `assets/web/${letter}.mp4`,

  // Seconds into each clip where the mouth is most fully formed. Cards settle
  // on this frame once the word is finished.
  restFrames: {
    a: 1.03, b: 1.07, c: 0.77, d: 1.0, e: 1.0, f: 0.87, g: 1.03, h: 0.57, i: 1.43,
    j: 0.85, k: 1.8, l: 1.1, m: 1.07, n: 0.57, o: 1.13, p: 1.1, q: 1.07, r: 1.27,
    s: 0.57, t: 0.67, u: 0.73, v: 1.5, w: 1.5, x: 0.7, y: 0.93, z: 0.67,
  },
};

const body = document.body;
const form = document.getElementById('composer');
const input = document.getElementById('word');
const stage = document.getElementById('stage');
const readout = document.getElementById('readout');
const hud = document.querySelector('.hud');
const canHover = matchMedia('(hover: hover)');

document.documentElement.style.setProperty('--slide', `${CONFIG.slideDuration}s`);

let current = null; // the run on stage

// Seconds between a clip being started and it actually being heard. Bluetooth
// alone adds a quarter second, which would eat most of the overlap. It differs
// per listener, so it is measured from playback rather than assumed.
let startLag = 0;
const recentLags = [];

/* ── Hanzi → letters ─────────────────────────────────── */

// 'ǎ' → { glyph: 'ǎ', clip: 'a' }, 'ǚ' → { glyph: 'ǚ', clip: 'v' }, '!' → null
function toLetter(glyph) {
  const decomposed = glyph.normalize('NFD');
  const base = decomposed[0].toLowerCase();
  if (!/[a-z]/.test(base)) return null;
  return { glyph, clip: decomposed.includes('̈') ? CONFIG.umlautClip : base };
}

// '你好' → [[n, ǐ], [h, ǎ, o]]; anything without a clip (digits, punctuation) drops out.
function decompose(text) {
  return pinyinPro.pinyin(text, { type: 'array' })
    .map((syllable) => [...syllable].map(toLetter).filter(Boolean))
    .filter((letters) => letters.length);
}

/* ── Readout ─────────────────────────────────────────── */

function renderReadout(syllables) {
  const spans = [];
  readout.replaceChildren(...syllables.map((letters) => {
    const word = document.createElement('span');
    for (const { glyph } of letters) {
      const span = document.createElement('i');
      span.textContent = glyph;
      word.append(span);
      spans.push(span);
    }
    return word;
  }));
  return spans;
}

function showNote(text) {
  const note = document.createElement('span');
  note.className = 'note';
  note.textContent = text;
  readout.append(note);
}

/* ── Stage ───────────────────────────────────────────── */

function createCard({ glyph, clip }, syllableStart) {
  const el = document.createElement('div');
  el.className = syllableStart ? 'card syllable-start' : 'card';

  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = glyph;

  el.append(video, tag);
  return { el, video, clip, failed: false, onFail: null };
}

function load(card) {
  if (!card.video.hasAttribute('src')) card.video.src = CONFIG.clipPath(card.clip);
}

// Fetch clips one at a time, in playing order, so the clip needed next never
// shares a slow connection with the ones behind it.
function bufferAhead(run) {
  const next = run.cards.findIndex(({ video }) => !video.hasAttribute('src'));
  if (run.dead || run.buffering || next < 0 || next > run.index + CONFIG.lookahead) return;

  const card = run.cards[next];
  const done = () => { run.buffering = false; bufferAhead(run); };
  run.buffering = true;
  card.video.addEventListener('canplaythrough', done, { once: true });
  card.video.addEventListener('error', done, { once: true });
  load(card);
}

function positionTrack(run) {
  const stageWidth = stage.clientWidth;

  if (run.finished) {
    // Pull back until the whole word fits between the page margins, then centre it.
    const last = run.cards[run.cards.length - 1].el;
    const width = last.offsetLeft + last.offsetWidth;
    const margin = parseFloat(getComputedStyle(hud).paddingLeft);
    const scale = Math.min(1, (stageWidth - margin * 2) / width);
    const x = (stageWidth - width * scale) / 2;
    run.track.style.transform = `translate3d(${x}px, 0, 0) scale(${scale})`;
    return;
  }

  const card = run.cards[run.index].el;
  const x = stageWidth / 2 - (card.offsetLeft + card.offsetWidth / 2);
  run.track.style.transform = `translate3d(${x}px, 0, 0)`;
}

function dismiss(run) {
  if (!run) return;
  run.dead = true;
  run.cards.forEach((card) => card.video.pause());

  // Prepended so the exit distance isn't shrunk by the settled strip's scale.
  const right = run.track.getBoundingClientRect().right;
  run.track.style.transform = `translate3d(${-right - 40}px, 0, 0) ${run.track.style.transform}`;

  setTimeout(() => {
    run.cards.forEach(({ video }) => { video.removeAttribute('src'); video.load(); });
    run.track.remove();
  }, CONFIG.slideDuration * 1000);
}

/* ── Sequencing ──────────────────────────────────────── */

function speak(run, index) {
  if (run.dead) return;

  const card = run.cards[index];
  const isLast = index === run.cards.length - 1;
  const { video } = card;

  run.index = index;
  load(card);  // phones can ignore preloading, leaving the queue behind
  bufferAhead(run);

  card.el.classList.add('arrived', 'speaking');
  run.spans[index].classList.add('on');
  positionTrack(run);

  let handedOff = false;
  const handOff = () => {
    if (handedOff || run.dead) return;
    handedOff = true;
    if (!isLast) speak(run, index + 1);
  };

  let finished = false;
  const finishClip = () => {
    if (finished) return;
    finished = true;
    card.el.classList.remove('speaking');
    run.spans[index].classList.remove('on');
    handOff();
    // With a long overlap a short final clip can end before a longer one before it.
    run.spoken += 1;
    if (run.spoken === run.cards.length && !run.dead) settle(run);
  };

  if (card.failed) return finishClip();
  card.onFail = finishClip;

  video.addEventListener('ended', finishClip, { once: true });

  // Watch the clip itself rather than a timer, so a stall delays the
  // hand-off instead of breaking the overlap. `ended` covers background tabs,
  // where animation frames stop.
  let startedAt = 0;
  const watch = () => {
    if (handedOff || run.dead) return;
    const { currentTime, duration } = video;

    // The clock ticks a few milliseconds, then holds until sound is really out,
    // so only trust it once it is well past that first tick.
    if (startedAt && currentTime > 0.1) {
      const lag = (performance.now() - startedAt) / 1000 - currentTime;
      recentLags.push(Math.min(Math.max(lag, 0), CONFIG.maxStartLag));
      startLag = Math.min(...recentLags.slice(-3));  // the true delay is the floor; ignore slow starts
      startedAt = 0;
    }

    if (!isLast && duration - currentTime <= CONFIG.overlap + startLag) return handOff();
    requestAnimationFrame(watch);
  };

  const startWatching = () => {
    startedAt = performance.now();
    watch();
  };

  video.play().then(startWatching, (error) => {
    if (run.dead || error.name !== 'NotAllowedError') return;  // load failures arrive via onFail
    console.warn('Playback with sound was refused; continuing muted.', error);
    video.muted = true;
    video.play().then(startWatching, finishClip);
  });
}

// The word is said. Pull back and let every mouth rest open, left to right.
function settle(run) {
  run.finished = true;
  body.dataset.state = 'rest';
  positionTrack(run);

  run.cards.forEach(({ video, clip, failed }, i) => {
    if (failed) return;
    setTimeout(() => {
      if (!run.dead) video.currentTime = CONFIG.restFrames[clip];
    }, i * CONFIG.restStagger * 1000);
  });
}

function perform(text) {
  const syllables = decompose(text);
  const letters = syllables
    .flatMap((syllable) => syllable.map((letter, i) => ({ ...letter, syllableStart: i === 0 })))
    .slice(0, CONFIG.maxCards);

  if (!letters.length) {
    renderReadout([]);
    if (text.trim()) showNote('没有拼音 · No pinyin for this');
    return;
  }

  dismiss(current);

  const track = document.createElement('div');
  track.className = 'track';
  const cards = letters.map((letter) => createCard(letter, letter.syllableStart));
  track.append(...cards.map((card) => card.el));

  const run = current = {
    track, cards,
    spans: renderReadout(syllables),
    index: 0, spoken: 0, dead: false, finished: false, warned: false, buffering: false,
  };

  cards.forEach((card) => {
    card.video.addEventListener('error', () => {
      if (run.dead) return;
      card.failed = true;
      if (!run.warned) showNote('视频加载失败 · The video clips couldn’t load');
      run.warned = true;
      card.onFail?.();
    }, { once: true });
  });

  bufferAhead(run);

  // Safari only lets an element make sound if it was first started inside a
  // user gesture, and this is the last moment we are in one.
  cards.forEach(({ video }) => { video.play().catch(() => {}); video.pause(); });

  stage.append(track);
  track.getBoundingClientRect();  // lay the cards out off-stage so their arrival animates

  body.dataset.state = 'playing';
  armForNextWord();

  // Some phones won't load a clip until told to play it, so never wait forever.
  let begun = false;
  const begin = () => {
    if (begun) return;
    begun = true;
    speak(run, 0);
  };
  cards[0].video.addEventListener('canplaythrough', begin, { once: true });
  cards[0].onFail = begin;
  setTimeout(begin, CONFIG.startPatience * 1000);
}

/* ── Input ───────────────────────────────────────────── */

// With the performed word selected, the next keystroke replaces it. Skipped on
// touch, where focusing would raise the keyboard over the piece.
function armForNextWord() {
  if (!canHover.matches) return;
  input.focus();
  input.select();
}

// Hanzi are a full em wide, Latin about half; good enough to keep the text on screen.
function fitText() {
  const units = [...input.value].reduce((sum, c) => sum + (c.charCodeAt(0) > 0x2e7f ? 1 : 0.56), 0);
  input.style.setProperty('--units', Math.max(1, units * 1.04));
}

function onType() {
  dismiss(current);
  current = null;
  fitText();
  renderReadout(decompose(input.value));
  body.dataset.state = input.value ? 'typing' : 'idle';
}

input.addEventListener('input', onType);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  perform(input.value);
});

document.querySelectorAll('[data-word]').forEach((button) => {
  button.addEventListener('click', () => {
    input.value = button.dataset.word;
    onType();
    perform(input.value);
  });
});

// The input fills the page, so a click would otherwise drop a caret into the finished word.
document.addEventListener('pointerup', () => {
  if (current) armForNextWord();
});

window.addEventListener('resize', () => {
  fitText();
  if (current) positionTrack(current);
});
