// Neon Dash level + platformer physics (original level, Geometry Dash-style rules).
// World units: x runs along the track (0 → TRACK_LENGTH), y is height above the floor.
// One block is 30 units. Everything here is deterministic so the game, the bots and
// the tests all simulate exactly the same thing.

import { COIN_POSITIONS, TRACK_LENGTH } from "./race-engine.js";

export const BLOCK = 30;
export const PLAYER_SIZE = 30;
export const BASE_SPEED = 312; // units per second (about 10.4 blocks/s)
export const GRAVITY = 2990;
export const JUMP_VELOCITY = 628; // ~2.2 blocks high, ~4.4 blocks long at base speed
export const PAD_VELOCITY = 860; // yellow pad: ~4 blocks high
export const ORB_VELOCITY = 610; // yellow ring: mid-air jump
export const RESPAWN_DELAY = 0.8; // seconds between crashing and the next attempt
export const STEP = 1 / 240; // fixed physics step
const SNAP = 9; // how far you can sink into a block top and still land on it
const SPIN = Math.PI / (2 * JUMP_VELOCITY / GRAVITY); // half a turn per normal jump

const b = (blocks) => blocks * BLOCK;

// ---------- The level (in blocks) ----------
// spikes: [x, baseY]   blocks: [x, y, w, h]   pads: [x, y]   orbs: [x, y] (centre)
const SPIKES = [
  [15, 0], [21, 0], [26, 0], [27, 0],
  [43, 0],
  [49, 0],
  [56, 0], [57, 0], [58, 0],
  [66, 0], [69, 0],
  [84, 0], [85, 0], [86, 0], [87, 0], [88, 0],
  [98, 1], [101, 1],
  [108, 0], [109, 0], [110, 0],
  [116, 0], [117, 0], [123, 3],
  [129, 0], [130, 0],
  [135, 0],
  [146, 0], [147, 0], [148, 0], [149, 0], [150, 0], [151, 0], [152, 0],
  [159, 0], [160, 0], [166, 0],
  [173, 0], [177, 0], [178, 0],
  [186, 0], [190, 0], [191, 0],
];
const BLOCKS = [
  [36, 0, 1, 1], [40, 0, 1, 1],
  [45, 0, 3, 1],
  [64, 0, 2, 1], [67, 0, 2, 2], [70, 0, 3, 3],
  [95, 0, 8, 1],
  [118, 0, 8, 3],
  [140, 0, 1, 1],
  [170, 0, 3, 1], [174, 0, 3, 2],
];
const PADS = [[53, 0], [115, 0]];
const ORBS = [[86, 2.6], [148.3, 2.6], [151.3, 2.6]];
// Coin heights (in blocks) for the server's fixed coin x positions.
const COIN_HEIGHTS = [2, 2, 3.6, 2, 3, 2, 2, 2];

export const LEVEL = {
  spikes: SPIKES.map(([x, y]) => ({ x: b(x) + BLOCK / 2, y: b(y) })),
  blocks: BLOCKS.map(([x, y, w, h]) => ({ x: b(x), y: b(y), w: b(w), h: b(h) })),
  pads: PADS.map(([x, y]) => ({ x: b(x) + BLOCK / 2, y: b(y) })),
  orbs: ORBS.map(([x, y]) => ({ x: b(x) + BLOCK / 2, y: b(y) })),
  coins: COIN_POSITIONS.map((x, index) => ({ x, y: b(COIN_HEIGHTS[index]) })),
};

// Where a bot can crash: just before each spike (sorted, unique). Mirrored in schema.sql.
export const HAZARD_X = [...new Set(LEVEL.spikes.map((spike) => Math.round(spike.x - BLOCK)))]
  .sort((a, b2) => a - b2);

// ---------- Physics ----------
export function newRunnerBody() {
  return { x: 0, y: 0, vy: 0, grounded: true, angle: 0, dead: false, usedOrbs: new Set(), usedPads: new Set() };
}

const overlaps = (ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) => ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;

function hasSupport(body) {
  if (body.y <= 0) return true;
  const half = PLAYER_SIZE / 2;
  return LEVEL.blocks.some((block) =>
    Math.abs(block.y + block.h - body.y) < 0.5 && body.x + half > block.x && body.x - half < block.x + block.w);
}

