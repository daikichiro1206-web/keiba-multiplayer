'use strict';
/* NPC AI 計測ハーネス: サーバー本体を require し、観戦モード（全頭NPC）の
 * レースを実時間なしで回して隊列・展開・着順の統計を取る。
 * 使い方: node tools/sim-npc.js [レース数] [距離] [馬場id|random]
 * 例:     node tools/sim-npc.js 12 2000 ryo
 */
const S = require('../server.js');
const CAT = S.CAT;

const RACES = Number(process.argv[2]) || 8;
const DIST = Number(process.argv[3]) || 2000;
const GOING_ARG = process.argv[4] || 'ryo';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function runRace(fieldNames, goingId) {
  const form = {};
  for (const n of fieldNames) form[n] = 1;
  const room = {
    code: 'SIM', state: 'racing', members: new Map(), npcs: [], results: null,
    tickTimer: null, finishTimer: null, raceStartAt: Date.now(),
    mode: 'watch', raceDist: DIST, grade: 'normal', going: CAT.GOING_LIST[0],
    owner: null, betId: null, watchSession: { field: fieldNames, form }, firstFinishAt: null,
    paceHeat: 0, raceClock: 0, solo: false,
  };
  S.buildField(room);
  if (goingId !== 'random') room.going = CAT.GOING_LIST.find(g => g.id === goingId) || CAT.GOING_LIST[0];
  const goingUsed = room.going.id;
  const npcs = room.npcs;
  if (npcs.length !== 18) throw new Error('field size ' + npcs.length);

  const dt = 1 / 30;
  let pairSec = 0, deepPairSec = 0;
  let spread400 = null, spreadMid = null, spreadLate = null;
  let rankAtLate = null; // 先頭が L-400 到達時点の順位スナップショット
  let paceHeatMax = -9;
  const kickStartDist = {}; // 馬ごとの「最終局面で pushL になった距離」
  let nan = false;
  let paceHeatSettled = null;
  let guard = 0;
  while (guard++ < 300 * 30) {
    S.tickNpcs(room, dt, Date.now());
    if (room.paceHeat > paceHeatMax) paceHeatMax = room.paceHeat;
    // 重なり蓄積
    for (let i = 0; i < npcs.length; i++) for (let j = i + 1; j < npcs.length; j++) {
      const a = npcs[i], b = npcs[j];
      if (a.finished || b.finished) continue;
      const dd = Math.abs(b.dist - a.dist), ld = Math.abs(b.lat - a.lat);
      if (dd < 2.9 && ld < 1.04) pairSec += dt;
      if (dd < 1.2 && ld < 0.55) deepPairSec += dt;
      if (!Number.isFinite(a.dist + a.speed + a.lat)) nan = true;
    }
    const alive = npcs.filter(n => !n.finished);
    const lead = Math.max(...npcs.map(n => n.dist));
    if (paceHeatSettled === null && lead >= DIST * 0.45) paceHeatSettled = Math.round(room.paceHeat * 100) / 100;
    const spread = alive.length > 1 ? Math.max(...alive.map(n => n.dist)) - Math.min(...alive.map(n => n.dist)) : 0;
    if (spread400 === null && lead >= 400) spread400 = spread;
    if (spreadMid === null && lead >= DIST * 0.5) spreadMid = spread;
    if (spreadLate === null && lead >= DIST - 400) {
      spreadLate = spread;
      rankAtLate = [...npcs].sort((a, b) => b.dist - a.dist).map(n => n.nickname);
    }
    for (const n of npcs) {
      if (kickStartDist[n.nickname] === undefined && n.pace === 'pushL' && n.dist > DIST * 0.5 && !n.finished) {
        kickStartDist[n.nickname] = Math.round(n.dist);
      }
    }
    if (npcs.every(n => n.finished)) break;
  }
  const standings = [...npcs].sort((a, b) => (a.finishClock ?? 1e9) - (b.finishClock ?? 1e9));
  const finalRank = standings.map(n => n.nickname);
  let placeChanges = 0, placeDeltaSum = 0;
  if (rankAtLate) {
    for (const name of finalRank) {
      const d = Math.abs(rankAtLate.indexOf(name) - finalRank.indexOf(name));
      if (d > 0) placeChanges++;
      placeDeltaSum += d;
    }
  }
  const byStyle = {};
  standings.forEach((n, i) => { (byStyle[n.styleKey] = byStyle[n.styleKey] || []).push(i + 1); });
  const styleLateGain = {}; // 残り400m時点→ゴールでの順位ゲイン（+＝追い上げた）
  if (rankAtLate) {
    for (const n of npcs) {
      const g = rankAtLate.indexOf(n.nickname) - finalRank.indexOf(n.nickname);
      (styleLateGain[n.styleKey] = styleLateGain[n.styleKey] || []).push(g);
    }
    for (const k of Object.keys(styleLateGain)) styleLateGain[k] = Math.round(styleLateGain[k].reduce((s, v) => s + v, 0) / styleLateGain[k].length * 10) / 10;
  }
  const styleAvg = {};
  for (const k of Object.keys(byStyle)) styleAvg[k] = Math.round(byStyle[k].reduce((s, v) => s + v, 0) / byStyle[k].length * 10) / 10;
  const ratingsDesc = [...npcs].sort((a, b) => b.rating - a.rating).map(n => n.nickname);
  const winnerRatingRank = ratingsDesc.indexOf(finalRank[0]) + 1;
  const kicks = Object.values(kickStartDist);
  const kickMean = kicks.reduce((s, v) => s + v, 0) / kicks.length;
  const kickSd = Math.sqrt(kicks.reduce((s, v) => s + (v - kickMean) ** 2, 0) / kicks.length);
  return {
    going: goingUsed, winTime: standings[0].finishClock, winner: standings[0].horseName,
    winnerStyle: standings[0].styleKey, winnerRatingRank,
    styleAvg, styleLateGain, spread400, spreadMid, spreadLate, placeChanges, placeDeltaSum,
    paceHeatMax: Math.round(paceHeatMax * 100) / 100, paceHeatSettled,
    kickSd: Math.round(kickSd), kickRange: [Math.min(...kicks), Math.max(...kicks)],
    pairSec: Math.round(pairSec * 10) / 10, deepPairSec: Math.round(deepPairSec * 10) / 10,
    allFinished: npcs.every(n => n.finished), nan,
    lastTime: standings[standings.length - 1].finishClock,
  };
}

