/**
 * - status: "LIVE" | "UPCOMING" | "NONE"
 * - minute only used for LIVE
 */
const LEAGUES = [
  { id: "pl",  name: "Premier League" },
  { id: "ch",  name: "Championship" },
  { id: "l1",  name: "League One" },
  { id: "l2",  name: "League Two" }
];

const POLL_MS = 30000; // adjust if needed

function isoToLocalKickoff(iso){
  if (!iso) return "";
  const d = new Date(iso);
  // show in UK style
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function toMatchModel(f){
  // goals can be null for upcoming
  const hg = (f.homeGoals ?? 0);
  const ag = (f.awayGoals ?? 0);

  const status = f.isLive ? "LIVE" : "UPCOMING";
  const meta = f.isLive
    ? (f.minute || "")
    : (isoToLocalKickoff(f.kickoffISO) ? `KO ${isoToLocalKickoff(f.kickoffISO)}` : "");

  return {
    id: f.id,
    home: f.home,
    away: f.away,
    homeGoals: hg,
    awayGoals: ag,
    status,
    minute: meta
  };
}

async function fetchScores(){
  const res = await fetch("/api/scores", { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();

  // Build per-league arrays: if live exists use live else upcoming
  const leagues = data.leagues;

  const next = {};
  for (const key of ["pl","ch","l1","l2"]){
    const bucket = leagues[key];
    const list = (bucket.live && bucket.live.length) ? bucket.live : (bucket.upcoming || []);
    next[key] = list.map(toMatchModel);
  }

  LIVE_DATA = next;
  render();
}

async function startPolling(){
  try { await fetchScores(); }
  catch(e){ console.warn(e); }

  setInterval(async () => {
    try { await fetchScores(); }
    catch(e){ console.warn(e); }
  }, POLL_MS);
}

startPolling();


// For each league: include live matches if any; otherwise upcoming.
let LIVE_DATA = {
  pl: [],
  ch: [],
  l1: [],
  l2: []
};

const STORAGE_KEY = "pinscores_followed_match_ids";
const STORAGE_FILTER_KEY = "pinscores_league_filter";

const leaguesEl = document.getElementById("leagues");
const followedEl = document.getElementById("followedList");
const btnOpenPin = document.getElementById("btnOpenPin");
const btnClosePin = document.getElementById("btnClosePin");

const leagueFilterEl = document.getElementById("leagueFilter");
const btnFollowAllLive = document.getElementById("btnFollowAllLive");
const btnClearFollows = document.getElementById("btnClearFollows");
const toastEl = document.getElementById("toast");


let pipWin = null;

// ---------- Helpers ----------
function getAbbr(teamName){
  const parts = teamName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0,3).toUpperCase();
  // take first letter of first 3 words
  const ab = parts.slice(0,3).map(p => p[0]).join("");
  return ab.toUpperCase();
}

function loadFollowedSet(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(arr);
  }catch{
    return new Set();
  }
}

function saveFollowedSet(set){
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
}

function allMatches(){
  return Object.entries(LIVE_DATA).flatMap(([leagueId, matches]) =>
    matches.map(m => ({...m, leagueId}))
  );
}

function findMatchById(id){
  return allMatches().find(m => m.id === id) || null;
}


function loadLeagueFilter(){
  return localStorage.getItem(STORAGE_FILTER_KEY) || "all";
}

function saveLeagueFilter(val){
  localStorage.setItem(STORAGE_FILTER_KEY, val);
}

let toastTimer = null;
function toast(msg){
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

// ---------- Rendering ----------
function render(){
  const followed = loadFollowedSet();
  const filter = loadLeagueFilter();

  renderFilterControls(filter);
  renderQuickActions();
  renderFollowed(followed);
  renderLeagues(followed, filter);

  // keep PiP in sync if open
  renderPinnedWindow(followed);
}

function renderFilterControls(active){
  if (!leagueFilterEl) return;
  leagueFilterEl.querySelectorAll(".seg-btn").forEach(b => {
    const isActive = b.getAttribute("data-filter") === active;
    b.classList.toggle("is-active", isActive);
  });
}

function renderQuickActions(){
  // Show count of currently live games in button label
  const liveCount = allMatches().filter(m => m.status === "LIVE").length;
  btnFollowAllLive.textContent = liveCount > 0 ? `Follow all live (${liveCount})` : "Follow all live";
}

function renderFollowed(followed){
  const matches = [...followed].map(id => findMatchById(id)).filter(Boolean);

  if (matches.length === 0){
    followedEl.innerHTML = `<div class="empty">No followed matches yet. Tap “Follow” on a match to pin it.</div>`;
    return;
  }

  followedEl.innerHTML = matches.map(m => {
    const left = `${getAbbr(m.home)} ${formatScoreline(m)} ${getAbbr(m.away)}`;
    const right = formatRightMeta(m);
    return `
      <div class="pill">
        <div>
          <b>${left}</b>
          <div class="tiny">${m.leagueName} • ${right}</div>
        </div>
        <button class="pill-x pill-x-danger" data-unfollow="${m.id}" title="Unfollow">×</button>
      </div>
    `;
  }).join("");

  // bind unfollow
  followedEl.querySelectorAll("[data-unfollow]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-unfollow");
      toggleFollow(id, false);
    });
  });
}

