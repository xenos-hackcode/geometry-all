import { createClient } from "@supabase/supabase-js";
import {
  COIN_POSITIONS,
  INVINCIBILITY_SECONDS,
  JUMP_DURATION,
  OBSTACLE_POSITIONS,
  TRACK_LENGTH,
  BOT_NAMES,
  MAX_RACERS,
  botFinishSeconds,
  botSpeed,
  botProgress,
  getRaceStats,
  maxBots,
  raceSeed,
} from "./race-engine.js";
import "./style.css";

const CHARACTERS = [
  { id: "comet", name: "Comet", color: "#72f2c4", shape: "diamond" },
  { id: "prism", name: "Prism", color: "#a78bfa", shape: "triangle" },
  { id: "orbit", name: "Orbit", color: "#66c7ff", shape: "ring" },
  { id: "spark", name: "Spark", color: "#ffd166", shape: "star" },
  { id: "nova", name: "Nova", color: "#ff7eb6", shape: "hex" },
  { id: "puddle", name: "Puddle", color: "#ff9770", shape: "blob" },
];

const BUFFS = [
  { id: "speed", name: "Speed boost", description: "Move 30% faster for one race. Permanent: always faster." },
  { id: "jump", name: "Super jump", description: "Jump higher for one race. Permanent: always jump higher." },
  { id: "shield", name: "30-second shield", description: "Ignore every obstacle for the first 30 seconds." },
  { id: "double_coins", name: "Double coins", description: "Earn twice as many race coins." },
];

const root = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
const env = import.meta.env;
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY;
let db;
let subscription;
let pollTimer;
let resizeObserver;
let animationFrame;
let removeCanvasKey;

const state = {
  screen: "home",
  profile: null,
  user: null,
  room: null,
  players: [],
  notice: null,
  busy: false,
  profileTab: "stats",
  result: null,
  runner: null,
  remoteRunners: new Map(),
  raceBuffs: [],
  roomSyncing: false,
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function money(value) {
  return new Intl.NumberFormat().format(value);
}

function setNotice(text, error = false) {
  state.notice = text ? { text, error } : null;
  const notice = document.querySelector("#notice");
  if (!notice) return;
  notice.textContent = text ?? "";
  notice.classList.toggle("error", Boolean(error));
  notice.hidden = !text;
}

async function action(callback) {
  if (state.busy) return;
  state.busy = true;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  try {
    await callback();
  } catch (error) {
    setNotice(error?.message ?? "Something went wrong. Please try again.", true);
  } finally {
    state.busy = false;
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
  }
}

function rpcValue(data) {
  if (Array.isArray(data)) return data[0];
  return data;
}

async function rpc(name, args = {}) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

async function refreshProfile() {
  state.profile = rpcValue(await rpc("ensure_profile"));
  if (state.profile?.id !== state.user?.id) throw new Error("Could not load your player profile.");
}

function character(id) {
  return CHARACTERS.find((item) => item.id === id) ?? CHARACTERS[0];
}

function botCount() {
  return Math.max(0, Math.min(state.room?.bot_count ?? 0, maxBots(state.players.length)));
}

function bots() {
  return Array.from({ length: botCount() }, (_, index) => ({
    index,
    name: `${BOT_NAMES[index % BOT_NAMES.length]} (bot)`,
    character: CHARACTERS[(index + 2) % CHARACTERS.length],
  }));
}

function raceElapsedSeconds() {
  if (!state.room?.race_started_at) return 0;
  return Math.max(0, (Date.now() - Date.parse(state.room.race_started_at)) / 1000);
}

async function setBots(count) {
  const room = rpcValue(await rpc("set_bot_count", { room_code: state.room.code, new_count: count }));
  state.room = { ...state.room, ...room };
  await subscription?.send({ type: "broadcast", event: "room-changed", payload: {} });
  renderRoom();
}

// ---------- Jotter Note: the notebook you see first ----------

const NOTES_KEY = "jotter-note:notes";
const notebook = { notes: loadNotes(), activeId: null };

function loadNotes() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTES_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveNotes() {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notebook.notes));
    return true;
  } catch {
    return false;
  }
}

function newNote() {
  const note = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: "",
    body: "",
    updated: Date.now(),
  };
  notebook.notes.unshift(note);
  notebook.activeId = note.id;
  saveNotes();
  return note;
}

function noteLabel(note) {
  return note.title.trim() || note.body.trim().split("\n")[0].slice(0, 40) || "Untitled note";
}

function noteDate(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(timestamp);
}

function wordCount(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return `${words} word${words === 1 ? "" : "s"}`;
}