const names = CAT.HORSES.map(h => h.name);
const results = [];
for (let r = 0; r < RACES; r++) {
  const pool = [...names];
  const field = [];
  while (field.length < 18) field.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  results.push(runRace(field, GOING_ARG));
}
const avg = k => Math.round(results.reduce((s, r) => s + r[k], 0) / results.length * 10) / 10;
const paceClass = ph => ph == null ? '?' : ph > 0.15 ? 'ハイ' : ph < -0.15 ? 'スロー' : 'ミドル';
console.log(`== NPCシミュレーション ${RACES}レース / ${DIST}m / 馬場=${GOING_ARG} ==`);
console.log('全頭完走:', results.every(r => r.allFinished), '| NaN:', results.some(r => r.nan));
console.log('勝ち時計 平均:', avg('winTime'), 's | 最下位 平均:', avg('lastTime'), 's');
console.log('馬群の広がり 平均: 400m', avg('spread400'), 'm / 中間', avg('spreadMid'), 'm / 残り400m', avg('spreadLate'), 'm');
console.log('残り400m→ゴールで順位が動いた頭数 平均:', avg('placeChanges'), '頭 | 順位変動量合計 平均:', avg('placeDeltaSum'));
console.log('ペース分類(先頭45%通過時点):', results.map(r => paceClass(r.paceHeatSettled)).reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {}), '| settled値:', results.map(r => r.paceHeatSettled).join(', '));
console.log('仕掛け開始距離のばらつき(標準偏差) 平均:', avg('kickSd'), 'm');
console.log('勝ち馬のレーティング順位(18頭中) 平均:', avg('winnerRatingRank'));
console.log('重なり pair秒 平均:', avg('pairSec'), '| 深い重なり pair秒 平均:', avg('deepPairSec'));
const styleAgg = {};
for (const r of results) for (const [k, v] of Object.entries(r.styleAvg)) { (styleAgg[k] = styleAgg[k] || []).push(v); }
for (const [k, arr] of Object.entries(styleAgg)) console.log(`脚質別 平均着順 ${k}:`, Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 10) / 10, `(${arr.length}レース)`);
const gainAgg = {};
for (const r of results) for (const [k, v] of Object.entries(r.styleLateGain || {})) { (gainAgg[k] = gainAgg[k] || []).push(v); }
for (const [k, arr] of Object.entries(gainAgg)) console.log(`脚質別 直線での順位ゲイン ${k}:`, Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 10) / 10, '位');
console.log('勝ち馬の脚質:', results.map(r => r.winnerStyle).reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {}));
console.log('ペース分類×勝ち馬脚質:', results.map(r => paceClass(r.paceHeatSettled) + ':' + r.winnerStyle).reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {}));
