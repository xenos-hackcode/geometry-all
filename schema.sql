create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Runner' check (char_length(display_name) between 1 and 20),
  coins integer not null default 1000 check (coins >= 0),
  stat_points integer not null default 0 check (stat_points >= 0),
  speed_stat integer not null default 0 check (speed_stat between 0 and 10),
  jump_stat integer not null default 0 check (jump_stat between 0 and 10),
  character_id text not null default 'comet',
  permanent_buffs text[] not null default '{}',
  temporary_buffs text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  host_id uuid not null references auth.users(id),
  status text not null default 'lobby' check (status in ('lobby', 'race', 'finished')),
  race_id uuid,
  race_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  finish_place integer,
  active_buffs text[] not null default '{}',
  race_progress integer not null default 0 check (race_progress between 0 and 6000),
  collected_coin_indices integer[] not null default '{}',
  primary key (room_id, user_id)
);

alter table public.room_members add column if not exists active_buffs text[] not null default '{}';
alter table public.room_members add column if not exists race_progress integer not null default 0;
alter table public.room_members add column if not exists collected_coin_indices integer[] not null default '{}';
alter table public.rooms add column if not exists race_started_at timestamptz;
alter table public.rooms add column if not exists bot_count integer not null default 0;
alter table public.room_members add column if not exists finished_at timestamptz;
do $$ begin
  alter table public.rooms add constraint rooms_bot_count_range check (bot_count between 0 and 14);
exception when duplicate_object then null; end $$;

-- Bots: speeds come from the race start time so the server and every client agree.
-- Keep in sync with raceSeed/botSpeed in src/race-engine.js.
create or replace function public.race_seed(started timestamptz)
returns bigint language sql immutable set search_path = '' as $$
  select floor(extract(epoch from started))::bigint % 100000
$$;

create or replace function public.bot_speed(seed bigint, bot_index integer)
returns integer language sql immutable set search_path = '' as $$
  select (190 + ((seed * 7919 + (bot_index + 1) * 104729) % 111))::integer
$$;

create or replace function public.bots_finished_by(bot_count integer, started timestamptz, at_time timestamptz)
returns integer language sql stable set search_path = '' as $$
  select count(*)::integer from generate_series(0, bot_count - 1) as bots(i)
  where started + make_interval(secs => 6000.0 / public.bot_speed(public.race_seed(started), bots.i)) <= at_time
$$;

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

