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

test("upgrades only nudge the fixed speed and jump", () => {
  const base = getRaceStats({ speed_stat: 0, jump_stat: 0 });
  const maxed = getRaceStats(
    { speed_stat: 10, jump_stat: 10 },
    ["speed", "speed_temp", "jump", "jump_temp", "shield", "double_coins_temp"],
  );
  assert.equal(base.speed, 312);
  assert.equal(base.jumpMult, 1);
  assert.ok(maxed.speed < 312 * 1.22);
  assert.ok(maxed.jumpMult < 1.2);
  assert.equal(maxed.invincible, true);
  assert.equal(maxed.doubleCoins, true);
});

test("race has a fixed positive finish distance", () => {
  assert.equal(TRACK_LENGTH, 6000);
});

import { readFileSync } from "node:fs";
import { maxBots, raceSeed } from "./race-engine.js";
import {
  BASE_SPEED, HAZARD_X, LEVEL, botAttempts, botFinishSeconds, botState, newRunnerBody,
  recordRun, solveLevel, stepBody,
} from "./level.js";

test("the level can be beaten with no upgrades and with every upgrade maxed", () => {
  const maxed = getRaceStats({ speed_stat: 10, jump_stat: 10 }, ["speed", "speed_temp", "jump", "jump_temp"]);
  for (const [speed, jumpMult] of [[BASE_SPEED, 1], [maxed.speed, 1], [BASE_SPEED, maxed.jumpMult], [maxed.speed, maxed.jumpMult]]) {
    const presses = solveLevel(speed, jumpMult);
    assert.ok(presses, `unbeatable at speed ${speed} jump ${jumpMult}`);
    assert.equal(recordRun(presses, speed, jumpMult).at(-1).x, TRACK_LENGTH);
  }
});

test("touching a spike or running into a block side crashes you", () => {
  const body = newRunnerBody();
  while (!body.dead && body.x < TRACK_LENGTH) stepBody(body, false);
  assert.equal(body.dead, true);
  assert.ok(body.x < LEVEL.spikes[0].x + 15);
});

test("a shield lets you run through hazards", () => {
  const body = newRunnerBody();
  for (let step = 0; step < 2000 && body.x < TRACK_LENGTH; step += 1) stepBody(body, false, BASE_SPEED, 1, { invincible: true });
  assert.equal(body.dead, false);
});

test("bots are deterministic, crash a few times, then finish", () => {
  const seed = raceSeed("2026-11-16T11:34:12.123456+00:00");
  assert.equal(seed, raceSeed("2026-11-16T11:34:12.999+00:00"));
  for (let bot = 0; bot < 14; bot += 1) {
    const attempts = botAttempts(seed, bot);
    assert.ok(attempts.length >= 1 && attempts.length <= 8);
    const finish = botFinishSeconds(seed, bot);
    assert.ok(finish >= TRACK_LENGTH / BASE_SPEED);
    assert.equal(botState(seed, bot, finish + 1).x, TRACK_LENGTH);
    assert.equal(botState(seed, bot, 0).x, 0);
  }
});

test("bot hazards in schema.sql match the level", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const match = schema.match(/hazards integer\[\] := array\[([^\]]+)\]/);
  assert.ok(match, "schema.sql is missing the bot hazard list");
  assert.deepEqual(match[1].split(",").map((value) => Number(value.trim())), HAZARD_X);
});

test("rooms hold 15 racers including bots", () => {
  assert.equal(maxBots(1), 14);
  assert.equal(maxBots(15), 0);
  assert.equal(maxBots(20), 0);
});
