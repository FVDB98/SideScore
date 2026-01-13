import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from flask import Flask, jsonify, send_from_directory
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__, static_folder="static", static_url_path="/static")

API_BASE = "https://v3.football.api-sports.io"
API_KEY = os.getenv("APISPORTS_KEY", "").strip()

if not API_KEY:
    raise RuntimeError("Missing APISPORTS_KEY in environment (.env)")

TZ = "Europe/London"
LONDON = ZoneInfo(TZ)

LEAGUES = [
    {"id": 39, "slug": "pl", "name": "Premier League"},
    {"id": 40, "slug": "ch", "name": "Championship"},
    {"id": 41, "slug": "l1", "name": "League One"},
    {"id": 42, "slug": "l2", "name": "League Two"},
]

# Cache: keep API calls down
CACHE = {}
LIVE_TTL_SECONDS = int(os.getenv("LIVE_TTL_SECONDS", "30"))       # live changes quickly
TODAY_TTL_SECONDS = int(os.getenv("TODAY_TTL_SECONDS", "300"))    # upcoming can be cached longer


def season_start_year(dt: datetime) -> int:
    """
    API-Football uses 'season' as a year. For English leagues, that’s typically the season start year:
    - Aug 2025 -> season 2025
    - Jan 2026 -> season 2025
    """
    return dt.year if dt.month >= 7 else dt.year - 1


def api_get(path: str, params: dict):
    url = f"{API_BASE}{path}"
    headers = {
        "x-apisports-key": API_KEY,
    }
    resp = requests.get(url, headers=headers, params=params, timeout=10)
    resp.raise_for_status()
    return resp.json()


def cached(key: str, ttl: int, fetcher):
    now = time.time()
    entry = CACHE.get(key)
    if entry and (now - entry["ts"] < ttl):
        return entry["data"]
    data = fetcher()
    CACHE[key] = {"ts": now, "data": data}
    return data


def team_abbr(team_obj: dict) -> str:
    # API often returns team.code, otherwise derive
    code = (team_obj.get("code") or "").strip()
    if code:
        return code.upper()
    name = (team_obj.get("name") or "").strip().upper()
    # simple fallback: first 3 letters of each word combined, then slice
    compact = "".join([w[:3] for w in name.split() if w])
    compact = compact[:3] if len(compact) >= 3 else (name[:3] if len(name) >= 3 else name)
    return compact


def format_minute(fixture: dict) -> str:
    st = fixture.get("status", {}) or {}
    short = st.get("short")
    elapsed = st.get("elapsed")
    extra = st.get("extra")

    if short == "HT":
        return "HT"
    if elapsed is None:
        return ""  # upcoming: show KO time
    if extra:
        return f"{elapsed}+{extra}'"
    return f"{elapsed}'"


def normalize_fixture(item: dict) -> dict:
    fixture = item.get("fixture", {}) or {}
    league = item.get("league", {}) or {}
    teams = item.get("teams", {}) or {}
    goals = item.get("goals", {}) or {}

    home = teams.get("home", {}) or {}
    away = teams.get("away", {}) or {}

    status = (fixture.get("status", {}) or {}).get("short", "")
    # upcoming typically "NS", live could be "1H/2H/HT/ET/P/BT" etc.
    is_live = status in {"1H", "2H", "HT", "ET", "P", "BT"}  # good-enough MVP set
    is_upcoming = status == "NS"

    dt_str = fixture.get("date")
    kickoff_iso = dt_str  # keep as ISO string

    return {
        "id": str(fixture.get("id")),
        "leagueId": int(league.get("id") or 0),
        "statusShort": status,
        "isLive": is_live,
        "isUpcoming": is_upcoming,
        "kickoffISO": kickoff_iso,
        "minute": format_minute(fixture),
        "home": team_abbr(home),
        "away": team_abbr(away),
        "homeGoals": goals.get("home"),
        "awayGoals": goals.get("away"),
    }


@app.get("/")
def index():
    return send_from_directory(".", "index.html")


@app.get("/api/scores")
def scores():
    now = datetime.now(LONDON)
    today = now.date().isoformat()
    season = season_start_year(now)

    league_ids = [str(l["id"]) for l in LEAGUES]
    live_param = "-".join(league_ids)

    # 1) Live fixtures for all leagues
    def fetch_live():
        data = api_get("/fixtures", {"live": live_param, "timezone": TZ})
        return data.get("response", [])

    live_items = cached(f"live:{live_param}", LIVE_TTL_SECONDS, fetch_live)

    live_norm = [normalize_fixture(x) for x in live_items]

    # group live by leagueId for quick lookup
    live_by_league = {}
    for f in live_norm:
        live_by_league.setdefault(f["leagueId"], []).append(f)

    # 2) If a league has no live games, fetch today's fixtures for that league and keep only upcoming (NS)
    result = {}
    for lg in LEAGUES:
        lid = lg["id"]
        slug = lg["slug"]

        league_live = live_by_league.get(lid, [])

        upcoming = []
        if not league_live:
            def fetch_today_for_league(lid=lid):
                data = api_get("/fixtures", {
                    "league": lid,
                    "season": season,
                    "date": today,
                    "timezone": TZ
                })
                return data.get("response", [])

            day_items = cached(f"day:{lid}:{today}:{season}", TODAY_TTL_SECONDS, fetch_today_for_league)
            day_norm = [normalize_fixture(x) for x in day_items]
            upcoming = [f for f in day_norm if f["isUpcoming"]]

            # sort upcoming by kickoff time
            upcoming.sort(key=lambda x: x["kickoffISO"] or "")

        result[slug] = {
            "leagueId": lid,
            "leagueName": lg["name"],
            "live": league_live,
            "upcoming": upcoming,
        }

    return jsonify({
        "generatedAt": now.isoformat(),
        "timezone": TZ,
        "season": season,
        "leagues": result
    })


if __name__ == "__main__":
    app.run(debug=True)
