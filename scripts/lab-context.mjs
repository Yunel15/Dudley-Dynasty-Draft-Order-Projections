// Builds data/lab-context.json for the Simulator tab: injuries, schedule and byes, kickoff weather,
// Vegas lines, matchup strength by position and a projection for every rostered player.
// Run by .github/workflows/lab-context.yml every few hours. Node 18+ (built-in fetch), no packages.
//
// Sources (all free, no keys; see LAB.md for terms-of-use notes):
//   Sleeper API   state, league, rosters, /players/nfl (injuries), weekly stats
//   ESPN site API schedule, kickoff times, venue roof, betting lines (unofficial, same one the Dudley Zone tab uses)
//   Open-Meteo    hourly forecast at each outdoor stadium
//
// A source that fails is recorded in `warnings` and skipped. The file says so rather than using stale numbers.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SLEEPER = 'https://api.sleeper.app/v1';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const METEO = 'https://api.open-meteo.com/v1/forecast';
const OUT = new URL('../data/lab-context.json', import.meta.url);

// ---------- Pure model pieces (unit-tested in tests/lab.test.mjs) ----------

// Rough week-to-week standard deviation of fantasy points by position. Blended with each player's own spread when he has enough games.
export const POS_SD = { QB: 6.5, RB: 6.0, WR: 6.5, TE: 5.0, K: 3.5, DEF: 4.5 };
// What a player with no history is assumed to average (a replacement-level starter).
export const POS_BASE = { QB: 14, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
export const ESPN_TO_SLEEPER = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR' };
// Roof types: true = covered or retractable, so weather is ignored.
export const DOMES = new Set(['ATL', 'DAL', 'DET', 'HOU', 'IND', 'LAC', 'LAR', 'LV', 'MIN', 'NO', 'ARI']);
export const STADIUMS = {
  ARI: [33.5276, -112.2626], ATL: [33.7554, -84.4009], BAL: [39.278, -76.6227], BUF: [42.7738, -78.787], CAR: [35.2258, -80.8528],
  CHI: [41.8623, -87.6167], CIN: [39.0955, -84.5161], CLE: [41.5061, -81.6995], DAL: [32.7473, -97.0945], DEN: [39.7439, -105.0201],
  DET: [42.34, -83.0456], GB: [44.5013, -88.0622], HOU: [29.6847, -95.4107], IND: [39.7601, -86.1639], JAX: [30.3239, -81.6373],
  KC: [39.0489, -94.4839], LV: [36.0909, -115.1833], LAC: [33.9535, -118.3392], LAR: [33.9535, -118.3392], MIA: [25.958, -80.2389],
  MIN: [44.9738, -93.2577], NE: [42.0909, -71.2643], NO: [29.9511, -90.0812], NYG: [40.8135, -74.0745], NYJ: [40.8135, -74.0745],
  PHI: [39.9008, -75.1675], PIT: [40.4468, -80.0158], SF: [37.403, -121.9697], SEA: [47.5952, -122.3316], TB: [27.9759, -82.5033],
  TEN: [36.1665, -86.7713], WAS: [38.9078, -76.8645]
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = x => Math.round(x * 100) / 100;

// Chance a player suits up. `weeksAhead` is 0 for this week. Out/IR stay out this week and become uncertain later.
export function playProb(status, injury, practice, weeksAhead = 0) {
  const inj = String(injury || '').toLowerCase(), st = String(status || '').toLowerCase(), pr = String(practice || '').toLowerCase();
  const healthy = 0.97; // small allowance for late scratches and in-game exits
  if (/injured reserve|physically unable|suspended|^ir$|^pup$|^sus$|non football|retired|not with team/.test(st) || /^(ir|pup|sus|nfi)$/.test(inj)) return 0;
  if (st === 'inactive' || st === 'practice squad') return 0;
  let p = healthy;
  if (inj === 'out') p = weeksAhead === 0 ? 0 : 0.35;
  else if (inj === 'doubtful') p = weeksAhead === 0 ? 0.1 : 0.6;
  else if (inj === 'questionable') {
    p = weeksAhead === 0 ? 0.65 : 0.9;
    if (weeksAhead === 0) { if (pr.startsWith('full')) p = 0.85; else if (pr.startsWith('limited')) p = 0.65; else if (pr.startsWith('dnp') || pr.startsWith('did not')) p = 0.35; }
  } else if (inj === 'probable') p = 0.95;
  return r2(p);
}

// Recency-weighted average of recent games (newest first), with a floor and ceiling from the 20th and 80th percentile.
export function rollingProjection(games, pos) {
  const base = POS_BASE[pos] != null ? POS_BASE[pos] : 6, psd = POS_SD[pos] != null ? POS_SD[pos] : 6;
  const g = (games || []).filter(x => Number.isFinite(x)).slice(0, 8);
  if (!g.length) return { mean: r2(base * 0.8), sd: psd, floor: r2(Math.max(0, base * 0.8 - psd)), ceil: r2(base * 0.8 + psd), n: 0 };
  const w = [0.3, 0.22, 0.16, 0.12, 0.08, 0.06, 0.04, 0.02].slice(0, g.length);
  const ws = w.reduce((s, x) => s + x, 0);
  const wavg = g.reduce((s, x, i) => s + x * w[i], 0) / ws;
  const k = 3; // pulls thin samples toward replacement level
  const mean = (wavg * g.length + base * k) / (g.length + k);
  let sd = psd;
  if (g.length >= 4) { const m = g.reduce((s, x) => s + x, 0) / g.length; const own = Math.sqrt(g.reduce((s, x) => s + (x - m) ** 2, 0) / (g.length - 1)); sd = 0.5 * psd + 0.5 * own; }
  const sorted = g.slice().sort((a, b) => a - b);
  const q = p => { const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
  return { mean: r2(mean), sd: r2(sd), floor: r2(Math.min(q(0.2), mean)), ceil: r2(Math.max(q(0.8), mean)), n: g.length };
}

// Points each defense has allowed per game to each position, as a multiplier near 1.0 and a rank (1 = toughest).
// `allowed[team][pos] = { pts, g }`. Shrunk toward 1.0 while few games are in, and clamped to 0.90 - 1.10.
export function matchupMultipliers(allowed, K = 4, lo = 0.9, hi = 1.1) {
  const out = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K']) {
    let pts = 0, gs = 0;
    for (const t of Object.keys(allowed)) { const a = allowed[t][pos]; if (a && a.g) { pts += a.pts; gs += a.g; } }
    const avg = gs ? pts / gs : 0;
    const rows = [];
    for (const t of Object.keys(allowed)) {
      const a = allowed[t][pos]; if (!a || !a.g || !avg) continue;
      const raw = a.pts / a.g / avg;
      rows.push({ t, m: clamp(1 + (raw - 1) * (a.g / (a.g + K)), lo, hi), raw });
    }
    rows.sort((x, y) => x.raw - y.raw); // lowest allowed = toughest
    rows.forEach((r, i) => { (out[r.t] = out[r.t] || {})[pos] = { m: r2(r.m), rank: i + 1 }; });
  }
  return out;
}

// Conservative weather effects. Wind and heavy precipitation hurt passing and kicking a little; cold hurts kickers a little.
export function weatherFactors({ temp, wind, precip, snow }) {
  const w = Number(wind) || 0, t = temp == null ? 60 : Number(temp), p = Number(precip) || 0, s = Number(snow) || 0;
  const pass = (1 - Math.min(0.08, Math.max(0, w - 15) * 0.01)) * (p >= 0.25 || s >= 0.2 ? 0.94 : p >= 0.1 || s > 0 ? 0.97 : 1);
  const rec = (1 - Math.min(0.06, Math.max(0, w - 15) * 0.008)) * (p >= 0.25 || s >= 0.2 ? 0.95 : p >= 0.1 || s > 0 ? 0.98 : 1);
  const k = (1 - Math.min(0.1, Math.max(0, w - 12) * 0.012)) * (t < 20 ? 0.97 : 1) * (p >= 0.25 || s >= 0.2 ? 0.97 : 1);
  return { QB: r2(pass), WR: r2(rec), TE: r2(rec), K: r2(k), RB: 1, DEF: 1 };
}

// "KC -3.5" and an over/under become each side's implied total and a small game-script factor.
export function vegasFor(details, total, home, away) {
  const T = Number(total);
  if (!Number.isFinite(T) || T <= 0) return null;
  let fav = null, spread = 0;
  const m = /^\s*([A-Z]{2,3})\s+(-?\d+(?:\.\d+)?)\s*$/.exec(String(details || ''));
  if (m) { fav = ESPN_TO_SLEEPER[m[1]] || m[1]; spread = Math.abs(Number(m[2])); }
  const impl = t => (fav == null ? T / 2 : t === fav ? T / 2 + spread / 2 : T / 2 - spread / 2);
  const mk = t => {
    const it = impl(t), d = (it - 22.5) / 22.5;
    return { impl: r2(it), spread: fav == null ? 0 : (t === fav ? -spread : spread), total: T, f: { QB: r2(clamp(1 + 0.35 * d, 0.93, 1.07)), WR: r2(clamp(1 + 0.35 * d, 0.93, 1.07)), TE: r2(clamp(1 + 0.3 * d, 0.93, 1.07)), K: r2(clamp(1 + 0.25 * d, 0.95, 1.05)), RB: r2(clamp(1 + 0.2 * d + (fav === t ? 0.01 : 0), 0.95, 1.06)), DEF: 1 } };
  };
  return { [home]: mk(home), [away]: mk(away) };
}

// Projection provider adapter. To use another source, add a function here that returns
// { [playerId]: { mean, sd, floor, ceil, src } } for a week and set PROJECTION_PROVIDER to its name.
export const PROVIDERS = {
  rolling: async (week, { players, history }) => {
    const out = {};
    for (const [pid, p] of Object.entries(players)) {
      const r = rollingProjection(history[pid] || [], p.pos);
      out[pid] = { mean: r.mean, sd: r.sd, floor: r.floor, ceil: r.ceil, n: r.n, src: 'Rolling average of recent games' };
    }
    return out;
  }
};
export async function getProjections(week, ctx, provider = process.env.PROJECTION_PROVIDER || 'rolling') {
  const fn = PROVIDERS[provider] || PROVIDERS.rolling;
  return fn(week, ctx);
}

// Fantasy points for one stat line under the league's scoring settings.
export function scoreLine(stats, scoring) {
  if (!stats) return null;
  if (!scoring || !Object.keys(scoring).length) return stats.pts_ppr != null ? Number(stats.pts_ppr) : null;
  let t = 0;
  for (const k of Object.keys(stats)) { const c = scoring[k]; if (c && typeof stats[k] === 'number') t += stats[k] * c; }
  return t;
}

// ---------- Fetching ----------
async function getJSON(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'dudleydynasty-lab-context' } });
      if (!r.ok) throw new Error(`${r.status} from ${url.split('?')[0]}`);
      return await r.json();
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 600 * (i + 1))); }
  }
  throw err;
}