// Advance one fixed step. `held` is whether jump is held down.
// Returns { coin: index | null } and sets body.dead when you crash.
export function stepBody(body, held, speed = BASE_SPEED, jumpMult = 1, { invincible = false } = {}) {
  if (body.dead) return { coin: null };
  const dt = STEP;
  const half = PLAYER_SIZE / 2;
  const prevY = body.y;
  body.x += speed * dt;

  if (body.grounded && !hasSupport(body)) body.grounded = false;
  if (body.grounded && held) {
    body.vy = JUMP_VELOCITY * jumpMult;
    body.grounded = false;
  }
  if (held) {
    LEVEL.orbs.forEach((orb, index) => {
      if (body.usedOrbs.has(index)) return;
      if (Math.abs(orb.x - body.x) < half + 14 && Math.abs(orb.y - (body.y + half)) < half + 14) {
        body.usedOrbs.add(index);
        body.vy = ORB_VELOCITY * jumpMult;
        body.grounded = false;
      }
    });
  }
  if (!body.grounded) {
    body.vy -= GRAVITY * dt;
    body.y += body.vy * dt;
  }
  if (body.y <= 0) {
    body.y = 0;
    body.vy = 0;
    body.grounded = true;
  }
  for (const block of LEVEL.blocks) {
    if (!overlaps(body.x - half, body.y, body.x + half, body.y + PLAYER_SIZE,
      block.x, block.y, block.x + block.w, block.y + block.h)) continue;
    const top = block.y + block.h;
    if (body.vy <= 0 && prevY >= top - SNAP) {
      body.y = top;
      body.vy = 0;
      body.grounded = true;
    } else if (!invincible) {
      body.dead = true;
      return { coin: null };
    } else {
      body.y = top;
      body.vy = 0;
      body.grounded = true;
    }
  }
  LEVEL.pads.forEach((pad, index) => {
    if (body.usedPads.has(index)) return;
    if (overlaps(body.x - half, body.y, body.x + half, body.y + PLAYER_SIZE, pad.x - 13, pad.y, pad.x + 13, pad.y + 7)) {
      body.usedPads.add(index);
      body.vy = PAD_VELOCITY * jumpMult;
      body.grounded = false;
    }
  });
  if (!invincible) {
    for (const spike of LEVEL.spikes) {
      // Spike hitboxes are smaller than the drawn spike, like the real thing.
      if (overlaps(body.x - half + 2, body.y + 2, body.x + half - 2, body.y + PLAYER_SIZE - 2,
        spike.x - 5.5, spike.y + 5, spike.x + 5.5, spike.y + 21)) {
        body.dead = true;
        return { coin: null };
      }
    }
  }
  let coin = null;
  LEVEL.coins.forEach((item, index) => {
    if (coin === null && Math.abs(item.x - body.x) < half + 11 && Math.abs(item.y - (body.y + half)) < half + 11) coin = index;
  });

  if (body.grounded) {
    const snapped = Math.round(body.angle / (Math.PI / 2)) * (Math.PI / 2);
    body.angle += (snapped - body.angle) * 0.35;
  } else {
    body.angle += SPIN * dt * (speed / BASE_SPEED);
  }
  return { coin };
}

