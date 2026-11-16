# Neon Dash game rules

Neon Dash is a new, original browser racing game. The downloaded Geometry Vibes
files are not included or modified.

## Rooms and players

- One player creates a room and shares its six-character code.
- Other players enter the code to join. Rooms hold up to 15 racers.
- No one around? The host can add 1 to 14 bots to fill empty seats, so you can
  race solo. If a new player joins a full room, a bot gives up its seat.
- The host can start once there are at least two racers (people or bots).
- Bots count for placement: if a bot crosses the line before you, it is ahead
  of you in the results and for stat points.
- Every cosmetic character is unlocked from the start.
- A guest profile is created per browser the first time someone plays.

## Race and rewards

- Each race has eight coin pickups worth 100 coins each.
- Every finisher earns 500 coins, plus the value of coins collected.
- A Double Coins buff doubles those race earnings.
- First place earns 3 stat points, second place earns 2, and third place earns 1.
- Players spend stat points on Speed or Jump in their profile.
- Each new profile starts with 1,000 coins.

## Buffs

Each buff can be purchased separately:

| Buff | Temporary (one race) | Permanent |
| --- | ---: | ---: |
| Speed | 200 coins | 100,000 coins |
| Jump | 200 coins | 100,000 coins |
| Invincibility | 200 coins | 100,000 coins |
| Double Coins | 200 coins | 100,000 coins |

Temporary buffs are consumed when a race starts. Invincibility lasts for the
first 30 seconds of that race. Permanent Speed and Jump improve the matching
stat; permanent Invincibility protects for the same 30-second window in every
race; permanent Double Coins doubles race earnings.

## Multiplayer and hosting

The site is designed for Vercel, with Supabase Auth, Postgres, and Realtime for
guest profiles, room state, and player updates. Supabase project credentials and
the database setup are required before classmates can join over the internet.
See `README.md`; no hosting accounts are created or deployed by this project.