function renderNotebook() {
  state.screen = "notebook";
  document.body.classList.add("notebook-mode");
  if (!notebook.notes.length) newNote();
  if (!notebook.notes.some((note) => note.id === notebook.activeId)) {
    notebook.activeId = [...notebook.notes].sort((a, b) => b.updated - a.updated)[0].id;
  }
  const active = notebook.notes.find((note) => note.id === notebook.activeId);
  const sorted = [...notebook.notes].sort((a, b) => b.updated - a.updated);
  root.innerHTML = `
    <div class="nb-shell">
      <header class="nb-topbar">
        <div class="nb-brand"><span class="nb-mark">✎</span>Jotter Note</div>
        <div class="nb-actions">
          <button class="nb-button" id="nb-new">+ New note</button>
          <button class="nb-button nb-read" id="nb-read" title="Open the fun side">Read</button>
        </div>
      </header>
      <div class="nb-layout">
        <aside class="nb-sidebar">
          <input class="nb-search" id="nb-search" type="search" placeholder="Search notes" aria-label="Search notes">
          <ul class="nb-list">${sorted.map((note) => `
            <li data-note-item="${escapeHtml(note.id)}">
              <button class="nb-item${note.id === active.id ? " active" : ""}" data-note="${escapeHtml(note.id)}">
                <span class="nb-item-title">${escapeHtml(noteLabel(note))}</span>
                <span class="nb-item-date">${noteDate(note.updated)}</span>
              </button>
            </li>`).join("")}
          </ul>
          <p class="nb-empty" id="nb-empty" hidden>No notes match.</p>
        </aside>
        <section class="nb-page">
          <input class="nb-title" id="nb-title" placeholder="Title" maxlength="120" value="${escapeHtml(active.title)}" aria-label="Note title">
          <p class="nb-meta"><span id="nb-saved">Saved</span> · <span id="nb-count">${wordCount(active.body)}</span></p>
          <textarea class="nb-body" id="nb-body" placeholder="Start writing…" aria-label="Note">${escapeHtml(active.body)}</textarea>
          <div class="nb-footer">
            <span class="nb-hint">Notes are saved in this browser.</span>
            <button class="nb-button nb-danger" id="nb-delete">Delete note</button>
          </div>
        </section>
      </div>
    </div>`;

  const titleInput = document.querySelector("#nb-title");
  const bodyInput = document.querySelector("#nb-body");
  const savedLabel = document.querySelector("#nb-saved");
  const onEdit = () => {
    active.title = titleInput.value;
    active.body = bodyInput.value;
    active.updated = Date.now();
    savedLabel.textContent = saveNotes() ? "Saved" : "Could not save (storage is blocked)";
    document.querySelector("#nb-count").textContent = wordCount(active.body);
    const item = document.querySelector(`[data-note="${CSS.escape(active.id)}"]`);
    if (item) {
      item.querySelector(".nb-item-title").textContent = noteLabel(active);
      item.querySelector(".nb-item-date").textContent = noteDate(active.updated);
    }
  };
  titleInput.addEventListener("input", onEdit);
  bodyInput.addEventListener("input", onEdit);

  document.querySelectorAll("[data-note]").forEach((button) => {
    button.addEventListener("click", () => {
      notebook.activeId = button.dataset.note;
      renderNotebook();
    });
  });
  document.querySelector("#nb-new").addEventListener("click", () => {
    newNote();
    renderNotebook();
    document.querySelector("#nb-title")?.focus();
  });
  document.querySelector("#nb-delete").addEventListener("click", () => {
    if (!window.confirm(`Delete "${noteLabel(active)}"?`)) return;
    notebook.notes = notebook.notes.filter((note) => note.id !== active.id);
    notebook.activeId = null;
    saveNotes();
    renderNotebook();
  });
  document.querySelector("#nb-search").addEventListener("input", (event) => {
    const query = event.currentTarget.value.trim().toLowerCase();
    let shown = 0;
    notebook.notes.forEach((note) => {
      const row = document.querySelector(`[data-note-item="${CSS.escape(note.id)}"]`);
      const match = !query || `${note.title}\n${note.body}`.toLowerCase().includes(query);
      if (row) row.hidden = !match;
      if (match) shown += 1;
    });
    document.querySelector("#nb-empty").hidden = shown > 0;
  });
  document.querySelector("#nb-read").addEventListener("click", openGame);
}

// ---------- The fun side (Neon Dash) ----------

function openGame() {
  document.body.classList.remove("notebook-mode");
  if (!supabaseUrl || !supabaseKey) {
    renderSetup();
    return;
  }
  if (state.profile) {
    renderHome();
    return;
  }
  if (!db) {
    db = createClient(supabaseUrl, supabaseKey, {
      realtime: { params: { eventsPerSecond: 15 } },
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  root.innerHTML = '<main class="loading"><p>Loading the fun side…</p></main>';
  void initializeSession();
}

function initPage() {
  // Invite links go straight to the game; everyone else lands in the notebook.
  if (params.get("room")) openGame();
  else renderNotebook();
}

async function initializeSession() {
  try {
    const { data: { session }, error } = await db.auth.getSession();
    if (error) throw error;
    if (session?.user) {
      state.user = session.user;
    } else {
      const { data, error: signInError } = await db.auth.signInAnonymously();
      if (signInError) throw signInError;
      state.user = data.user;
    }
    await refreshProfile();
    renderHome();
    const requestedRoom = params.get("room");
    if (requestedRoom) {
      await joinRoom(requestedRoom);
    }
  } catch (error) {
    renderError(error?.message ?? "Could not connect to the game service.");
  }
}

function renderSetup() {
  root.innerHTML = `
    <div class="shell">
      <header class="topbar"><a class="brand" href="/"><span class="brand-mark">◇</span><span class="brand-name">Neon Dash</span></a></header>
      <section class="panel">
        <p class="eyebrow">One quick setup step</p>
        <h1>Connect your game server</h1>
        <p class="lead">This original multiplayer game needs your Supabase project before it can create online rooms.</p>
        <div class="card">
          <h3>Configure the project</h3>
          <ol class="hint">
            <li>Create a Supabase project and run <code>schema.sql</code> in its SQL Editor.</li>
            <li>Enable anonymous sign-ins in Authentication settings.</li>
            <li>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in your local <code>.env.local</code> and Vercel project settings.</li>
            <li>Build and deploy. Your classmates can then share six-character room codes.</li>
          </ol>
          <p class="hint">Never put a Supabase service-role key in the browser or a <code>VITE_</code> variable.</p>
          <a class="button button-secondary" href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Open Supabase dashboard</a>
        </div>
      </section>
      <p class="footer">Vercel hosts the site; Supabase provides realtime rooms and player profiles.</p>
    </div>`;
}

function renderError(message) {
  root.innerHTML = `
    <div class="shell">
      <header class="topbar"><a class="brand" href="/"><span class="brand-mark">◇</span><span class="brand-name">Neon Dash</span></a></header>
      <section class="panel">
        <p class="eyebrow">Connection issue</p>
        <h1>Could not enter the game</h1>
        <div class="notice error">${escapeHtml(message)}</div>
        <p class="hint">Check that Supabase is configured, anonymous sign-in is enabled, and <code>schema.sql</code> has been run.</p>
        <button class="button button-secondary" id="retry">Try again</button>
      </section>
    </div>`;
  document.querySelector("#retry").addEventListener("click", () => void initializeSession());
}

function topbar(showCoins = true) {
  const playerName = state.profile?.display_name || "Runner";
  return `
    <header class="topbar">
      <a class="brand" href="/" data-action="home"><span class="brand-mark">◇</span><span class="brand-name">Neon Dash</span></a>
      <div class="top-actions">
        <button class="button button-quiet button-small" data-action="notes">✎ Notes</button>
        ${showCoins && state.profile ? `<span class="coin-pill">✦ ${money(state.profile.coins)} coins</span>` : ""}
        ${state.profile ? `<button class="button button-quiet button-small" data-action="profile">Hi, ${escapeHtml(playerName)}</button>` : ""}
      </div>
    </header>`;
}

function noticeMarkup() {
  return `<div id="notice" class="notice${state.notice?.error ? " error" : ""}"${state.notice ? "" : " hidden"}>${escapeHtml(state.notice?.text ?? "")}</div>`;
}

function renderHome() {
  state.screen = "home";
  root.innerHTML = `
    <div class="shell">
      ${topbar()}
      ${noticeMarkup()}
      <section class="panel hero">
        <div class="hero-copy">
          <p class="eyebrow">A tiny online race for your class</p>
          <h1>Pick a shape.<br>Race your friends.</h1>
          <p class="lead">Create a room, share the code, then race through a fresh neon track. Every original geometric character is available right away.</p>
          <div class="hero-actions">
            <button class="button button-primary" data-action="create-room">Create a room</button>
            <button class="button button-secondary" data-action="profile">Player profile</button>
          </div>
        </div>
      </section>
      <section class="grid">
        <article class="card">
          <p class="eyebrow">Join your class</p><h3>Got an invite code?</h3>
          <p class="hint">Enter the six-character room code your host shared with you.</p>
          <form id="join-form" class="row">
            <input class="code-input" name="code" maxlength="6" minlength="6" autocomplete="off" placeholder="ABC123" aria-label="Room code" required>
            <button class="button button-secondary" type="submit">Join room</button>
          </form>
        </article>
        <article class="card">
          <p class="eyebrow">Your player</p><h3>${escapeHtml(state.profile?.display_name)}</h3>
          <p class="hint">Your profile saves coins, stats, characters, and buffs on this device.</p>
          <div class="button-row"><span class="coin-pill">✦ ${money(state.profile?.coins ?? 0)} coins</span><button class="button button-quiet button-small" data-action="profile">Open profile</button></div>
        </article>
      </section>
      <p class="footer">Original game concept and art. Online rooms need the configured Supabase project.</p>
    </div>`;
  bindCommon();
  document.querySelector("#join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("code");
    void action(() => joinRoom(code));
  });
}

async function createRoom() {
  const room = rpcValue(await rpc("create_room"));
  if (!room?.id || !room?.code) throw new Error("The room could not be created.");
  await enterRoom(room);
}

async function joinRoom(code) {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(normalized)) throw new Error("Enter a six-character room code.");
  const room = rpcValue(await rpc("join_room", { room_code: normalized }));
  if (!room?.id) throw new Error("Could not join this room.");
  await enterRoom(room);
}

async function enterRoom(room) {
  clearRoom();
  state.room = room;
  state.result = null;
  state.remoteRunners.clear();
  await refreshPlayers();
  await subscribeRoom();
  await syncRoom();
  if (state.room) {
    renderRoom();
    void updateInviteUrl();
  }
}

function clearRoom() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  if (subscription) {
    void db.removeChannel(subscription);
    subscription = null;
  }
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  removeCanvasKey?.();
  removeCanvasKey = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  state.runner = null;
  state.roomSyncing = false;
}

