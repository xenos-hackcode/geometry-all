export const TRACK_LENGTH = 6000;
export const COIN_VALUE = 100;
export const COIN_POSITIONS = [350, 950, 1650, 2350, 3100, 3850, 4650, 5400];
export const OBSTACLE_POSITIONS = [700, 1350, 2050, 2750, 3500, 4300, 5100, 5750];
export const JUMP_DURATION = 0.82;
export const INVINCIBILITY_SECONDS = 30;

// Upgrades only nudge the fixed Geometry Dash-style speed and jump (max about +21% / +19%).
export const BASE_RUN_SPEED = 312;

export function getRaceStats(profile, activeBuffs = []) {
  const owned = new Set(activeBuffs);
  const speedStat = Math.max(0, Math.min(profile.speed_stat ?? 0, 10));
  const jumpStat = Math.max(0, Math.min(profile.jump_stat ?? 0, 10));
  return {
    speed: BASE_RUN_SPEED * (1 + speedStat * 0.01) * (owned.has("speed") ? 1.05 : 1) *
      (owned.has("speed_temp") ? 1.05 : 1),
    jumpMult: (1 + jumpStat * 0.01) * (owned.has("jump") ? 1.04 : 1) * (owned.has("jump_temp") ? 1.04 : 1),
    invincible: owned.has("shield") || owned.has("shield_temp"),
    doubleCoins: owned.has("double_coins") || owned.has("double_coins_temp"),
  };
}

export function getAward(place, pickups, doubleCoins = false) {
  const coinReward = (500 + Math.max(0, pickups) * COIN_VALUE) * (doubleCoins ? 2 : 1);
  const statPoints = place === 1 ? 3 : place === 2 ? 2 : place === 3 ? 1 : 0;
  return { coinReward, statPoints };
}

export function getPlayerPosition(progress, y, name, color, jumping = false) {
  return {
    progress: Math.max(0, Math.min(TRACK_LENGTH, progress)),
    y,
    name,
    color,
    jumping,
  };
}

// ---------- Bots ----------
// Bot speeds come from the race start time, so every player in the room (and the
// server, see public.bot_speed in schema.sql) works out exactly the same bots.
export const MAX_RACERS = 15;
export const BOT_NAMES = [
  "Bolt", "Pixel", "Zippy", "Echo", "Rex", "Nimbus", "Blip",
  "Turbo", "Kiwi", "Jinx", "Dash", "Momo", "Fizz", "Ziggy",
];

export function raceSeed(raceStartedAt) {
  return Math.floor(Date.parse(raceStartedAt) / 1000) % 100000;
}

export function maxBots(humanCount) {
  return Math.max(0, MAX_RACERS - humanCount);
}