// ---------- Solver (used by tests and to drive bots) ----------
// Finds the set of steps on which to hold jump so a run reaches the finish.
// Branches only where input matters: when standing, or when touching an unused ring.
export function solveLevel(speed = BASE_SPEED, jumpMult = 1) {
  const totalSteps = Math.ceil(TRACK_LENGTH / (speed * STEP)) + 2;
  const seen = new Set();
  const presses = [];
  const clone = (body) => ({ ...body, usedOrbs: new Set(body.usedOrbs), usedPads: new Set(body.usedPads) });

  function canPress(body) {
    if (body.grounded) return true;
    const half = PLAYER_SIZE / 2;
    return LEVEL.orbs.some((orb, index) => !body.usedOrbs.has(index) &&
      Math.abs(orb.x - (body.x + speed * STEP)) < half + 14 && Math.abs(orb.y - (body.y + half)) < half + 18);
  }

  // Iterative DFS so long levels don't blow the stack.
  const stack = [{ body: newRunnerBody(), step: 0, pressIndex: 0, tried: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.body.x >= TRACK_LENGTH) return presses.slice();
    if (frame.step > totalSteps || frame.tried >= 2) {
      stack.pop();
      if (stack.length) presses.length = stack[stack.length - 1].pressIndex;
      continue;
    }
    const option = frame.tried; // 0 = don't press, 1 = press
    frame.tried += 1;
    if (option === 1 && !canPress(frame.body)) continue;
    // Advance until the next decision point (or death / finish).
    const body = clone(frame.body);
    presses.length = frame.pressIndex;
    let step = frame.step;
    let held = option === 1;
    if (held) presses.push(step);
    stepBody(body, held, speed, jumpMult);
    step += 1;
    while (!body.dead && body.x < TRACK_LENGTH && !canPress(body)) {
      stepBody(body, false, speed, jumpMult);
      step += 1;
    }
    if (body.dead) continue;
    const key = `${step}|${Math.round(body.y)}|${Math.round(body.vy)}|${body.grounded}|${[...body.usedOrbs].join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stack.push({ body, step, pressIndex: presses.length, tried: 0 });
  }
  return null;
}

// Replays a solved run and records where the body is on every step (for bots).
export function recordRun(presses, speed = BASE_SPEED, jumpMult = 1) {
  const pressed = new Set(presses);
  const body = newRunnerBody();
  const frames = [];
  for (let step = 0; body.x < TRACK_LENGTH && step < 100000; step += 1) {
    frames.push({ x: body.x, y: body.y, angle: body.angle });
    stepBody(body, pressed.has(step), speed, jumpMult);
    if (body.dead) throw new Error(`Recorded run crashed at x=${Math.round(body.x)}`);
  }
  frames.push({ x: TRACK_LENGTH, y: body.y, angle: body.angle });
  return frames;
}

// ---------- Bots ----------
// A bot crashes a few times (at hazards picked from the race seed), then does a clean run.
// Must match public.bot_finish_seconds in schema.sql.
export function botAttempts(seed, botIndex) {
  const fails = (seed * 13 + (botIndex + 1) * 29) % 8;
  const attempts = [];
  for (let attempt = 0; attempt < fails; attempt += 1) {
    const hazard = HAZARD_X[(seed * 7 + (botIndex + 1) * 31 + attempt * 17) % HAZARD_X.length];
    attempts.push({ crashAt: hazard, seconds: hazard / BASE_SPEED + RESPAWN_DELAY });
  }
  attempts.push({ crashAt: null, seconds: TRACK_LENGTH / BASE_SPEED });
  return attempts;
}

export function botFinishSeconds(seed, botIndex) {
  return botAttempts(seed, botIndex).reduce((total, attempt) => total + attempt.seconds, 0);
}

let botRun = null;
function getBotRun() {
  if (!botRun) {
    const presses = solveLevel();
    botRun = presses ? recordRun(presses) : null;
  }
  return botRun;
}

// Where a bot is `elapsed` seconds after the race started.
export function botState(seed, botIndex, elapsed) {
  const run = getBotRun();
  let time = Math.max(0, elapsed);
  const attempts = botAttempts(seed, botIndex);
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (time < attempt.seconds || index === attempts.length - 1) {
      const frameIndex = Math.min(Math.floor(time / STEP), (run?.length ?? 1) - 1);
      const frame = run?.[frameIndex] ?? { x: Math.min(TRACK_LENGTH, time * BASE_SPEED), y: 0, angle: 0 };
      if (attempt.crashAt !== null && frame.x >= attempt.crashAt) {
        return { x: attempt.crashAt, y: 0, angle: 0, dead: true, attempt: index + 1 };
      }
      return { x: frame.x, y: frame.y, angle: frame.angle, dead: false, attempt: index + 1, finished: frame.x >= TRACK_LENGTH };
    }
    time -= attempt.seconds;
  }
  return { x: TRACK_LENGTH, y: 0, angle: 0, dead: false, finished: true, attempt: attempts.length };
}
