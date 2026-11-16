export const TRACK_LENGTH = 6000;
export const COIN_VALUE = 100;
export const COIN_POSITIONS = [350, 950, 1650, 2350, 3100, 3850, 4650, 5400];
export const OBSTACLE_POSITIONS = [700, 1350, 2050, 2750, 3500, 4300, 5100, 5750];
export const JUMP_DURATION = 0.82;
export const INVINCIBILITY_SECONDS = 30;

export function getRaceStats(profile, activeBuffs = []) {
  const owned = new Set(activeBuffs);
  const permanentSpeed = owned.has("speed") ? 1.25 : 1;
  const permanentJump = owned.has("jump") ? 1.2 : 1;

  return {
    speed: (230 + Math.min(profile.speed_stat, 10) * 12) * permanentSpeed *
      (owned.has("speed_temp") ? 1.3 : 1),
    jumpHeight: (112 + Math.min(profile.jump_stat, 10) * 8) * permanentJump *
      (owned.has("jump_temp") ? 1.25 : 1),
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