function renderLeagues(followed, filter){
  const leaguesToShow = filter === "all" ? LEAGUES : LEAGUES.filter(l => l.id === filter);

  leaguesEl.innerHTML = leaguesToShow.map(lg => {
    const matches = LIVE_DATA[lg.id] || [];
    const live = matches.filter(m => m.status === "LIVE");
    const upcoming = matches.filter(m => m.status === "UPCOMING");

    let badge = "No live games";
    let listToShow = live.length ? live : upcoming.length ? upcoming : [];
    if (live.length) badge = `${live.length} live`;
    else if (upcoming.length) badge = `${upcoming.length} upcoming`;

    const body = listToShow.length
      ? `<div class="matches">${listToShow.map(m => renderMatchRow(m, lg, followed)).join("")}</div>`
      : `<div class="matches"><div class="empty">No live games today</div></div>`;

    return `
      <section class="league league--${lg.id}">
        <div class="league-head">
          <h3>${lg.name}</h3>
          <div class="badge">${badge}</div>
        </div>
        ${body}
      </section>
    `;
  }).join("");

  // bind follow/unfollow
  leaguesEl.querySelectorAll("[data-follow]").forEach(btn => {
    btn.addEventListener("click", () => toggleFollow(btn.getAttribute("data-follow"), true));
  });
  leaguesEl.querySelectorAll("[data-unfollow]").forEach(btn => {
    btn.addEventListener("click", () => toggleFollow(btn.getAttribute("data-unfollow"), false));
  });
}

function renderMatchRow(m, lg, followed){
  const isFollowed = followed.has(m.id);
  const homeAb = getAbbr(m.home);
  const awayAb = getAbbr(m.away);

  const meta = m.status === "LIVE"
    ? `<span class="status-live">LIVE</span> • ${m.minute}'`
    : `<span class="status-upcoming">UPCOMING</span> • ${m.kickoff}`;

  return `
    <div class="match">
      <div class="left">
        <div class="row">
          <span class="abbr">${homeAb}</span>
          <span class="score">${formatScoreline(m)}</span>
          <span class="abbr">${awayAb}</span>
        </div>
        <div class="meta">${meta}</div>
      </div>
        <div class="controls">
            ${isFollowed
                ? `<button class="smallbtn smallbtn-danger" data-unfollow="${m.id}">Unfollow</button>`
                : `<button class="smallbtn" data-follow="${m.id}">Follow</button>`
            }
        </div>
    </div>
  `;
}

function formatScoreline(m){
  if (m.status === "LIVE") return `${m.homeScore} : ${m.awayScore}`;
  return `vs`;
}

function formatRightMeta(m){
  if (m.status === "LIVE") return `${m.minute}'`;
  if (m.status === "UPCOMING") return `KO ${m.kickoff}`;
  return "";
}

// ---------- Follow state ----------
function toggleFollow(matchId, shouldFollow){
  const set = loadFollowedSet();
  if (shouldFollow) set.add(matchId);
  else set.delete(matchId);
  saveFollowedSet(set);
  render();
}

