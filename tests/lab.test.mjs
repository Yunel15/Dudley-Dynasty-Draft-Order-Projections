// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { playProb, rollingProjection, matchupMultipliers, weatherFactors, vegasFor, parseEspnWeek, scoreLine, getProjections, POS_SD } from '../scripts/lab-context.mjs';

// Pull the lineup/simulation core straight out of index.html so the tests run the code the site runs.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const core = html.slice(html.indexOf('// ==== LAB CORE START'), html.indexOf('// ==== LAB CORE END'));
function load(){
  const posted = [];
  const self = { postMessage: m => posted.push(m) };
  const ctx = vm.createContext({ self, Math, Map, Set, Array, Object, Number, String, Float64Array, Uint8Array, Infinity, RegExp });
  vm.runInContext(core + ';this.api={labElig,labCanFill,labMove,labValidate,labOptimize,labFromStarters,labPlayerWeek,labFactors,labWorkerMain,labStartSlots,labIrOk,labWhyNot,labPlace};', ctx);
  return { api: ctx.api, self, posted };
}
const { api } = load();

const RP = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'IR', 'TAXI'];
const players = {
  q1: { n: 'Q One', pos: 'QB', inj: null }, q2: { n: 'Q Two', pos: 'QB', inj: null },
  r1: { n: 'R One', pos: 'RB', inj: null }, r2: { n: 'R Two', pos: 'RB', inj: null }, r3: { n: 'R Three', pos: 'RB', inj: null },
  w1: { n: 'W One', pos: 'WR', inj: null }, w2: { n: 'W Two', pos: 'WR', inj: null }, w3: { n: 'W Three', pos: 'WR', inj: null },
  t1: { n: 'T One', pos: 'TE', inj: null }, k1: { n: 'K One', pos: 'K', inj: null }, d1: { n: 'D One', pos: 'DEF', inj: null },
  ir1: { n: 'Hurt Guy', pos: 'RB', inj: { status: 'Injured Reserve', injury: 'IR' } },
  ou1: { n: 'Out Guy', pos: 'WR', inj: { status: 'Active', injury: 'Out' } },
  qu1: { n: 'Q Guy', pos: 'WR', inj: { status: 'Active', injury: 'Questionable' } }
};
const env = (over = {}) => ({ slots: api.labStartSlots(RP), info: players, roster: new Set(Object.keys(players)), settings: {}, irSlots: 1, txSlots: 1, ...over });
const empty = e => ({ s: new Array(e.slots.length).fill(null), ir: [], tx: [] });

