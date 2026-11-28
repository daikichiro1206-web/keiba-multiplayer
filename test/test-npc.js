'use strict';
/* NPC AI の単体検証（サーバー本体を require して観戦モードの全NPCレースを回す）:
 * - 個体特性（加速力/持久力/コーナリング/瞬発力/気性）が全馬ぶん設計範囲内で、
 *   同じ馬では再現性があること
 * - 気性が高い馬ほどゲートの大出遅れが多いこと（統計）
 * - 1000mレースが全頭完走し、仕掛け開始位置が全馬同時にならず（ばらつきあり）、
 *   最終直線で順位変動が起きること
 */
const S = require('../server.js');
const CAT = S.CAT;

let failures = 0;
const ok = (cond, label) => { console.log((cond ? '  ✅ ' : '  ❌ ') + label); if (!cond) failures++; };

console.log('— NPC個体特性 —');
{
  const room = { raceDist: 2000 };
  let inRange = true, deterministic = true;
  for (const h of CAT.HORSES) {
    const a = S.makeNpc(room, h, 0, 'J', 1, 0, h.styleKey);
    const b = S.makeNpc(room, h, 0, 'J', 1, 0, h.styleKey);
    if (!(a.accelMul >= 0.88 && a.accelMul <= 1.12)) inRange = false;
    if (!(a.endureMul >= 0.92 && a.endureMul <= 1.08)) inRange = false;
    if (!(a.cornerMul >= 0.90 && a.cornerMul <= 1.10)) inRange = false;
    if (!(a.burstMul >= 0.97 && a.burstMul <= 1.03)) inRange = false;
    if (!(a.temper >= 0 && a.temper < 1)) inRange = false;
    if (a.accelMul !== b.accelMul || a.temper !== b.temper || a.burstMul !== b.burstMul) deterministic = false;
  }
  ok(inRange, '特性値（加速/持久/コーナー/瞬発/気性）が全50頭で設計範囲内');
  ok(deterministic, '特性値は同じ馬で常に同じ（レースを跨いで安定）');
  const traits = CAT.HORSES.map(h => S.makeNpc(room, h, 0, 'J', 1, 0, h.styleKey).accelMul);
  ok(new Set(traits.map(v => v.toFixed(3))).size >= 40, '特性値は馬ごとに異なる（全馬同一ではない）');
}

console.log('— 気性とゲート —');
{
  // rollGateT は server.js 内部関数なので、makeNpc 経由の gateT 分布で検証する
  const room = { raceDist: 2000 };
  const badRate = temperWanted => {
    let bad = 0, n = 0;
    for (let i = 0; i < 3000; i++) {
      const h = CAT.HORSES[i % CAT.HORSES.length];
      const npc = S.makeNpc(room, h, 0, 'J', 1, 0, h.styleKey);
      if (Math.abs(npc.temper - temperWanted) > 0.25) continue;
      n++; if (npc.gateT >= 1.2) bad++;
    }
    return n ? bad / n : 0;
  };
  const calm = badRate(0), hot = badRate(1);
  ok(hot > calm + 0.04, `気性の荒い馬ほど大出遅れが多い (穏やか ${(calm * 100).toFixed(0)}% / 荒い ${(hot * 100).toFixed(0)}%)`);
}

console.log('— NPCレース（1000m・全頭NPC ×5レース集計） —');
{
  const names = CAT.HORSES.map(h => h.name);
  let allFinished = true, nan = false, winTimes = [], kickSds = [], changedTotal = 0, oikoGains = [];
  for (let race = 0; race < 5; race++) {
    const pool = [...names];
    const field = [];
    while (field.length < 18) field.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    const form = {}; for (const n of field) form[n] = 1;
    const room = {
      code: 'TEST', state: 'racing', members: new Map(), npcs: [], results: null,
      tickTimer: null, finishTimer: null, raceStartAt: Date.now(),
      mode: 'watch', raceDist: 1000, grade: 'normal', going: CAT.GOING_LIST[0],
      owner: null, betId: null, watchSession: { field, form }, firstFinishAt: null,
      paceHeat: 0, raceClock: 0, solo: false,
    };
    S.buildField(room);
    const dt = 1 / 30;
    const kickStart = {};
    let rankAtLate = null, guard = 0;
    while (guard++ < 200 * 30) {
      S.tickNpcs(room, dt, Date.now());
      const lead = Math.max(...room.npcs.map(n => n.dist));
      if (rankAtLate === null && lead >= 600) rankAtLate = [...room.npcs].sort((a, b) => b.dist - a.dist).map(n => n.nickname);
      for (const n of room.npcs) {
        if (!Number.isFinite(n.dist + n.speed + n.lat)) nan = true;
        if (kickStart[n.nickname] === undefined && n.pace === 'pushL' && n.dist > 500 && !n.finished) kickStart[n.nickname] = n.dist;
      }
      if (room.npcs.every(n => n.finished)) break;
    }
    if (!room.npcs.every(n => n.finished)) allFinished = false;
    const standings = [...room.npcs].sort((a, b) => (a.finishClock ?? 1e9) - (b.finishClock ?? 1e9));
    winTimes.push(standings[0].finishClock);
    const kicks = Object.values(kickStart);
    const mean = kicks.reduce((s, v) => s + v, 0) / kicks.length;
    kickSds.push(Math.sqrt(kicks.reduce((s, v) => s + (v - mean) ** 2, 0) / kicks.length));
    const finalRank = standings.map(n => n.nickname);
    changedTotal += finalRank.filter(name => rankAtLate && rankAtLate.indexOf(name) !== finalRank.indexOf(name)).length;
    for (const n of room.npcs) if (n.styleKey === 'oikomi') oikoGains.push(rankAtLate.indexOf(n.nickname) - finalRank.indexOf(n.nickname));
  }
  ok(allFinished, 'NPC 18頭が全頭完走する（5レースとも）');
  ok(!nan, '位置・速度に NaN が出ない');
  ok(winTimes.every(t => t > 35 && t < 70), `勝ち時計が妥当な範囲 (${winTimes.map(t => t.toFixed(1)).join('/')}s / 1000m)`);
  const kickSdAvg = kickSds.reduce((s, v) => s + v, 0) / kickSds.length;
  ok(kickSdAvg > 8, `仕掛け開始位置が全馬同時でない (標準偏差 平均 ${kickSdAvg.toFixed(0)}m)`);
  ok(changedTotal >= 25, `残り400mからゴールまでに順位変動がある (5レース合計 ${changedTotal}頭)`);
  const oikoGainAvg = oikoGains.length ? oikoGains.reduce((s, v) => s + v, 0) / oikoGains.length : 0;
  ok(oikoGains.length >= 5 && oikoGainAvg > 0, `追込が直線で順位を上げる (n=${oikoGains.length}, 平均 ${oikoGainAvg.toFixed(1)} 位ゲイン)`);
}

console.log(failures === 0 ? '\n🎉 NPC TESTS ALL PASS' : `\n💥 ${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