// ---------- Document PiP ----------
btnOpenPin.addEventListener("click", async () => {
  if (!("documentPictureInPicture" in window)){
    alert("Document PiP not supported. Use Chrome.");
    return;
  }

  try{
    pipWin = await window.documentPictureInPicture.requestWindow({
      width: 360,
      height: 240,
    });

    // Minimal styling for the PiP window
pipWin.document.head.innerHTML = `
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pinned Scores</title>
  <style>
    :root{
      --bg:#f7f7f8;
      --panel:#ffffff;
      --text:#111827;
      --muted:#6b7280;
      --border:#e5e7eb;
      --shadow: 0 10px 26px rgba(17, 24, 39, 0.08);
      --accent:#2563eb;
      --accentSoft:#eff6ff;
      --good:#16a34a;
      --warn:#d97706;
    }
    html,body{ height:100%; }
    body{
      margin:0;
      background: radial-gradient(900px 600px at 10% 0%, #fff 0%, var(--bg) 60%);
      color:var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }
    .wrap{ padding:10px; }
    .head{
      display:flex; justify-content:space-between; align-items:flex-end;
      margin-bottom:10px;
    }
    .title{ font-weight:900; font-size:12px; letter-spacing:.2px; }
    .hint{ font-size:11px; color:var(--muted); }
    .list{ display:flex; flex-direction:column; gap:8px; }
    .row{
      display:flex; justify-content:space-between; align-items:center;
      border:1px solid var(--border);
      border-radius:14px;
      padding:10px 10px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .left{
      font-weight:950;
      letter-spacing:.5px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 240px;
    }
    .right{
      color:var(--muted);
      font-size:12px;
      font-variant-numeric: tabular-nums;
      margin-left:10px;
      white-space: nowrap;
    }
    .empty{
      border:1px dashed #d1d5db;
      border-radius:14px;
      padding:10px;
      color:var(--muted);
      background: var(--panel);
      font-size:12px;
    }
  </style>
`;

    pipWin.document.body.innerHTML = `
      <div class="wrap">
        <div class="head">
          <div class="title">Pinned Scores</div>
          <div class="hint">Close window to unpin</div>
        </div>
        <div id="pipList" class="list"></div>
      </div>
    `;

    pipWin.addEventListener("pagehide", () => {
      pipWin = null;
      btnClosePin.disabled = true;
    });

    btnClosePin.disabled = false;
    render(); // immediately paint content into PiP
  }catch (e){
    console.error(e);
    alert("Could not open pinned window. Make sure this was triggered by a click and you're on localhost/https.");
  }
});

btnClosePin.addEventListener("click", () => {
  if (pipWin && !pipWin.closed) pipWin.close();
  pipWin = null;
  btnClosePin.disabled = true;
});

function renderPinnedWindow(followed){
  if (!pipWin || pipWin.closed) return;
  const list = pipWin.document.getElementById("pipList");
  if (!list) return;

  const matches = [...followed].map(id => findMatchById(id)).filter(Boolean);

  if (matches.length === 0){
    list.innerHTML = `<div class="empty">No followed matches</div>`;
    return;
  }

  list.innerHTML = matches.map(m => {
    const left = `${getAbbr(m.home)} ${formatScoreline(m)} ${getAbbr(m.away)}`;
    const right = m.status === "LIVE" ? `${m.minute}'` : (m.status === "UPCOMING" ? `KO ${m.kickoff}` : "");
    return `<div class="row"><div class="left">${left}</div><div class="right">${right}</div></div>`;
  }).join("");
}

leagueFilterEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-filter]");
  if (!btn) return;
  const val = btn.getAttribute("data-filter");
  saveLeagueFilter(val);
  render();
});

btnFollowAllLive.addEventListener("click", () => {
  const live = allMatches().filter(m => m.status === "LIVE");
  if (live.length === 0){
    toast("No live matches right now");
    return;
  }
  const set = loadFollowedSet();
  live.forEach(m => set.add(m.id));
  saveFollowedSet(set);
  toast(`Following ${live.length} live match${live.length === 1 ? "" : "es"}`);
  render();
});

btnClearFollows.addEventListener("click", () => {
  saveFollowedSet(new Set());
  toast("Cleared followed matches");
  render();
});


setInterval(() => {
  // increment minutes for LIVE matches to demonstrate “live updates”
  for (const lg of LEAGUES){
    const list = SAMPLE[lg.id] || [];
    for (const m of list){
      if (m.status === "LIVE" && typeof m.minute === "number"){
        m.minute = Math.min(m.minute + 1, 90);
      }
    }
  }
  render();
}, 15000); // every 15s

// initial render
render();