async function leaveRoom() {
  clearRoom();
  if (state.room?.code) {
    await rpc("leave_room", { room_code: state.room.code });
  }
  state.room = null;
  state.players = [];
  history.replaceState(null, "", "/");
  renderHome();
}

async function updateInviteUrl() {
  const link = document.querySelector("#invite-link");
  if (!link || !state.room) return;
  link.value = `${window.location.origin}/?room=${encodeURIComponent(state.room.code)}`;
}

async function refreshPlayers() {
  if (!state.room) return;
  state.players = await rpc("get_room_players", { room_id: state.room.id });
}

async function subscribeRoom() {
  if (!state.room) return;
  const topic = `room:${state.room.id}`;
  subscription = db.channel(topic, {
    config: { private: true, presence: { key: state.user.id } },
  });
  subscription
    .on("broadcast", { event: "runner" }, ({ payload }) => {
      if (payload?.user_id && payload.user_id !== state.user.id) {
        state.remoteRunners.set(payload.user_id, payload);
      }
    })
    .on("broadcast", { event: "room-changed" }, () => void refreshPlayers().then(() => renderRoom()))
    .on("broadcast", { event: "race-start" }, () => void syncRoom())
    .on("broadcast", { event: "race-finish" }, () => void syncRoom())
    .on("presence", { event: "sync" }, () => void refreshPlayers().then(() => renderRoom()));
  const status = await new Promise((resolve) => {
    subscription.subscribe((currentStatus) => {
      if (currentStatus === "SUBSCRIBED") {
        void subscription.track({
          user_id: state.user.id,
          name: state.profile.display_name,
          character_id: state.profile.character_id,
        });
        resolve(currentStatus);
      } else if (currentStatus === "CHANNEL_ERROR" || currentStatus === "TIMED_OUT") {
        resolve(currentStatus);
      }
    });
    window.setTimeout(() => resolve("TIMED_OUT"), 8000);
  });
  if (status !== "SUBSCRIBED") {
    throw new Error("Room realtime connection failed. Check Supabase Realtime and run the room security policies from schema.sql.");
  }
  pollTimer = window.setInterval(() => void syncRoom(), 1500);
}

async function syncRoom() {
  if (!state.room || state.roomSyncing) return;
  state.roomSyncing = true;
  try {
    const { data, error } = await db.from("rooms").select("id,code,host_id,status,bot_count,race_started_at").eq("id", state.room.id).single();
    if (error) throw error;
    state.room = { ...state.room, ...data };
    await refreshPlayers();
    if (data.status === "race" && !["race", "profile", "results"].includes(state.screen)) {
      beginRace();
    } else if (data.status === "finished" && state.runner?.finished &&
      ["race", "results"].includes(state.screen)) {
      renderResults();
    } else if (data.status === "lobby" && !["room", "profile"].includes(state.screen)) {
      state.screen = "room";
      renderRoom();
    } else if (state.screen === "room") {
      renderRoom();
    }
  } catch (error) {
    if (!String(error?.message).includes("No rows")) setNotice(error?.message ?? "Room sync failed.", true);
  } finally {
    state.roomSyncing = false;
  }
}