export function parseEspnWeek(json) {
  const games = [];
  for (const ev of (json && json.events) || []) {
    const c = ev.competitions && ev.competitions[0]; if (!c) continue;
    const home = (c.competitors || []).find(x => x.homeAway === 'home'), away = (c.competitors || []).find(x => x.homeAway === 'away');
    if (!home || !away) continue;
    const fix = a => ESPN_TO_SLEEPER[a] || a;
    const o = (c.odds && c.odds[0]) || {};
    games.push({ home: fix(home.team.abbreviation), away: fix(away.team.abbreviation), kickoff: ev.date, indoor: !!(c.venue && c.venue.indoor), details: o.details || '', total: o.overUnder });
  }
  return games;
}

async function forecast(home, kickoffISO) {
  const ll = STADIUMS[home]; if (!ll) return null;
  const ms = Date.parse(kickoffISO), days = (ms - Date.now()) / 864e5;
  if (!(days > -0.5 && days < 15)) return null;
  const d = new Date(ms).toISOString().slice(0, 10);
  const u = `${METEO}?latitude=${ll[0]}&longitude=${ll[1]}&hourly=temperature_2m,precipitation,snowfall,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=UTC&start_date=${d}&end_date=${d}`;
  const j = await getJSON(u);
  const h = j && j.hourly; if (!h || !h.time) return null;
  const want = new Date(ms + 90 * 60000).toISOString().slice(0, 13); // mid-game
  const i = h.time.findIndex(t => t.startsWith(want));
  if (i < 0) return null;
  return { temp: Math.round(h.temperature_2m[i]), wind: Math.round(h.wind_speed_10m[i]), precip: r2(h.precipitation[i] || 0), snow: r2(h.snowfall[i] || 0) };
}

