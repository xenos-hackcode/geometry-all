import test from "node:test";
import assert from "node:assert/strict";
import { getAward, getRaceStats, TRACK_LENGTH } from "./race-engine.js";

test("finishing awards participation coins and podium stat points", () => {
  assert.deepEqual(getAward(1, 2), { coinReward: 700, statPoints: 3 });
  assert.deepEqual(getAward(2, 0), { coinReward: 500, statPoints: 2 });
  assert.deepEqual(getAward(3, 1), { coinReward: 600, statPoints: 1 });
  assert.deepEqual(getAward(4, 0), { coinReward: 500, statPoints: 0 });
});

test("double-coins buff doubles race earnings", () => {
  assert.deepEqual(getAward(1, 2, true), { coinReward: 1400, statPoints: 3 });
});

test("permanent and temporary buffs affect the intended stats", () => {
  const base = getRaceStats({ speed_stat: 0, jump_stat: 0 });
  const boosted = getRaceStats(
    { speed_stat: 2, jump_stat: 3 },
    ["speed", "jump_temp", "shield", "double_coins_temp"],
  );
  assert.equal(base.speed, 230);
  assert.equal(base.jumpHeight, 112);
  assert.equal(boosted.speed, (230 + 2 * 12) * 1.25);
  assert.equal(boosted.jumpHeight, (112 + 3 * 8) * 1.25);
  assert.equal(boosted.invincible, true);
  assert.equal(boosted.doubleCoins, true);
});

test("race has a fixed positive finish distance", () => {
  assert.equal(TRACK_LENGTH, 6000);
});

import { botSpeed, botFinishSeconds, botProgress, maxBots, raceSeed } from "./race-engine.js";

test("bots are deterministic and race at a fair speed", () => {
  const seed = raceSeed("2026-11-16T11:34:12.123456+00:00");
  assert.equal(seed, raceSeed("2026-11-16T11:34:12.999+00:00"));
  for (let bot = 0; bot < 14; bot += 1) {
    const speed = botSpeed(seed, bot);
    assert.ok(speed >= 190 && speed <= 300);
    assert.equal(botSpeed(seed, bot), speed);
  }
  assert.equal(botProgress(seed, 0, 0), 0);
  assert.equal(botProgress(seed, 0, botFinishSeconds(seed, 0) + 5), TRACK_LENGTH);
});

test("rooms hold 15 racers including bots", () => {
  assert.equal(maxBots(1), 14);
  assert.equal(maxBots(15), 0);
  assert.equal(maxBots(20), 0);
});