function renderRoom() {
  if (!state.room) return;
  state.screen = "room";
  const host = state.room.host_id === state.user.id;
  const selected = character(state.profile.character_id);
  const players = state.players.map((player) => {
    const avatar = character(player.character_id);
    return `<li class="list-item">
      <span class="player-name"><span class="avatar" style="--avatar:${avatar.color}"></span>${escapeHtml(player.display_name)}
        ${player.user_id === state.room.host_id ? '<span class="badge">HOST</span>' : ""}
      </span>
      <span class="badge">${avatar.name}</span>
    </li>`;
  }).join("") + bots().map((bot) => `<li class="list-item">
      <span class="player-name"><span class="avatar" style="--avatar:${bot.character.color}"></span>${escapeHtml(bot.name)}</span>
      <span class="badge">BOT</span>
    </li>`).join("");
  const racerCount = state.players.length + botCount();
  const botLimit = maxBots(state.players.length);
  const botPicker = host && state.room.status === "lobby" ? `
    <div class="bot-picker">
      <div><h3>Bots</h3><p class="hint">No one around? Fill empty seats with bots (up to ${botLimit}).</p></div>
      <div class="row">
        <button class="button button-secondary button-small" data-bots="${botCount() - 1}" ${botCount() <= 0 ? "disabled" : ""} aria-label="Remove a bot">−</button>
        <span class="bot-count">${botCount()}</span>
        <button class="button button-secondary button-small" data-bots="${botCount() + 1}" ${botCount() >= botLimit ? "disabled" : ""} aria-label="Add a bot">+</button>
        <button class="button button-quiet button-small" data-bots="${botLimit}" ${botCount() >= botLimit ? "disabled" : ""}>Fill all</button>
      </div>
    </div>` : "";
  root.innerHTML = `
    <div class="shell">
      ${topbar()}
      ${noticeMarkup()}
      <section class="panel">
        <p class="eyebrow">${state.room.status === "race" ? "Race is live" : "Lobby is open"}</p>
        <div class="row" style="justify-content:space-between">
          <div><h1 style="font-size:clamp(34px,6vw,52px)">Room <span class="room-code">${escapeHtml(state.room.code)}</span></h1>
            <p class="lead">Share the invite link or code with friends. Up to ${MAX_RACERS} racers, and bots fill any empty seats.</p></div>
          <div class="button-row"><button class="button button-secondary button-small" data-action="copy-link">Copy invite link</button><button class="button button-quiet button-small" data-action="profile">Profile</button></div>
        </div>
        <label class="field" style="max-width:560px">Invite link
          <input class="text-input mono" id="invite-link" readonly value="">
        </label>
        <div class="grid">
          <article class="card">
            <div class="row" style="justify-content:space-between"><h3>Racers</h3><span class="badge">${racerCount}/${MAX_RACERS}</span></div>
            <ul class="list">${players || '<li class="hint">Waiting for racers…</li>'}</ul>
            ${botPicker}
          </article>
          <article class="card">
            <p class="eyebrow">Your character</p><h3>${selected.name} <span class="badge">UNLOCKED</span></h3>
            <p class="hint">Choose any original shape. Every character is available from the start.</p>
            <div class="character-grid">${CHARACTERS.map((item) => `
              <button class="character${item.id === state.profile.character_id ? " selected" : ""}" data-character="${item.id}">
                <span class="avatar" style="--avatar:${item.color}"></span>${item.name}
              </button>`).join("")}</div>
          </article>
        </div>
        <div class="button-row" style="margin-top:20px">
          ${host ? `<button class="button button-primary" data-action="start-race" ${racerCount < 2 || state.room.status !== "lobby" ? "disabled" : ""}>${state.room.status === "race" ? "Race starting…" : "Start race"}</button>` : '<span class="hint">Waiting for the host to start the race…</span>'}
          ${host && racerCount < 2 ? '<span class="hint">Add at least one bot to race solo.</span>' : ""}
          <button class="button button-quiet" data-action="leave-room">Leave room</button>
        </div>
      </section>
      <p class="footer">Classmates can join from their own devices once the Vercel site and Supabase project are configured.</p>
    </div>`;
  bindCommon();
  void updateInviteUrl();
  document.querySelectorAll("[data-character]").forEach((button) => {
    button.addEventListener("click", () => void action(async () => {
      state.profile = rpcValue(await rpc("set_character", { new_character: button.dataset.character }));
      renderRoom();
    }));
  });
  document.querySelectorAll("[data-bots]").forEach((button) => {
    button.addEventListener("click", () => void action(() => setBots(Number(button.dataset.bots))));
  });
}

async function copyInvite() {
  const invite = `${window.location.origin}/?room=${encodeURIComponent(state.room.code)}`;
  await navigator.clipboard.writeText(invite);
  setNotice("Invite link copied. Send it to your classmates.");
}

async function startRace() {
  const raceBuffs = [
    ...(state.profile.permanent_buffs ?? []),
    ...(state.profile.temporary_buffs ?? []).map((buff) => `${buff}_temp`),
  ];
  await rpc("start_race", { room_code: state.room.code });
  state.raceBuffs = raceBuffs;
  await subscription.send({ type: "broadcast", event: "race-start", payload: { started_by: state.user.id } });
  beginRace();
}

function beginRace() {
  if (state.screen === "race" || !state.room) return;
  state.screen = "race";
  const avatar = character(state.profile.character_id);
  state.raceBuffs = state.raceBuffs.length
    ? state.raceBuffs
    : [...(state.profile.permanent_buffs ?? []), ...(state.profile.temporary_buffs ?? []).map((buff) => `${buff}_temp`)];
  state.runner = {
    progress: 0,
    pickups: 0,
    collected: new Set(),
    savedCoinIndices: new Set(),
    progressRequest: null,
    jumpingUntil: 0,
    jumpOrigin: 0,
    lastFrame: performance.now(),
    lastBroadcast: 0,
    slowUntil: 0,
    startTime: performance.now(),
    finished: false,
    place: null,
    character: avatar,
    stats: getRaceStats(state.profile, state.raceBuffs),
  };
  state.remoteRunners.clear();
  renderRace();
}

function bindCanvasInput(canvas) {
  const jump = (event) => {
    if (event) event.preventDefault();
    if (state.screen !== "race" || !state.runner || state.runner.finished) return;
    const now = performance.now();
    if (now > state.runner.jumpingUntil) {
      state.runner.jumpOrigin = now;
      state.runner.jumpingUntil = now + JUMP_DURATION * 1000;
    }
  };
  canvas.addEventListener("pointerdown", jump);
  const onKey = (event) => {
    if (["Space", "ArrowUp", "KeyW"].includes(event.code) && state.screen === "race") jump(event);
  };
  window.addEventListener("keydown", onKey);
  removeCanvasKey = () => window.removeEventListener("keydown", onKey);
  canvas.focus();
}