create or replace function public.is_room_member_id(target_room uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members m
    where m.room_id = target_room and m.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_room_member_id(uuid) from public;
grant execute on function public.is_room_member_id(uuid) to authenticated;

drop policy if exists "profile owner reads profile" on public.profiles;
create policy "profile owner reads profile"
  on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists "profile owner inserts profile" on public.profiles;
create policy "profile owner inserts profile"
  on public.profiles for insert to authenticated with check (id = auth.uid());

drop policy if exists "room members read room" on public.rooms;
create policy "room members read room" on public.rooms for select to authenticated
  using (public.is_room_member_id(id));
drop policy if exists "room members read members" on public.room_members;
create policy "room members read members" on public.room_members for select to authenticated
  using (public.is_room_member_id(room_id));

create or replace function public.is_room_member(topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when split_part(topic, ':', 1) <> 'room'
      or split_part(topic, ':', 2) !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then false
    else exists (
      select 1 from public.room_members m
      where m.room_id = split_part(topic, ':', 2)::uuid and m.user_id = (select auth.uid())
    )
  end;
$$;
revoke all on function public.is_room_member(text) from public;
grant execute on function public.is_room_member(text) to authenticated;

drop policy if exists "room members receive realtime" on realtime.messages;
create policy "room members receive realtime" on realtime.messages for select to authenticated
  using (public.is_room_member((select realtime.topic())));
drop policy if exists "room members send realtime" on realtime.messages;
create policy "room members send realtime" on realtime.messages for insert to authenticated
  with check (public.is_room_member((select realtime.topic())));

create or replace function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare result public.profiles;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  insert into public.profiles(id, display_name)
    values (auth.uid(), 'Runner-' || upper(substr(replace(auth.uid()::text, '-', ''), 1, 4)))
    on conflict (id) do nothing;
  select * into result from public.profiles where id = auth.uid();
  return result;
end;
$$;

create or replace function public.update_profile_name(new_name text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare result public.profiles;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if char_length(trim(new_name)) not between 1 and 20 then raise exception 'Name must be 1 to 20 characters'; end if;
  update public.profiles set display_name = trim(new_name), updated_at = now()
    where id = auth.uid() returning * into result;
  if not found then raise exception 'Profile not found'; end if;
  return result;
end;
$$;

create or replace function public.create_room()
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare new_room public.rooms;
declare room_code text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  perform public.ensure_profile();
  delete from public.rooms where created_at < now() - interval '24 hours';
  loop
    room_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    exit when not exists (select 1 from public.rooms where code = room_code);
  end loop;
  insert into public.rooms(code, host_id) values (room_code, auth.uid()) returning * into new_room;
  insert into public.room_members(room_id, user_id) values (new_room.id, auth.uid());
  return new_room;
end;
$$;

create or replace function public.join_room(room_code text)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare found_room public.rooms;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  perform public.ensure_profile();
  select * into found_room from public.rooms
    where code = upper(trim(room_code)) and status = 'lobby'
      and created_at > now() - interval '24 hours' for update;
  if not found then raise exception 'Room not found or race already started'; end if;
  if not exists (select 1 from public.room_members
      where room_id = found_room.id and user_id = auth.uid()) then
    if (select count(*) from public.room_members where room_id = found_room.id) >= 15 then
      raise exception 'Room is full (maximum 15 players)';
    end if;
    insert into public.room_members(room_id, user_id) values (found_room.id, auth.uid());
    -- A bot gives up its seat if the room would go over 15 racers.
    update public.rooms set bot_count = least(bot_count,
        15 - (select count(*) from public.room_members where room_id = found_room.id)::integer),
      updated_at = now()
      where id = found_room.id returning * into found_room;
  end if;
  return found_room;
end;
$$;

drop function if exists public.get_room_players(uuid);
create function public.get_room_players(room_id uuid)
returns table (
  user_id uuid, display_name text, character_id text, speed_stat integer,
  jump_stat integer, permanent_buffs text[], joined_at timestamptz, finish_place integer,
  finished_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.room_members m where m.room_id = get_room_players.room_id and m.user_id = auth.uid()
  ) then raise exception 'Join the room to see its players'; end if;
  return query
    select p.id, p.display_name, p.character_id, p.speed_stat, p.jump_stat,
      p.permanent_buffs, m.joined_at, m.finish_place, m.finished_at
    from public.room_members m join public.profiles p on p.id = m.user_id
    where m.room_id = get_room_players.room_id order by m.joined_at;
end;
$$;

create or replace function public.set_character(new_character text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare result public.profiles;
begin
  if new_character not in ('comet', 'prism', 'orbit', 'spark', 'nova', 'puddle') then
    raise exception 'Unknown character';
  end if;
  update public.profiles set character_id = new_character, updated_at = now()
    where id = auth.uid() returning * into result;
  if not found then raise exception 'Profile not found'; end if;
  return result;
end;
$$;

create or replace function public.buy_buff(buff_name text, permanent boolean)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare result public.profiles;
declare price integer := case when permanent then 100000 else 200 end;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if buff_name not in ('speed', 'jump', 'shield', 'double_coins') then raise exception 'Unknown buff'; end if;
  select * into result from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'Profile not found'; end if;
  if permanent and buff_name = any(result.permanent_buffs) then raise exception 'Permanent buff already owned'; end if;
  if not permanent and buff_name = any(result.temporary_buffs) then raise exception 'Temporary buff already purchased for the next race'; end if;
  if result.coins < price then raise exception 'Not enough coins'; end if;
  if permanent then
    update public.profiles set coins = coins - price,
      permanent_buffs = array_append(permanent_buffs, buff_name), updated_at = now()
      where id = auth.uid() returning * into result;
  else
    update public.profiles set coins = coins - price,
      temporary_buffs = array_append(temporary_buffs, buff_name), updated_at = now()
      where id = auth.uid() returning * into result;
  end if;
  return result;
end;
$$;

create or replace function public.upgrade_stat(stat_name text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare result public.profiles;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if stat_name not in ('speed', 'jump') then raise exception 'Unknown stat'; end if;
  select * into result from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'Profile not found'; end if;
  if result.stat_points < 1 then raise exception 'No stat points available'; end if;
  if (stat_name = 'speed' and result.speed_stat >= 10)
    or (stat_name = 'jump' and result.jump_stat >= 10) then
    raise exception 'That stat is already at its maximum';
  end if;
  if stat_name = 'speed' then
    update public.profiles set stat_points = stat_points - 1, speed_stat = speed_stat + 1,
      updated_at = now() where id = auth.uid() returning * into result;
  else
    update public.profiles set stat_points = stat_points - 1, jump_stat = jump_stat + 1,
      updated_at = now() where id = auth.uid() returning * into result;
  end if;
  return result;
end;
$$;

create or replace function public.start_race(room_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare selected_room public.rooms;
declare new_race uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into selected_room from public.rooms
    where code = upper(trim(room_code)) for update;
  if not found or selected_room.host_id <> auth.uid() then raise exception 'Only the room host can start'; end if;
  if selected_room.status <> 'lobby' then raise exception 'Room is not waiting for players'; end if;
  if (select count(*) from public.room_members where room_id = selected_room.id)
      + selected_room.bot_count < 2 then
    raise exception 'Add a bot or wait for another player';
  end if;
  update public.room_members m set active_buffs = array_cat(p.permanent_buffs, p.temporary_buffs)
    from public.profiles p
    where m.room_id = selected_room.id and p.id = m.user_id;
  update public.profiles p set temporary_buffs = '{}', updated_at = now()
    where p.id in (select user_id from public.room_members where room_id = selected_room.id);
  update public.rooms set status = 'race', race_id = new_race, race_started_at = now(), updated_at = now()
    where id = selected_room.id;
  update public.room_members set finish_place = null, finished_at = null, race_progress = 0,
    collected_coin_indices = '{}' where room_id = selected_room.id;
  return new_race;
end;
$$;

create or replace function public.update_race_progress(
  room_code text,
  new_progress integer,
  new_coin_indices integer[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare selected_room public.rooms;
declare member public.room_members;
declare coin_positions integer[] := array[350, 950, 1650, 2350, 3100, 3850, 4650, 5400];
declare coin_index integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if new_progress not between 0 and 6000 then raise exception 'Invalid race progress'; end if;
  if coalesce(cardinality(new_coin_indices), 0) > 8 then raise exception 'Invalid coin list'; end if;
  select * into selected_room from public.rooms
    where code = upper(trim(room_code));
  if not found or selected_room.status <> 'race' or selected_room.race_started_at is null then
    raise exception 'Race is not active';
  end if;
  select * into member from public.room_members
    where room_id = selected_room.id and user_id = auth.uid() for update;
  if not found then raise exception 'You are not in this room'; end if;
  if new_progress < member.race_progress then raise exception 'Race progress cannot go backwards'; end if;
  if new_progress > floor(extract(epoch from (now() - selected_room.race_started_at)) * 650 + 100)::integer then
    raise exception 'Race progress is faster than the maximum game speed';
  end if;
  if coalesce(cardinality(new_coin_indices), 0) <>
    (select count(distinct requested.idx) from unnest(coalesce(new_coin_indices, '{}')) as requested(idx)) then
    raise exception 'Duplicate coin pickup';
  end if;
  foreach coin_index in array coalesce(new_coin_indices, '{}') loop
    if coin_index < 0 or coin_index >= cardinality(coin_positions) then
      raise exception 'Unknown coin pickup';
    end if;
    if coin_positions[coin_index + 1] > new_progress
      or coin_positions[coin_index + 1] <= member.race_progress
      or coin_index = any(member.collected_coin_indices) then
      raise exception 'Coin pickup is not valid at this progress';
    end if;
  end loop;
  update public.room_members set race_progress = new_progress,
    collected_coin_indices = array(
      select distinct picked from unnest(
        member.collected_coin_indices || coalesce(new_coin_indices, '{}')
      ) as coins(picked)
    )
    where room_id = selected_room.id and user_id = auth.uid();
end;
$$;

drop function if exists public.finish_race(text, integer);
create or replace function public.finish_race(room_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare selected_room public.rooms;
declare member public.room_members;
declare placement integer;
declare prize integer;
declare points integer;
declare multiplier integer;
declare collected_coins integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into selected_room from public.rooms
    where code = upper(trim(room_code)) for update;
  if not found or selected_room.status <> 'race' then raise exception 'Race is not active'; end if;
  select * into member from public.room_members
    where room_id = selected_room.id and user_id = auth.uid() for update;
  if not found then raise exception 'You are not in this room'; end if;
  if member.finish_place is not null then raise exception 'You already finished this race'; end if;
  if member.race_progress < 6000 then raise exception 'Reach the finish line before claiming your result'; end if;
  collected_coins := cardinality(member.collected_coin_indices);
  select count(*) + 1 into placement from public.room_members
    where room_id = selected_room.id and finish_place is not null;
  placement := placement + public.bots_finished_by(
    selected_room.bot_count, selected_room.race_started_at, now());
  multiplier := case
    when 'double_coins' = any(member.active_buffs) then 2
    else 1 end;
  prize := (500 + collected_coins * 100) * multiplier;
  points := case placement when 1 then 3 when 2 then 2 when 3 then 1 else 0 end;
  update public.room_members set finish_place = placement, finished_at = now()
    where room_id = selected_room.id and user_id = auth.uid();
  update public.profiles set coins = coins + prize, stat_points = stat_points + points,
    updated_at = now() where id = auth.uid();
  if (select count(*) from public.room_members
      where room_id = selected_room.id and finish_place is null) = 0 then
    update public.rooms set status = 'finished', updated_at = now() where id = selected_room.id;
  end if;
  return jsonb_build_object('place', placement, 'coins', prize, 'stat_points', points);
end;
$$;

create or replace function public.leave_room(room_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare selected_room public.rooms;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into selected_room from public.rooms where code = upper(trim(room_code)) for update;
  if not found then return; end if;
  if selected_room.host_id = auth.uid() then
    delete from public.rooms where id = selected_room.id;
  else
    delete from public.room_members where room_id = selected_room.id and user_id = auth.uid();
  end if;
end;
$$;

create or replace function public.return_to_lobby(room_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare selected_room public.rooms;
begin
  select * into selected_room from public.rooms
    where code = upper(trim(room_code)) for update;
  if not found or selected_room.host_id <> auth.uid() then raise exception 'Only the host can reset the room'; end if;
  if selected_room.status <> 'finished' then raise exception 'Race has not finished'; end if;
  update public.rooms set status = 'lobby', race_id = null, race_started_at = null,
    updated_at = now() where id = selected_room.id;
  update public.room_members set finish_place = null, finished_at = null, active_buffs = '{}',
    race_progress = 0, collected_coin_indices = '{}' where room_id = selected_room.id;
end;
$$;

create or replace function public.set_bot_count(room_code text, new_count integer)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare selected_room public.rooms;
declare humans integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into selected_room from public.rooms
    where code = upper(trim(room_code)) for update;
  if not found or selected_room.host_id <> auth.uid() then raise exception 'Only the room host can change bots'; end if;
  if selected_room.status <> 'lobby' then raise exception 'Bots can only change in the lobby'; end if;
  select count(*) into humans from public.room_members where room_id = selected_room.id;
  if new_count < 0 or new_count > 15 - humans then
    raise exception 'Rooms hold 15 racers, so you can add up to % bots', 15 - humans;
  end if;
  update public.rooms set bot_count = new_count, updated_at = now()
    where id = selected_room.id returning * into selected_room;
  return selected_room;
end;
$$;

revoke all on function public.set_bot_count(text, integer) from public, anon;
grant execute on function public.set_bot_count(text, integer) to authenticated;
revoke all on function public.bots_finished_by(integer, timestamptz, timestamptz) from public, anon;

revoke all on function public.ensure_profile() from public, anon;
revoke all on function public.update_profile_name(text) from public, anon;
revoke all on function public.create_room() from public, anon;
revoke all on function public.join_room(text) from public, anon;
revoke all on function public.get_room_players(uuid) from public, anon;
revoke all on function public.set_character(text) from public, anon;
revoke all on function public.buy_buff(text, boolean) from public, anon;
revoke all on function public.upgrade_stat(text) from public, anon;
revoke all on function public.start_race(text) from public, anon;
revoke all on function public.update_race_progress(text, integer, integer[]) from public, anon;
revoke all on function public.finish_race(text) from public, anon;
revoke all on function public.return_to_lobby(text) from public, anon;
revoke all on function public.leave_room(text) from public, anon;
grant execute on function public.ensure_profile() to authenticated;
grant execute on function public.update_profile_name(text) to authenticated;
grant execute on function public.create_room() to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.get_room_players(uuid) to authenticated;
grant execute on function public.set_character(text) to authenticated;
grant execute on function public.buy_buff(text, boolean) to authenticated;
grant execute on function public.upgrade_stat(text) to authenticated;
grant execute on function public.start_race(text) to authenticated;
grant execute on function public.update_race_progress(text, integer, integer[]) to authenticated;
grant execute on function public.finish_race(text) to authenticated;
grant execute on function public.return_to_lobby(text) to authenticated;
grant execute on function public.leave_room(text) to authenticated;
grant select on public.rooms to authenticated;
