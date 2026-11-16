# Neon Dash

An original, small browser multiplayer racing game. It is not a modification or
redistribution of the downloaded Geometry Vibes game.

## Run locally

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql)
   in its SQL editor.
2. In Supabase Authentication settings, enable anonymous sign-ins.
3. Copy `.env.example` to `.env.local` and fill in the project URL and the
   publishable/anon key from the Supabase project settings.
4. Install and start the app:

   ```sh
   npm install
   npm run dev
   ```

Vite prints a local URL. Open it in two browser profiles or devices to test
create/join. Profiles are guest accounts stored by Supabase Auth and persist
across visits in the same browser.

## Deploy to Vercel

Import this GitHub repository into Vercel, set the two `VITE_SUPABASE_*`
environment variables for the production deployment, and deploy. The static
site uses Supabase Realtime for room traffic; Vercel does not need to run a
separate WebSocket server. Keep the Supabase service-role key private and do not
add it to Vercel's `VITE_` variables or the browser bundle.

Supabase Realtime authorization is configured by the SQL schema. Room messages
are limited to authenticated users who have joined the matching room.

## Game rules

See [`GAME_RULES.md`](GAME_RULES.md) for all characters, placement rewards,
starting balance, and buff pricing/effects.

## Checks

```sh
npm test
npm run build
```
