// Nightly snapshot of the league's rosters and FantasyCalc dynasty values.
// Run by .github/workflows/snapshot.yml. Needs Node 18+ (built-in fetch). No packages to install.
//
// Writes:
//   data/snapshots/YYYY-MM-DD.json  full picture for one day (rosters, picks, every value)
//   data/snapshots/index.json       list of snapshot dates, oldest first
//   data/history.json               compact series for charts: player values, team totals, pick values

import { mkdir, readFile, writeFile } from 'node:fs/promises';

const LEAGUE_ID = process.env.LEAGUE_ID || '1389350335302078464';
const SLEEPER = process.env.SLEEPER_API || 'https://api.sleeper.app/v1';
const FANTASYCALC = process.env.FANTASYCALC_API || 'https://api.fantasycalc.com';
const OUT = process.env.OUT_DIR || 'data';
const today = process.env.SNAPSHOT_DATE || new Date().toISOString().slice(0, 10);

async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'dudleydynasty-snapshot' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${url} failed: ${e.message}`);
      await new Promise(res => setTimeout(res, 2000 * i));
    }
  }
}
async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

// 1. League, rosters, owners and traded picks from Sleeper
const [league, rosters, users, traded] = await Promise.all([
  getJSON(`${SLEEPER}/league/${LEAGUE_ID}`),
  getJSON(`${SLEEPER}/league/${LEAGUE_ID}/rosters`),
  getJSON(`${SLEEPER}/league/${LEAGUE_ID}/users`),
  getJSON(`${SLEEPER}/league/${LEAGUE_ID}/traded_picks`),
]);
if (!league || !league.league_id) throw new Error('League not found. Check LEAGUE_ID.');
const userById = new Map((users || []).map(u => [u.user_id, u]));

// 2. FantasyCalc values tuned to this league (same settings the site's Trade Finder uses)
const rp = league.roster_positions || [], sc = league.scoring_settings || {};
const numQbs = rp.includes('SUPER_FLEX') ? 2 : 1;
const rec = typeof sc.rec === 'number' ? sc.rec : 1;
const ppr = [0, 0.5, 1].reduce((a, b) => Math.abs(b - rec) < Math.abs(a - rec) ? b : a);
const numTeams = (rosters || []).length || 12;
const raw = await getJSON(`${FANTASYCALC}/values/current?isDynasty=true&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`);
if (!Array.isArray(raw) || !raw.length) throw new Error('FantasyCalc returned no values.');

const players = {};   // sleeperId -> value
const picks = {};     // "2027-1" -> average value of that round's pick (Early/Mid/Late averaged)
const pickAgg = {};
for (const x of raw) {
  const pl = x.player || {}, v = Math.round(Number(x.value) || 0);
  const pm = /^(\d{4}) (\d+)(?:st|nd|rd|th)(?: \((?:Early|Mid|Late)\))?$/i.exec(pl.name || '');
  if (pm) { const k = `${pm[1]}-${pm[2]}`; (pickAgg[k] ||= []).push(v); continue; }
  if (pl.sleeperId != null && v > 0) players[String(pl.sleeperId)] = v;
}
for (const k in pickAgg) picks[k] = Math.round(pickAgg[k].reduce((a, b) => a + b, 0) / pickAgg[k].length);

// 3. Who owns each future pick
const seasons = new Set();
const ownerOf = new Map();
for (const p of traded || []) { seasons.add(Number(p.season)); ownerOf.set(`${p.season}-${p.round}-${p.roster_id}`, p.owner_id); }
const firstSeason = Number(league.season) + 1;   // next rookie draft
for (let y = firstSeason; y < firstSeason + 3; y++) seasons.add(y);
const rounds = Math.max(4, ...(traded || []).map(p => p.round || 0));

// 4. One record per team, with a value total for the Contender Map
const teams = (rosters || []).map(r => {
  const u = userById.get(r.owner_id) || {};
  const pl = (r.players || []).map(String);
  const myPicks = [];
  for (const y of [...seasons].sort()) for (let rd = 1; rd <= rounds; rd++) for (const o of rosters) {
    const owner = ownerOf.get(`${y}-${rd}-${o.roster_id}`) ?? o.roster_id;
    if (owner === r.roster_id) myPicks.push({ season: y, round: rd, from: o.roster_id });
  }
  const playerValue = pl.reduce((t, id) => t + (players[id] || 0), 0);
  const pickValue = myPicks.reduce((t, p) => t + (picks[`${p.season}-${p.round}`] || 0), 0);
  const s = r.settings || {};
  return {
    rid: r.roster_id, owner: r.owner_id || null,
    name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
    record: { w: s.wins || 0, l: s.losses || 0, t: s.ties || 0, pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100 },
    players: pl, starters: (r.starters || []).map(String), taxi: (r.taxi || []).map(String), ir: (r.reserve || []).map(String),
    picks: myPicks, value: { players: playerValue, picks: pickValue, total: playerValue + pickValue },
  };
});

const snapshot = {
  date: today, takenAt: new Date().toISOString(), league: LEAGUE_ID, season: league.season,
  settings: { numQbs, numTeams, ppr, dynasty: true, source: 'fantasycalc' },
  teams, values: { players, picks },
};

// 5. Write the daily file, the index, and the compact history used for charts
await mkdir(`${OUT}/snapshots`, { recursive: true });
await writeFile(`${OUT}/snapshots/${today}.json`, JSON.stringify(snapshot));

const index = await readJSON(`${OUT}/snapshots/index.json`, { dates: [] });
if (!index.dates.includes(today)) index.dates.push(today);
index.dates.sort();
index.updated = snapshot.takenAt;
await writeFile(`${OUT}/snapshots/index.json`, JSON.stringify(index, null, 1));

// history.json: one column per date. Player series keep every player who has ever been on a roster here.
const hist = await readJSON(`${OUT}/history.json`, { dates: [], players: {}, teams: {}, picks: {} });
let col = hist.dates.indexOf(today);
if (col === -1) { hist.dates.push(today); col = hist.dates.length - 1; }
const n = hist.dates.length;
const setAt = (series, key, v) => { const a = series[key] || (series[key] = []); while (a.length < n) a.push(null); a[col] = v; };
const rostered = new Set(teams.flatMap(t => t.players));
for (const id of Object.keys(hist.players)) rostered.add(id);
for (const id of rostered) setAt(hist.players, id, players[id] ?? null);
for (const t of teams) setAt(hist.teams, String(t.rid), t.value.total);
for (const k in picks) setAt(hist.picks, k, picks[k]);
for (const series of [hist.players, hist.teams, hist.picks]) for (const k in series) while (series[k].length < n) series[k].push(null);
hist.updated = snapshot.takenAt;
await writeFile(`${OUT}/history.json`, JSON.stringify(hist));

console.log(`Snapshot ${today}: ${teams.length} teams, ${Object.keys(players).length} player values, ${Object.keys(picks).length} pick values, ${hist.dates.length} day(s) of history.`);