async function build() {
  const LEAGUE = process.env.LEAGUE_ID || '1389350335302078464';
  const warnings = [], sources = {};
  const note = (k, ok, msg) => { sources[k] = { ok, updated: new Date().toISOString() }; if (!ok) warnings.push(msg); };

  const state = await getJSON(`${SLEEPER}/state/nfl`);
  const season = Number(state.season), curWeek = Math.max(1, Number(state.display_week || state.week || 1));
  const league = await getJSON(`${SLEEPER}/league/${LEAGUE}`);
  const lastReg = Math.max(curWeek, Number((league.settings && league.settings.playoff_week_start) || 15) - 1);
  const scoring = league.scoring_settings || {};
  const rosters = await getJSON(`${SLEEPER}/league/${LEAGUE}/rosters`);
  const roster = new Set();
  rosters.forEach(r => [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])].forEach(id => roster.add(String(id))));

  let all = {};
  try { all = await getJSON(`${SLEEPER}/players/nfl`); note('sleeperPlayers', true); } catch (e) { note('sleeperPlayers', false, 'Sleeper player data (injuries) could not be loaded.'); }

  const players = {};
  for (const pid of roster) {
    const p = all[pid]; if (!p) continue;
    const pos = (p.position || (p.fantasy_positions || [])[0] || '').toUpperCase();
    players[pid] = { n: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || pid, pos: pos === 'PK' ? 'K' : pos, team: p.team || null,
      inj: { status: p.status || null, injury: p.injury_status || null, body: p.injury_body_part || null, notes: p.injury_notes || null, practice: p.practice_participation || null } };
  }

  // Schedule, byes, kickoffs, lines
  const sched = {};
  for (let w = 1; w <= 18; w++) {
    try { sched[w] = parseEspnWeek(await getJSON(`${ESPN}?week=${w}&seasontype=2&dates=${season}`)); }
    catch (e) { sched[w] = null; }
  }
  const okWeeks = Object.keys(sched).filter(w => sched[w] && sched[w].length).length;
  note('schedule', okWeeks >= curWeek, 'The NFL schedule (kickoffs, byes, lines) is missing for some weeks.');

  // Weekly stats: points history and points allowed by position
  const history = {}, allowed = {};
  const oppOf = (w, t) => { const g = (sched[w] || []).find(x => x.home === t || x.away === t); return g ? (g.home === t ? g.away : g.home) : null; };
  let statsOK = true;
  for (let w = 1; w < curWeek; w++) {
    let st; try { st = await getJSON(`${SLEEPER}/stats/nfl/regular/${season}/${w}`); } catch (e) { statsOK = false; continue; }
    const seen = new Set();
    for (const [pid, s] of Object.entries(st || {})) {
      const p = all[pid] || (pid.length <= 3 ? { position: 'DEF', team: pid } : null); if (!p) continue;
      const pos = (p.position === 'PK' ? 'K' : p.position) || '';
      const pts = scoreLine(s, scoring); if (pts == null) continue;
      if (roster.has(pid) && (s.gp == null || s.gp > 0)) (history[pid] = history[pid] || []).unshift(pts);
      const opp = p.team && oppOf(w, p.team);
      if (opp && ['QB', 'RB', 'WR', 'TE', 'K'].includes(pos) && (s.gp == null || s.gp > 0) && Math.abs(pts) > 0) {
        const a = ((allowed[opp] = allowed[opp] || {})[pos] = allowed[opp][pos] || { pts: 0, g: 0, weeks: new Set() });
        a.pts += pts; a.weeks.add(w);
      }
    }
  }
  // games = distinct weeks a defense has faced the position
  for (const t of Object.keys(allowed)) for (const pos of Object.keys(allowed[t])) { allowed[t][pos].g = allowed[t][pos].weeks.size; delete allowed[t][pos].weeks; }
  // allowed sums every player at the position, so average per game is the per-game total
  note('stats', statsOK, 'Some weekly stats could not be loaded; matchup strength may be thinner than usual.');
  const defMult = matchupMultipliers(allowed);

  // Teams: games, weather, lines
  const teams = {};
  let wxFails = 0;
  for (let w = curWeek; w <= lastReg; w++) {
    for (const g of sched[w] || []) {
      const dome = g.indoor || DOMES.has(g.home);
      let weather = null;
      if (!dome) { try { const f = await forecast(g.home, g.kickoff); if (f) weather = { ...f, f: weatherFactors(f) }; } catch (e) { wxFails++; } }
      const v = vegasFor(g.details, g.total, g.home, g.away);
      for (const [t, opp, home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
        const e = (teams[t] = teams[t] || { games: {} });
        e.games[w] = { opp, home, kickoff: g.kickoff, dome, weather: dome ? null : weather, vegas: v ? v[t] : null };
      }
    }
  }
  note('weather', wxFails === 0, `Weather forecasts failed for ${wxFails} games; those games have no weather adjustment.`);

  // Projections via the provider adapter, then per-week availability
  const proj = await getProjections(curWeek, { players, history, season, week: curWeek });
  for (const [pid, p] of Object.entries(players)) {
    const pr = proj[pid] || {};
    Object.assign(p, { mean: pr.mean, sd: pr.sd, floor: pr.floor, ceil: pr.ceil, gp: pr.n, src: pr.src, rec: (history[pid] || []).slice(0, 5).map(r2) });
    p.play = {};
    for (let w = curWeek; w <= lastReg; w++) p.play[w] = playProb(p.inj.status, p.inj.injury, p.inj.practice, w - curWeek);
  }
  const provider = process.env.PROJECTION_PROVIDER || 'rolling';
  note('projections', Object.keys(proj).length > 0, 'No projections were produced.');

  return { version: 1, generated: new Date().toISOString(), leagueId: LEAGUE, season, week: curWeek, lastReg, projectionSource: provider === 'rolling' ? 'Rolling average of recent weekly points' : provider, sources, warnings, defMult, teams, players };
}

async function main() {
  let ctx;
  try { ctx = await build(); } catch (e) { console.error('Could not build lab context:', e.message); process.exit(1); }
  // Don't rewrite the file if nothing but the timestamp changed (keeps the repo history quiet), unless it is a day old.
  try {
    const old = JSON.parse(await readFile(OUT, 'utf8'));
    const strip = o => JSON.stringify({ ...o, generated: 0, sources: 0 });
    if (strip(old) === strip(ctx) && Date.now() - Date.parse(old.generated) < 20 * 3600e3) { console.log('No changes.'); return; }
  } catch (e) { /* first run */ }
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(ctx));
  console.log(`Wrote lab context: week ${ctx.week}, ${Object.keys(ctx.players).length} players, ${ctx.warnings.length} warnings.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