function renderRace() {
  root.innerHTML = `
    <div class="shell">
      ${topbar(false)}
      ${noticeMarkup()}
      <section class="panel">
        <div class="row" style="justify-content:space-between">
          <div><p class="eyebrow">Multiplayer race · Room ${escapeHtml(state.room.code)}</p><h2>Run your own line.</h2></div>
          <span class="coin-pill">✦ ${state.runner.pickups} pickups</span>
        </div>
        <p class="hint">Tap, click, press Space, or use ↑ to jump over spikes. Pick up coins as you race.</p>
        <div class="game-wrap">
          <canvas class="game-canvas" id="race-canvas" tabindex="0" aria-label="Neon Dash race. Press Space or click to jump."></canvas>
          <div class="game-controls"><span class="race-status" id="race-status">Ready, set, run!</span><span>✦ ${state.runner.pickups} / ${COIN_POSITIONS.length} coins · ${Math.max(0, Math.ceil(INVINCIBILITY_SECONDS - (performance.now() - state.runner.startTime) / 1000))}s shield</span></div>
        </div>
        <div class="button-row" style="margin-top:14px"><button class="button button-quiet button-small" data-action="leave-room">Leave race</button></div>
      </section>
    </div>`;
  bindCommon();
  const canvas = document.querySelector("#race-canvas");
  bindCanvasInput(canvas);
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => resizeCanvas(canvas));
  resizeObserver.observe(canvas);
  resizeCanvas(canvas);
  animationFrame = requestAnimationFrame((time) => tickRace(time, canvas));
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawAvatar(context, actor, x, y, size, rotation = 0) {
  const c = actor.character ?? character(actor.character_id);
  context.save();
  context.translate(x, y);
  if (rotation) context.rotate(rotation);
  context.shadowColor = c.color;
  context.shadowBlur = 17;
  context.fillStyle = c.color;
  context.strokeStyle = "#f4fbff";
  context.lineWidth = 2;
  context.beginPath();
  if (c.shape === "triangle") {
    context.moveTo(0, -size); context.lineTo(size, size * 0.8); context.lineTo(-size, size * 0.8); context.closePath();
  } else if (c.shape === "ring") {
    context.arc(0, 0, size * 0.76, 0, Math.PI * 2);
    context.arc(0, 0, size * 0.34, 0, Math.PI * 2, true);
  } else if (c.shape === "star") {
    for (let point = 0; point < 10; point += 1) {
      const radius = point % 2 === 0 ? size : size * 0.45;
      const angle = -Math.PI / 2 + point * Math.PI / 5;
      const px = Math.cos(angle) * radius;
      const py = Math.sin(angle) * radius;
      if (!point) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.closePath();
  } else if (c.shape === "hex") {
    for (let point = 0; point < 6; point += 1) {
      const angle = -Math.PI / 2 + point * Math.PI / 3;
      const px = Math.cos(angle) * size;
      const py = Math.sin(angle) * size;
      if (!point) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.closePath();
  } else if (c.shape === "blob") {
    context.ellipse(0, 0, size, size * 0.76, 0, 0, Math.PI * 2);
  } else {
    context.moveTo(0, -size); context.lineTo(size * 0.85, 0); context.lineTo(0, size); context.lineTo(-size * 0.85, 0); context.closePath();
  }
  context.fill();
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = "#152039";
  context.beginPath(); context.arc(-size * 0.2, -size * 0.1, size * 0.09, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.arc(size * 0.2, -size * 0.1, size * 0.09, 0, Math.PI * 2); context.fill();
  context.strokeStyle = "#152039";
  context.lineWidth = 1.5;
  context.beginPath(); context.arc(0, size * 0.08, size * 0.22, 0.2, Math.PI - 0.2); context.stroke();
  context.restore();
}

function drawSpike(context, x, ground, size) {
  context.save();
  context.shadowColor = "#ff5d8f";
  context.shadowBlur = 14;
  context.fillStyle = "#1a0f24";
  context.strokeStyle = "#ff7aa8";
  context.lineWidth = 2.5;
  context.beginPath();
  context.moveTo(x - size / 2, ground);
  context.lineTo(x, ground - size);
  context.lineTo(x + size / 2, ground);
  context.closePath();
  context.fill();
  context.stroke();
  context.restore();
}

function drawCoin(context, x, y) {
  context.shadowColor = "#ffd166";
  context.shadowBlur = 14;
  context.fillStyle = "#ffd166";
  context.strokeStyle = "#fff2bc";
  context.lineWidth = 2;
  context.beginPath(); context.arc(x, y, 9, 0, Math.PI * 2); context.fill(); context.stroke();
  context.fillStyle = "#875b18";
  context.font = "bold 10px sans-serif";
  context.textAlign = "center"; context.textBaseline = "middle"; context.fillText("✦", x, y + 0.5);
  context.shadowBlur = 0;
}

// Jump phase (0..1) for a runner that auto-jumps every spike, used for bots.
function autoJumpPhase(progress, speed) {
  const halfJump = (speed * JUMP_DURATION) / 2;
  for (const spike of OBSTACLE_POSITIONS) {
    const distance = progress - (spike - halfJump);
    if (distance >= 0 && distance <= halfJump * 2) return distance / (halfJump * 2);
  }
  return null;
}

const DEFAULT_JUMP_HEIGHT = 120;

function drawRace(canvas, now) {
  const context = canvas.getContext("2d");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return;
  const local = state.runner;
  const scale = Math.max(0.75, Math.min(1.35, height / 380));
  const unitsPerPixel = 1550 / Math.max(1, width - 40);
  const runnerX = Math.min(170, width * 0.24);
  const ground = height - Math.round(56 * scale);
  const worldX = (world) => runnerX + (world - local.progress) / unitsPerPixel;
  const scroll = local.progress / unitsPerPixel;

  // Sky + scrolling grid (parallax)
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#1b1140");
  sky.addColorStop(0.6, "#122a5c");
  sky.addColorStop(1, "#0d1a3a");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);
  const cell = 46 * scale;
  context.strokeStyle = "#ffffff10";
  context.lineWidth = 1;
  const gridOffset = (scroll * 0.25) % cell;
  for (let x = -gridOffset; x < width; x += cell) {
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, ground); context.stroke();
  }
  for (let y = ground - cell; y > 0; y -= cell) {
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }

  // Floor: tiled blocks
  context.fillStyle = "#0a1430";
  context.fillRect(0, ground, width, height - ground);
  context.strokeStyle = "#72f2c4";
  context.lineWidth = 3;
  context.shadowColor = "#72f2c4";
  context.shadowBlur = 12;
  context.beginPath(); context.moveTo(0, ground); context.lineTo(width, ground); context.stroke();
  context.shadowBlur = 0;
  const tile = 40 * scale;
  context.strokeStyle = "#72f2c42a";
  context.lineWidth = 1.5;
  for (let x = -(scroll % tile); x < width; x += tile) {
    context.strokeRect(x + 2, ground + 4, tile - 4, height - ground - 8);
  }

  // Finish line
  const finishX = worldX(TRACK_LENGTH);
  if (finishX < width + 20) {
    for (let y = 0; y < ground; y += 14) {
      context.fillStyle = (Math.floor(y / 14) % 2) ? "#ffffff" : "#111827";
      context.fillRect(finishX, y, 10, 14);
    }
  }

  // Spikes and coins
  const spikeSize = 30 * scale;
  OBSTACLE_POSITIONS.forEach((world, index) => {
    const x = worldX(world);
    if (x < -40 || x > width + 40) return;
    drawSpike(context, x, ground, spikeSize);
    if (index % 2) drawSpike(context, x + spikeSize * 0.9, ground, spikeSize * 0.85);
  });
  COIN_POSITIONS.forEach((world, index) => {
    const x = worldX(world);
    if (x > -20 && x < width + 20 && !local.collected.has(index)) drawCoin(context, x, ground - 70 * scale);
  });

  // Everyone else on the same track: other players + bots as ghosts
  const elapsed = raceElapsedSeconds();
  const seed = state.room?.race_started_at ? raceSeed(state.room.race_started_at) : 0;
  const others = [
    ...state.players.filter((player) => player.user_id !== state.user.id).map((player) => {
      const remote = state.remoteRunners.get(player.user_id);
      return {
        progress: remote?.progress ?? (player.finish_place ? TRACK_LENGTH : 0),
        jump: typeof remote?.jump === "number" ? remote.jump : null,
        character: character(player.character_id),
        name: player.display_name,
      };
    }),
    ...bots().map((bot) => {
      const progress = botProgress(seed, bot.index, elapsed);
      return {
        progress,
        jump: progress < TRACK_LENGTH ? autoJumpPhase(progress, botSpeed(seed, bot.index)) : null,
        character: bot.character,
        name: bot.name,
      };
    }),
  ];
  const size = 15 * scale;
  context.font = `${Math.round(11 * scale)}px 'DM Mono', monospace`;
  context.textAlign = "center"; context.textBaseline = "bottom";
  const jumping = now < local.jumpingUntil;
  const phase = jumping ? (now - local.jumpOrigin) / (local.jumpingUntil - local.jumpOrigin) : 0;
  const myLift = jumping ? Math.sin(Math.PI * phase) * local.stats.jumpHeight * scale : 0;
  // Name tags skip any spot that would overlap a tag already placed (YOU first).
  const tags = [];
  const tagFits = (x, y, label) => {
    const half = context.measureText(label).width / 2 + 4;
    if (tags.some((tag) => Math.abs(tag.x - x) < tag.half + half && Math.abs(tag.y - y) < 14)) return false;
    tags.push({ x, y, half });
    return true;
  };
  const myTagY = ground - size * 2.4 - 8 - myLift;
  tagFits(runnerX, myTagY, "YOU");
  const placed = others.map((runner) => {
    const x = worldX(runner.progress);
    const lift = runner.jump === null ? 0 : Math.sin(Math.PI * runner.jump) * DEFAULT_JUMP_HEIGHT * scale;
    return { runner, x, lift };
  }).filter(({ x }) => x > -30 && x < width + 30)
    .sort((a, b) => Math.abs(a.x - runnerX) - Math.abs(b.x - runnerX));
  placed.forEach(({ runner, x, lift }) => {
    const spin = runner.jump === null ? 0 : runner.jump * Math.PI;
    context.globalAlpha = 0.45;
    drawAvatar(context, runner, x, ground - size - 2 - lift, size, spin);
  });
  context.globalAlpha = 0.8;
  context.fillStyle = "#d5def0";
  placed.forEach(({ runner, x, lift }) => {
    const label = runner.name.replace(/ \(bot\)$/, "");
    const y = ground - size * 2 - 8 - lift;
    if (tagFits(x, y, label)) context.fillText(label, x, y);
  });
  context.globalAlpha = 1;

  // You
  drawAvatar(context, local, runnerX, ground - size * 1.15 - 2 - myLift, size * 1.15, jumping ? phase * Math.PI : 0);
  context.fillStyle = "#72f2c4";
  context.fillText("YOU", runnerX, myTagY);

  // Progress strip + position
  const stripLeft = 20;
  const stripRight = width - 130;
  const stripY = 18;
  const stripX = (progress) => stripLeft + (stripRight - stripLeft) * (progress / TRACK_LENGTH);
  context.fillStyle = "#ffffff22";
  roundedRect(context, stripLeft, stripY - 3, stripRight - stripLeft, 6, 3);
  context.fill();
  context.fillStyle = "#72f2c4";
  roundedRect(context, stripLeft, stripY - 3, Math.max(6, stripX(local.progress) - stripLeft), 6, 3);
  context.fill();
  others.forEach((runner) => {
    context.fillStyle = runner.character.color;
    context.beginPath(); context.arc(stripX(runner.progress), stripY, 4, 0, Math.PI * 2); context.fill();
  });
  context.fillStyle = "#ffffff";
  context.beginPath(); context.arc(stripX(local.progress), stripY, 6, 0, Math.PI * 2); context.fill();
  const position = 1 + others.filter((runner) => runner.progress > local.progress).length;
  context.font = "bold 13px 'DM Mono', monospace";
  context.textAlign = "right"; context.textBaseline = "middle";
  context.fillStyle = "#ffffff";
  context.fillText(`P${position}/${others.length + 1} · ${Math.floor(Math.min(100, local.progress / TRACK_LENGTH * 100))}%`, width - 16, stripY);
}

async function finishRace() {
  if (!state.runner || state.runner.finished) return;
  state.runner.finished = true;
  try {
    if (state.runner.progressRequest) await state.runner.progressRequest;
    await sendRaceProgress(state.runner, TRACK_LENGTH);
    const result = await rpc("finish_race", {
      room_code: state.room.code,
    });
    state.result = result;
    state.runner.place = result.place;
    state.profile = rpcValue(await rpc("ensure_profile"));
    await subscription.send({ type: "broadcast", event: "race-finish", payload: { user_id: state.user.id, place: result.place } });
    await syncRoom();
    renderResults();
  } catch (error) {
    state.runner.finished = false;
    setNotice(error.message, true);
  }
}

function sendRaceProgress(runner, progress) {
  if (runner.progressRequest) return runner.progressRequest;
  const newCoinIndices = [...runner.collected].filter((index) => !runner.savedCoinIndices.has(index));
  const request = rpc("update_race_progress", {
    room_code: state.room.code,
    new_progress: Math.floor(progress),
    new_coin_indices: newCoinIndices,
  }).then(() => {
    newCoinIndices.forEach((index) => runner.savedCoinIndices.add(index));
  }).catch((error) => {
    setNotice(error?.message ?? "Could not save your race progress.", true);
    throw error;
  }).finally(() => {
    runner.progressRequest = null;
  });
  runner.progressRequest = request;
  return request;
}

function tickRace(now, canvas) {
  if (state.screen !== "race" || !state.runner) return;
  const runner = state.runner;
  const delta = Math.min((now - runner.lastFrame) / 1000, 0.05);
  runner.lastFrame = now;
  const elapsed = (now - runner.startTime) / 1000;
  const shieldActive = runner.stats.invincible && elapsed < INVINCIBILITY_SECONDS;
  const jumpActive = now < runner.jumpingUntil;
  const speed = now < runner.slowUntil ? runner.stats.speed * 0.45 : runner.stats.speed;
  const oldProgress = runner.progress;

  if (!runner.finished) runner.progress = Math.min(TRACK_LENGTH, runner.progress + speed * delta);
  OBSTACLE_POSITIONS.forEach((obstacle, index) => {
    if (oldProgress < obstacle && runner.progress >= obstacle && !jumpActive && !shieldActive) {
      runner.slowUntil = now + 800;
      setNotice("Hit a spike! Jump over the next one.");
      window.setTimeout(() => setNotice(""), 1700);
    }
    if (oldProgress < obstacle && runner.progress >= obstacle && shieldActive) {
      setNotice("Shield blocked an obstacle!");
      window.setTimeout(() => setNotice(""), 1000);
    }
    void index;
  });
  COIN_POSITIONS.forEach((coin, index) => {
    if (!runner.collected.has(index) && oldProgress < coin && runner.progress >= coin) {
      runner.collected.add(index);
      runner.pickups += 1;
    }
  });

  if (now - runner.lastBroadcast > 100 && subscription) {
    runner.lastBroadcast = now;
    void subscription.send({
      type: "broadcast",
      event: "runner",
      payload: {
        user_id: state.user.id,
        progress: runner.progress,
        jump: now < runner.jumpingUntil ? (now - runner.jumpOrigin) / (runner.jumpingUntil - runner.jumpOrigin) : null,
      },
    });
  }
  if (!runner.finished && !runner.progressRequest && now - (runner.lastServerUpdate ?? 0) > 400) {
    runner.lastServerUpdate = now;
    void sendRaceProgress(runner, runner.progress).catch(() => {});
  }
  drawRace(canvas, now);
  const status = document.querySelector("#race-status");
  if (status) status.textContent = runner.progress >= TRACK_LENGTH ? "Finish line!" : shieldActive ? `Shield ${Math.ceil(INVINCIBILITY_SECONDS - elapsed)}s` : "Keep moving!";
  const controls = document.querySelector(".game-controls span:last-child");
  if (controls) controls.textContent = `✦ ${runner.pickups} / ${COIN_POSITIONS.length} coins · ${shieldActive ? Math.ceil(INVINCIBILITY_SECONDS - elapsed) : 0}s shield`;
  if (runner.progress >= TRACK_LENGTH) {
    void finishRace();
    return;
  }
  animationFrame = requestAnimationFrame((time) => tickRace(time, canvas));
}

function standings() {
  const startedAt = state.room?.race_started_at;
  const started = startedAt ? Date.parse(startedAt) : null;
  const seed = startedAt ? raceSeed(startedAt) : 0;
  const elapsed = raceElapsedSeconds();
  const humans = state.players.map((player) => ({
    name: player.display_name,
    color: character(player.character_id).color,
    time: player.finished_at && started ? (Date.parse(player.finished_at) - started) / 1000 : null,
    you: player.user_id === state.user.id,
  }));
  const botRows = bots().map((bot) => {
    const finish = botFinishSeconds(seed, bot.index);
    return { name: bot.name, color: bot.character.color, time: started && finish <= elapsed ? finish : null, bot: true };
  });
  return [...humans, ...botRows].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
}

function renderResults() {
  state.screen = "results";
  const place = state.result?.place ?? state.runner?.place;
  const reward = state.result;
  const title = place === 1 ? "First place!" : place ? `You placed ${place}${place === 2 ? "nd" : place === 3 ? "rd" : "th"}.` : "Race complete!";
  root.innerHTML = `
    <div class="shell">
      ${topbar()}
      ${noticeMarkup()}
      <section class="panel">
        <p class="eyebrow">Room ${escapeHtml(state.room.code)} · Results</p>
        <h1 style="font-size:clamp(36px,7vw,58px)">${title}</h1>
        <p class="lead">${reward
          ? `You earned ${money(reward.coins)} coins and ${reward.stat_points} stat points.`
          : "Your result is in. Finish your own run to claim your coins and stat points."}</p>
        <div class="stat-grid">
          <div class="stat"><span class="eyebrow">Place</span><span class="stat-value">${place ? `#${place}` : "—"}</span></div>
          <div class="stat"><span class="eyebrow">Coins</span><span class="stat-value coin">+${money(reward?.coins ?? 0)}</span></div>
          <div class="stat"><span class="eyebrow">Stat points</span><span class="stat-value">${reward?.stat_points ?? 0}</span></div>
          <div class="stat"><span class="eyebrow">Race total</span><span class="stat-value">${state.runner?.pickups ?? 0} ✦</span></div>
        </div>
        <div class="grid">
          <article class="card"><h3>Room results</h3><ol class="list">${standings().map((row, index) => `
            <li class="list-item"><span class="player-name"><span class="avatar" style="--avatar:${row.color}"></span>${escapeHtml(row.name)}${row.you ? ' <span class="badge">YOU</span>' : ""}${row.bot ? ' <span class="badge">BOT</span>' : ""}</span>
              <span class="badge">${row.time === null ? "Racing…" : `#${index + 1} · ${row.time.toFixed(1)}s`}</span></li>`).join("")}</ol>
          </article>
          <article class="card"><h3>Keep playing</h3><p class="hint">Use the coins in your profile to buy buffs. Stat points improve Speed or Jump.</p>
            <button class="button button-secondary" data-action="profile">Open profile & shop</button>
          </article>
        </div>
        <div class="button-row" style="margin-top:20px">
          ${state.room.host_id === state.user.id && state.room.status === "finished" ? '<button class="button button-primary" data-action="return-lobby">Race again</button>' : '<span class="hint">Waiting for everyone to finish…</span>'}
          <button class="button button-quiet" data-action="leave-room">Leave room</button>
        </div>
      </section>
    </div>`;
  bindCommon();
}

async function returnToLobby() {
  await rpc("return_to_lobby", { room_code: state.room.code });
  state.result = null;
  state.runner = null;
  state.remoteRunners.clear();
  await subscription.send({ type: "broadcast", event: "room-changed", payload: {} });
  state.room.status = "lobby";
  renderRoom();
}

function renderProfile() {
  state.screen = "profile";
  const profile = state.profile;
  const activeTab = state.profileTab;
  let contents;
  if (activeTab === "shop") {
    contents = `<p class="hint">Each buff is separate. Temporary buffs cost 200 coins for the next race. Permanent upgrades cost 100,000 coins.</p>
      <div class="buff-grid">${BUFFS.map((buff) => {
        const permanent = profile.permanent_buffs?.includes(buff.id);
        const temporary = profile.temporary_buffs?.includes(buff.id);
        return `<article class="buff-card">
          <div><p class="eyebrow">Race buff</p><h3>${buff.name}</h3><p class="hint">${buff.description}</p></div>
          <div class="buff-footer">
            <button class="button button-secondary button-small" data-buy="${buff.id}" data-permanent="false" ${temporary || profile.coins < 200 ? "disabled" : ""}>${temporary ? "Temporary ready" : "200 · next race"}</button>
            <button class="button button-quiet button-small" data-buy="${buff.id}" data-permanent="true" ${permanent || profile.coins < 100000 ? "disabled" : ""}>${permanent ? "Permanent owned" : "100,000 · permanent"}</button>
          </div>
        </article>`;
      }).join("")}</div>`;
  } else if (activeTab === "characters") {
    contents = `<p class="hint">All six original geometric racers are unlocked. Pick the shape you like.</p>
      <div class="buff-grid">${CHARACTERS.map((item) => `<article class="buff-card">
        <div class="row"><span class="avatar" style="--avatar:${item.color};width:32px;height:32px"></span><div><h3>${item.name}</h3><p class="hint">Original ${item.shape} design · always unlocked</p></div></div>
        <button class="button ${profile.character_id === item.id ? "button-primary" : "button-secondary"} button-small" data-character="${item.id}">${profile.character_id === item.id ? "Selected" : "Choose"}</button>
      </article>`).join("")}</div>`;
  } else {
    contents = `<div class="stat-grid">
      <div class="stat"><span class="eyebrow">Coins</span><span class="stat-value coin">${money(profile.coins)}</span></div>
      <div class="stat"><span class="eyebrow">Stat points</span><span class="stat-value">${profile.stat_points}</span></div>
      <div class="stat"><span class="eyebrow">Speed</span><span class="stat-value">${profile.speed_stat}/10</span></div>
      <div class="stat"><span class="eyebrow">Jump</span><span class="stat-value">${profile.jump_stat}/10</span></div>
    </div>
    <div class="grid">
      <article class="card"><h3>Spend stat points</h3><p class="hint">Race placement gives 3 points for 1st, 2 for 2nd, 1 for 3rd. Stats cap at 10.</p>
        <div class="button-row"><button class="button button-secondary button-small" data-upgrade="speed" ${profile.stat_points < 1 || profile.speed_stat >= 10 ? "disabled" : ""}>+1 Speed</button>
        <button class="button button-secondary button-small" data-upgrade="jump" ${profile.stat_points < 1 || profile.jump_stat >= 10 ? "disabled" : ""}>+1 Jump</button></div>
      </article>
      <article class="card"><h3>Permanent buffs</h3><p class="hint">${profile.permanent_buffs?.length ? profile.permanent_buffs.map((id) => escapeHtml(BUFFS.find((buff) => buff.id === id)?.name ?? id)).join(" · ") : "No permanent buffs yet."}</p>
        <div class="character-grid">${profile.temporary_buffs?.length ? profile.temporary_buffs.map((id) => `<span class="badge">${escapeHtml(BUFFS.find((buff) => buff.id === id)?.name ?? id)} · next race</span>`).join("") : '<span class="hint">No temporary buffs queued.</span>'}</div>
      </article>
    </div>
    <article class="card" style="margin-top:16px"><label class="field">Display name
      <div class="row"><input class="text-input" id="display-name" maxlength="20" value="${escapeHtml(profile.display_name)}" style="max-width:280px"><button class="button button-secondary button-small" data-action="save-name">Save name</button></div>
    </label><p class="hint">This guest profile belongs to this browser. Sign-in recovery is not enabled yet.</p></article>`;
  }

  root.innerHTML = `
    <div class="shell">
      ${topbar()}
      ${noticeMarkup()}
      <section class="panel">
        <p class="eyebrow">Your personal player profile</p><h1 style="font-size:clamp(34px,6vw,52px)">${escapeHtml(profile.display_name)}</h1>
        <div class="tabs">
          <button class="tab${activeTab === "stats" ? " active" : ""}" data-tab="stats">Stats</button>
          <button class="tab${activeTab === "shop" ? " active" : ""}" data-tab="shop">Buff shop</button>
          <button class="tab${activeTab === "characters" ? " active" : ""}" data-tab="characters">Characters</button>
        </div>
        ${contents}
        <div class="button-row" style="margin-top:22px"><button class="button button-quiet" data-action="${state.room ? "back-room" : "home"}">${state.room ? "Back to room" : "Back to lobby"}</button></div>
      </section>
    </div>`;
  bindCommon();
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.profileTab = button.dataset.tab;
      renderProfile();
    });
  });
  document.querySelectorAll("[data-buy]").forEach((button) => {
    button.addEventListener("click", () => void action(async () => {
      state.profile = rpcValue(await rpc("buy_buff", {
        buff_name: button.dataset.buy,
        permanent: button.dataset.permanent === "true",
      }));
      renderProfile();
    }));
  });
  document.querySelectorAll("[data-upgrade]").forEach((button) => {
    button.addEventListener("click", () => void action(async () => {
      state.profile = rpcValue(await rpc("upgrade_stat", { stat_name: button.dataset.upgrade }));
      renderProfile();
    }));
  });
  document.querySelectorAll("[data-character]").forEach((button) => {
    button.addEventListener("click", () => void action(async () => {
      state.profile = rpcValue(await rpc("set_character", { new_character: button.dataset.character }));
      renderProfile();
    }));
  });
}

async function saveDisplayName() {
  const input = document.querySelector("#display-name");
  state.profile = rpcValue(await rpc("update_profile_name", { new_name: input.value }));
  renderProfile();
  setNotice("Your display name was saved.");
}

function bindCommon() {
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const name = button.dataset.action;
      if (name === "create-room") void action(createRoom);
      if (name === "profile") {
        state.profileTab = "stats";
        renderProfile();
      }
      if (name === "home") void action(leaveRoom);
      if (name === "leave-room") void action(leaveRoom);
      if (name === "copy-link") void action(copyInvite);
      if (name === "start-race") void action(startRace);
      if (name === "return-lobby") void action(returnToLobby);
      if (name === "back-room") void syncRoom();
      if (name === "save-name") void action(saveDisplayName);
      if (name === "notes") {
        void action(async () => {
          if (state.room) await leaveRoom();
          renderNotebook();
        });
      }
      if (button instanceof HTMLAnchorElement) event.preventDefault();
    });
  });
}

if (typeof window !== "undefined" && "ResizeObserver" in window) {
  window.addEventListener("beforeunload", clearRoom);
}

initPage();