test('slot eligibility: FLEX and SUPER_FLEX', () => {
  assert.ok(api.labCanFill('FLEX', 'RB') && api.labCanFill('FLEX', 'WR') && api.labCanFill('FLEX', 'TE'));
  assert.ok(!api.labCanFill('FLEX', 'QB') && !api.labCanFill('FLEX', 'K'));
  assert.ok(api.labCanFill('SUPER_FLEX', 'QB') && api.labCanFill('SUPER_FLEX', 'RB'));
  assert.ok(!api.labCanFill('SUPER_FLEX', 'K') && !api.labCanFill('SUPER_FLEX', 'DEF'));
  assert.ok(api.labCanFill('REC_FLEX', 'TE') && !api.labCanFill('REC_FLEX', 'RB'));
});
test('illegal drop is rejected with a clear message and the lineup is unchanged', () => {
  const e = env(), L = empty(e);
  const r = api.labMove(e, L, 'k1', { k: 'slot', i: 0 }); // K into QB
  assert.equal(r.ok, false); assert.match(r.msg, /K One .*can't play QB/);
  assert.deepEqual(r.L.s, L.s);
});
test('legal drop into FLEX works and swaps with an occupant', () => {
  const e = env(), L = empty(e); const iFlex = e.slots.indexOf('FLEX'), iRb = e.slots.indexOf('RB');
  L.s[iRb] = 'r1'; L.s[iFlex] = 'w1';
  const r = api.labMove(e, L, 'r1', { k: 'slot', i: iFlex }); // RB -> FLEX, WR goes to the RB slot? not legal
  assert.equal(r.ok, false);
  const r2 = api.labMove(e, L, 'r2', { k: 'slot', i: iFlex }); // bench RB replaces FLEX WR, WR goes to bench
  assert.ok(r2.ok); assert.equal(r2.L.s[iFlex], 'r2'); assert.ok(!r2.L.s.includes('w1'));
});
test('IR players: can be placed on IR, cannot start', () => {
  const e = env(), L = empty(e);
  assert.ok(api.labMove(e, L, 'ir1', { k: 'ir' }).ok);
  const r = api.labMove(e, L, 'ir1', { k: 'slot', i: e.slots.indexOf('FLEX') });
  assert.equal(r.ok, false); assert.match(r.msg, /injured reserve/i);
  const bad = api.labMove(e, L, 'q1', { k: 'ir' }); assert.equal(bad.ok, false); assert.match(bad.msg, /isn't eligible for IR/);
});
test('validate flags an IR player sitting in a starting slot and players not on the roster', () => {
  const e = env(), L = empty(e); L.s[e.slots.indexOf('FLEX')] = 'ir1'; L.s[0] = 'zz';
  const p = api.labValidate(e, L);
  assert.ok(p.some(x => x.kind === 'slot' && /injured reserve/i.test(x.msg)));
  assert.ok(p.some(x => x.kind === 'roster'));
});
test('Sleeper starters are coerced to legal slots; empty and "0" entries become empty slots', () => {
  const e = env(), L = api.labFromStarters(e, ['q1', '0', 'r1', 'w1', 'k1', null, 'q2', 'w2', 'k1', 'd1'], e.roster, ['ir1'], []);
  assert.equal(L.s[0], 'q1'); assert.equal(L.s[1], null);
  assert.equal(L.s[4], null, 'a K in a WR slot is dropped'); assert.equal(L.s[8], 'k1');
  const dup = api.labFromStarters(e, ['q1', 'q1'], e.roster, [], []); assert.equal(dup.s[1], null, 'a duplicate is dropped');
  assert.deepEqual(L.ir, ['ir1']);
});
test('auto-optimize picks the highest legal lineup and never starts an IR player', () => {
  const e = env(), value = { q1: 20, q2: 22, r1: 15, r2: 14, r3: 13, w1: 12, w2: 11, w3: 10, t1: 8, k1: 7, d1: 6, ir1: 99, ou1: 0, qu1: 3 };
  const L = api.labOptimize(e, { ...empty(e), ir: [], tx: [] }, pid => value[pid]);
  assert.ok(!L.s.includes('ir1'));
  assert.equal(L.s[e.slots.indexOf('QB')] === 'q1' || L.s[e.slots.indexOf('QB')] === 'q2', true);
  const sf = L.s[e.slots.indexOf('SUPER_FLEX')], qb = L.s[0]; assert.deepEqual([qb, sf].sort(), ['q1', 'q2'], 'both QBs start in QB and SUPER_FLEX');
  const total = L.s.reduce((s, p) => s + (p ? value[p] : 0), 0);
  assert.equal(total, 22 + 20 + 15 + 14 + 12 + 11 + 8 + 13 + 7 + 6, 'RBs r1 r2, WRs w1 w2, FLEX r3, TE, K, DEF');
  assert.equal(api.labValidate(e, L).length, 0);
});
test('unusual roster settings: no flex, no IR, no taxi, IDP slots', () => {
  const e = env({ slots: ['QB', 'RB', 'WR', 'DL'], irSlots: 0, txSlots: 0 }), L = empty(e);
  assert.equal(api.labMove(e, L, 'r1', { k: 'ir' }).ok, false);
  assert.equal(api.labMove(e, L, 'r1', { k: 'tx' }).ok, false);
  assert.equal(api.labMove(e, L, 'w1', { k: 'slot', i: 1 }).ok, false);
  const L2 = api.labOptimize(e, L, () => 5); assert.equal(L2.s[3], null, 'no DL on the roster leaves the slot empty');
  assert.equal(api.labOptimize(env({ slots: [] }), { s: [], ir: [], tx: [] }, () => 1).s.length, 0);
});
test('IR eligibility follows league settings', () => {
  assert.equal(api.labIrOk({ injury: 'Doubtful' }, {}), false);
  assert.equal(api.labIrOk({ injury: 'Doubtful' }, { reserve_allow_doubtful: 1 }), true);
  assert.equal(api.labIrOk({ injury: 'Out' }, { reserve_allow_out: 0 }), false);
  assert.equal(api.labIrOk({ injury: 'Questionable' }, {}), false);
});

// ----- Player-week distribution -----
const ctx = {
  week: 5, lastReg: 8,
  players: { a: { pos: 'WR', team: 'KC', mean: 10, sd: 6, floor: 4, ceil: 18, play: { 5: 0.65, 6: 0.97 }, inj: {} }, b: { pos: 'QB', team: 'BAL', mean: 18, sd: 6.5, floor: 9, ceil: 28, play: {}, inj: {} }, z: { pos: 'RB', team: null, mean: 5, sd: 5, floor: 1, ceil: 9, play: {}, inj: {} } },
  defMult: { DEN: { WR: { m: 1.08, rank: 30 } }, MIA: { QB: { m: 0.92, rank: 2 } } },
  teams: { KC: { games: { 5: { opp: 'DEN', home: true, kickoff: '2026-11-15T18:00:00Z', weather: null, vegas: { impl: 27, f: { WR: 1.05 } } } } }, BAL: { games: { 5: { opp: 'MIA', home: true, kickoff: '2026-11-15T18:00:00Z', weather: { wind: 22, precip: 0, f: { QB: 0.93 } }, vegas: null } } } }
};
test('projection = base x matchup x weather x game script, times chance to play', () => {
  const w = api.labPlayerWeek(ctx, 'a', 5, ''); assert.ok(Math.abs(w.m - 10 * 1.08 * 1.05) < 1e-9); assert.equal(w.p, 0.65);
  const q = api.labPlayerWeek(ctx, 'b', 5, ''); assert.ok(Math.abs(q.m - 18 * 0.92 * 0.93) < 1e-9);
});
test('bye week and missing data give a zero projection', () => {
  const bye = api.labPlayerWeek(ctx, 'a', 6, ''); assert.equal(bye.bye, true); assert.equal(bye.p, 0); assert.equal(bye.m, 0);
  assert.equal(api.labPlayerWeek(ctx, 'a', 9, '').miss, true, 'week outside the data');
  assert.equal(api.labPlayerWeek(ctx, 'nobody', 5, '').miss, true);
  assert.equal(api.labPlayerWeek(ctx, 'z', 5, '').bye, true, 'free agent has no game');
});
test('best and worst case toggles', () => {
  const best = api.labPlayerWeek(ctx, 'a', 5, 'best'), worst = api.labPlayerWeek(ctx, 'a', 5, 'worst');
  assert.equal(best.p, 1); assert.ok(best.m > worst.m); assert.equal(worst.p, 0.65);
});
test('top factors name the injury, the matchup and the wind', () => {
  const ours = [{ pid: 'a', label: 'WR1', w: api.labPlayerWeek(ctx, 'a', 5, '') }, { pid: 'b', label: 'QB1', w: api.labPlayerWeek(ctx, 'b', 5, '') }];
  const f = api.labFactors(ctx, ours, [], 5);
  assert.ok(f.length <= 3 && f.length >= 1);
  assert.ok(f.some(x => /wind 22 mph/.test(x.text)) || f.some(x => /WR1/.test(x.text)));
  assert.ok(f.every((x, i) => i === 0 || Math.abs(f[i - 1].d) >= Math.abs(x.d)), 'sorted by size');
});

// ----- The simulation worker -----
function mkPayload(over = {}) {
  const n = 4, mkL = idx => ({ st: idx.map(i => ({ i, el: ['WR'] })), bn: [] });
  const pl = [{ m: 20, sd: 5, p: 1, tm: 0, rho: 0, pos: 'WR' }, { m: 20, sd: 5, p: 1, tm: 1, rho: 0, pos: 'WR' }, { m: 20, sd: 5, p: 1, tm: 2, rho: 0, pos: 'WR' }, { m: 20, sd: 5, p: 1, tm: 3, rho: 0, pos: 'WR' }];
  const wk = { week: 8, pairs: [[0, 1], [2, 3]], random: false, pl, nTm: 4, lineups: [mkL([0]), mkL([1]), mkL([2]), mkL([3])], userB: mkL([0]) };
  return { runs: 4000, seed: 5, nTeams: n, userIdx: 0, pTeams: 2, median: false, autoSub: false, baseW: [0, 0, 0, 0], baseP: [0, 0, 0, 0], weeks: [wk], bracket: null, muA: [20, 20, 20, 20], muB: [20, 20, 20, 20], sig: [5, 5, 5, 5], ...over, _wk: wk, _pl: pl };
}
function runSim(p) { const { api: a, self } = load(); const f = a.labWorkerMain(); return f(p); }
test('equal teams: about 50% to win a matchup, playoff odds near pTeams/n', () => {
  const R = runSim(mkPayload()); assert.ok(Math.abs(R.A.userWin[0] - 0.5) < 0.04);
  assert.ok(Math.abs(R.A.make[0] - 0.5) < 0.05);
});
test('same lineup in both scenarios gives identical results (common random numbers)', () => {
  const R = runSim(mkPayload()); assert.deepEqual(R.A.make, R.B.make); assert.deepEqual(R.A.sumW, R.B.sumW);
});
test('a player who is out scores zero; a bye (p=0, m=0) scores zero; expected score = projection x chance to play', () => {
  const p = mkPayload(); p._pl[0].p = 0;
  const R = runSim(p); assert.equal(R.A.userPts[0], 0); assert.ok(R.A.userWin[0] < 0.01);
  const q = mkPayload(); q._pl[0].p = 0.5; q._pl[0].m = 30; q._pl[0].sd = 8;
  const R2 = runSim(q); assert.ok(Math.abs(R2.A.userPts[0] - 15) < 0.8, 'mean about 15, got ' + R2.A.userPts[0]);
});
test('scores are truncated at zero', () => {
  const q = mkPayload(); q._pl[0].m = 0; q._pl[0].sd = 20;
  const R = runSim(q); assert.ok(R.A.userPts[0] > 0, 'truncation lifts the mean above 0'); assert.ok(R.A.userPts[0] < 9);
});
test('auto-sub replaces a starter who does not play with the best eligible bench player', () => {
  const q = mkPayload({ autoSub: true }); q._pl[0].p = 0;
  q._wk.lineups[0].bn = [{ i: 1, pos: 'WR' }]; // team 0 benches player 1 (also a 20-point WR)
  const on = runSim(q); assert.ok(on.A.userPts[0] > 15, 'sub scored ' + on.A.userPts[0]);
  const off = runSim(mkPayload({ autoSub: false, ...{} })); // unchanged baseline
  const q2 = mkPayload({ autoSub: false }); q2._pl[0].p = 0; q2._wk.lineups[0].bn = [{ i: 1, pos: 'WR' }];
  assert.equal(runSim(q2).A.userPts[0], 0);
  const q3 = mkPayload({ autoSub: true }); q3._pl[0].p = 0; q3._wk.lineups[0].bn = [{ i: 1, pos: 'RB' }];
  assert.equal(runSim(q3).A.userPts[0], 0, 'an ineligible bench player is not subbed in');
});
test('empty starting slots score zero and do not crash', () => {
  const q = mkPayload(); q._wk.lineups[0] = { st: [{ i: -1, el: ['WR'] }], bn: [] };
  const R = runSim(q); assert.equal(R.A.userPts[0], 0);
});
test('a better lineup raises playoff odds; ranks sum to one', () => {
  const q = mkPayload(); q._pl[0].m = 30; const R = runSim(q);
  assert.ok(R.A.make[0] > 0.8); assert.ok(Math.abs(R.A.seed[0].reduce((s, x) => s + x, 0) - 1) < 1e-9);
});
test('median game leagues give every team a second chance at a win', () => {
  const R = runSim(mkPayload({ median: true })); assert.ok(R.A.sumW.reduce((s, x) => s + x, 0) > 3.9, 'about 2 matchup wins + 2 median wins across 4 teams');
});

// ----- Server-side data model -----
test('injury designations map to play probabilities, and later weeks are less certain', () => {
  assert.equal(playProb('Active', 'Out', null, 0), 0); assert.ok(playProb('Active', 'Out', null, 1) > 0);
  assert.equal(playProb('Injured Reserve', 'IR', null, 3), 0);
  assert.ok(playProb('Active', 'Doubtful') < 0.2);
  const q = playProb('Active', 'Questionable'); assert.ok(q >= 0.5 && q <= 0.75);
  assert.ok(playProb('Active', 'Questionable', 'Full') > playProb('Active', 'Questionable', 'DNP'));
  assert.ok(playProb('Active', null) > 0.9);
});
test('rolling projection: weights recent games, shrinks thin samples, handles no history', () => {
  const a = rollingProjection([20, 10, 10, 10, 10], 'WR'), b = rollingProjection([10, 10, 10, 10, 20], 'WR');
  assert.ok(a.mean > b.mean, 'newest game counts more');
  const thin = rollingProjection([30], 'WR'); assert.ok(thin.mean < 20, 'one big game is pulled toward replacement level');
  const none = rollingProjection([], 'QB'); assert.ok(none.mean > 0 && none.n === 0);
  const r = rollingProjection([5, 12, 9, 20, 7, 15], 'RB'); assert.ok(r.floor <= r.mean && r.mean <= r.ceil);
});
test('matchup multipliers are clamped to 0.90-1.10 and shrunk toward 1 early', () => {
  const allowed = { A: { QB: { pts: 32, g: 2 } }, B: { QB: { pts: 28, g: 2 } }, C: { QB: { pts: 30, g: 2 } } };
  const early = matchupMultipliers(allowed).A.QB.m;
  const late = matchupMultipliers({ A: { QB: { pts: 320, g: 20 } }, B: { QB: { pts: 280, g: 20 } }, C: { QB: { pts: 300, g: 20 } } });
  const wild = matchupMultipliers({ A: { QB: { pts: 400, g: 2 } }, B: { QB: { pts: 20, g: 2 } }, C: { QB: { pts: 30, g: 2 } } });
  assert.ok(wild.A.QB.m === 1.1 && wild.B.QB.m === 0.9, 'clamped');
  assert.ok(early > 1 && early < late.A.QB.m, 'less extreme with fewer games'); assert.ok(late.A.QB.m <= 1.1 && late.B.QB.m >= 0.9);
  assert.equal(late.B.QB.rank, 1, 'lowest points allowed = toughest'); assert.equal(late.A.QB.rank, 3);
});
test('weather: calm is neutral, wind and rain hurt passing and kicking a little, never a lot', () => {
  const calm = weatherFactors({ temp: 60, wind: 5, precip: 0, snow: 0 }); assert.equal(calm.QB, 1); assert.equal(calm.K, 1);
  const bad = weatherFactors({ temp: 25, wind: 30, precip: 0.3, snow: 0 });
  assert.ok(bad.QB < 0.9 && bad.QB >= 0.85); assert.ok(bad.K < 1 && bad.K > 0.8); assert.equal(bad.RB, 1);
});
test('betting line: favorite gets the higher implied total', () => {
  const v = vegasFor('KC -3.5', 48, 'KC', 'DEN'); assert.ok(v.KC.impl > v.DEN.impl); assert.equal(Math.round((v.KC.impl + v.DEN.impl) * 10) / 10, 48);
  assert.equal(vegasFor('', 0, 'KC', 'DEN'), null); assert.ok(vegasFor('EVEN', 44, 'KC', 'DEN').KC.impl === 22);
});
test('ESPN schedule parsing maps abbreviations', () => {
  const g = parseEspnWeek({ events: [{ date: '2026-11-15T18:00Z', competitions: [{ venue: { indoor: false }, competitors: [{ homeAway: 'home', team: { abbreviation: 'WSH' } }, { homeAway: 'away', team: { abbreviation: 'DAL' } }], odds: [{ details: 'DAL -2.5', overUnder: 44.5 }] }] }, { competitions: [] }] });
  assert.equal(g.length, 1); assert.equal(g[0].home, 'WAS'); assert.equal(g[0].total, 44.5);
  assert.deepEqual(parseEspnWeek(null), []);
});
test('league scoring is applied to raw stats; pts_ppr is the fallback', () => {
  assert.equal(scoreLine({ rec: 5, rec_yd: 50 }, { rec: 1, rec_yd: 0.1 }), 10);
  assert.equal(scoreLine({ pts_ppr: 12.5 }, null), 12.5); assert.equal(scoreLine(null, {}), null);
});
test('projection provider adapter can be swapped', async () => {
  const out = await getProjections(5, { players: { a: { pos: 'WR' } }, history: { a: [10, 12] } }, 'rolling'); assert.ok(out.a.mean > 0 && out.a.src);
});
