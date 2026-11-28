'use strict';
/* NPC AI の単体検証（サーバー本体を require して観戦モードの全NPCレースを回す）:
 * - 個体特性（加速力/持久力/コーナリング/瞬発力/気性）が全馬ぶん設計範囲内で、
 *   同じ馬では再現性があること
 * - 気性が高い馬ほどゲートの大出遅れが多いこと（統計）
 * - 1200mレースが全頭完走し、仕掛け開始位置が全馬同時にならず（ばらつきあり）、
 *   最終直線で順位変動が起きること
 * - 距離マトリクス（1200/1600/2000/2400m）で全頭完走し勝ち時計が距離相応で、
 *   2400mでは1回目のゴール板通過（レース座標400m）でゴール判定が誤発動しないこと
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

function runWatchRace(raceDist, hook) {
  const names = CAT.HORSES.map(h => h.name);
  const pool = [...names];
  const field = [];
  while (field.length < 18) field.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  const form = {}; for (const n of field) form[n] = 1;
  const room = {
    code: 'TEST', state: 'racing', members: new Map(), npcs: [], results: null,
    tickTimer: null, finishTimer: null, raceStartAt: Date.now(),
    mode: 'watch', raceDist, grade: 'normal', going: CAT.GOING_LIST[0],
    owner: null, betId: null, watchSession: { field, form }, firstFinishAt: null,
    paceHeat: 0, raceClock: 0, solo: false,
  };
  S.buildField(room);
  const dt = 1 / 30;
  let guard = 0;
  while (guard++ < 300 * 30) {
    S.tickNpcs(room, dt, Date.now());
    if (hook) hook(room);
    if (room.npcs.every(n => n.finished)) break;
  }
  return room;
}

console.log('— NPCレース（1200m・全頭NPC ×5レース集計） —');
{
  let allFinished = true, nan = false, winTimes = [], kickSds = [], changedTotal = 0, oikoGains = [];
  for (let race = 0; race < 5; race++) {
    const kickStart = {};
    let rankAtLate = null;
    const room = runWatchRace(1200, (rm) => {
      const lead = Math.max(...rm.npcs.map(n => n.dist));
      if (rankAtLate === null && lead >= 800) rankAtLate = [...rm.npcs].sort((a, b) => b.dist - a.dist).map(n => n.nickname);
      for (const n of rm.npcs) {
        if (!Number.isFinite(n.dist + n.speed + n.lat)) nan = true;
        if (kickStart[n.nickname] === undefined && n.pace === 'pushL' && n.dist > 600 && !n.finished) kickStart[n.nickname] = n.dist;
      }
    });
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
  ok(winTimes.every(t => t > 50 && t < 90), `勝ち時計が妥当な範囲 (${winTimes.map(t => t.toFixed(1)).join('/')}s / 1200m)`);
  const kickSdAvg = kickSds.reduce((s, v) => s + v, 0) / kickSds.length;
  ok(kickSdAvg > 8, `仕掛け開始位置が全馬同時でない (標準偏差 平均 ${kickSdAvg.toFixed(0)}m)`);
  ok(changedTotal >= 25, `残り400mからゴールまでに順位変動がある (5レース合計 ${changedTotal}頭)`);
  const oikoGainAvg = oikoGains.length ? oikoGains.reduce((s, v) => s + v, 0) / oikoGains.length : 0;
  console.log(`  ℹ️ 参考: 1200mでの追込ゲイン (n=${oikoGains.length}, 平均 ${oikoGainAvg.toFixed(1)} 位) — 短距離では平均≈0で統計判定できないため、末脚の検証は下の2000mブロックで行う`);
}

console.log('— 追込の末脚（2000m・全頭NPC ×3レース集計） —');
{
  // 追込の「直線で順位を上げる」挙動の検証。1200mでは残り400m地点からの
  // ゲインが平均≈0（実測: プラス率44〜48%）で統計的に判定できないため、
  // 末脚が効く2000mで測る（フェーズ20の実測では平均 +2.5 位）。
  const gains = [];
  for (let r = 0; r < 3; r++) {
    let rankAtLate = null;
    const room = runWatchRace(2000, (rm) => {
      const lead = Math.max(...rm.npcs.map(n => n.dist));
      if (rankAtLate === null && lead >= 1600) rankAtLate = [...rm.npcs].sort((a, b) => b.dist - a.dist).map(n => n.nickname);
    });
    const finalRank = [...room.npcs].sort((a, b) => (a.finishClock ?? 1e9) - (b.finishClock ?? 1e9)).map(n => n.nickname);
    for (const n of room.npcs) if (n.styleKey === 'oikomi') gains.push(rankAtLate.indexOf(n.nickname) - finalRank.indexOf(n.nickname));
  }
  const avg = gains.length ? gains.reduce((s, v) => s + v, 0) / gains.length : 0;
  ok(gains.length >= 3 && avg > 0, `追込が直線で順位を上げる (2000m, n=${gains.length}, 平均 ${avg.toFixed(1)} 位ゲイン)`);
}

console.log('— NPCレース（距離マトリクス 1200/1600/2000/2400m） —');
{
  // 勝ち時計の目安: 1200≒68s / 1600≒92s / 2000≒113s / 2400≒145s
  const ranges = { 1200: [55, 85], 1600: [78, 112], 2000: [98, 132], 2400: [125, 175] };
  for (const dist of CAT.DISTANCES) {
    let earlyFinish = false;
    const room = runWatchRace(dist, (rm) => {
      // ゴール判定はレース距離到達でのみ発動すること（2400mで1回目の
      // ゴール板通過＝レース座標400m地点を finished と誤認しないこと）
      for (const n of rm.npcs) if (n.finished && n.dist < dist - 0.01) earlyFinish = true;
    });
    const standings = [...room.npcs].sort((a, b) => (a.finishClock ?? 1e9) - (b.finishClock ?? 1e9));
    const wt = standings[0].finishClock;
    const [lo, hi] = ranges[dist];
    ok(room.npcs.every(n => n.finished), `${dist}m: 全頭完走`);
    ok(!earlyFinish, `${dist}m: 距離到達前にゴール扱いにならない`);
    ok(wt > lo && wt < hi, `${dist}m: 勝ち時計 ${wt ? wt.toFixed(1) : '?'}s（目安 ${lo}〜${hi}s）`);
  }
  // 2400m専用: 先頭が1回目のゴール板（レース座標400m＝物理ゴール位置）を
  // 通過した瞬間、誰も finished になっておらずレースが続行すること
  let atFirstPass = null;
  runWatchRace(2400, (rm) => {
    const lead = Math.max(...rm.npcs.map(n => n.dist));
    if (atFirstPass === null && lead >= 400) atFirstPass = rm.npcs.filter(n => n.finished).length;
  });
  ok(atFirstPass === 0, '2400m: 1回目のゴール板通過時にゴール判定が誤発動しない');
}

console.log('— 距離適性・賞金（カタログ） —');
{
  ok(CAT.DISTANCES.join(',') === '1200,1600,2000,2400', '距離は 1200/1600/2000/2400 の4種');
  ok(CAT.HORSES.every(h => Array.isArray(h.apt) && h.apt.length === 4), '全50頭の距離適性が4区分（短/マイル/中/長）');
  const p = [1200, 1600, 2000, 2400].map(d => CAT.prizeForRank(1, 'normal', d));
  ok(p.join(',') === '800,1100,1500,2000', `1着賞金は距離順に増える (${p.join('/')}G)`);
  ok(CAT.RACE_INFO[2400].category === '長距離' && CAT.RACE_INFO[1200].category === '短距離', 'レース名カテゴリ: 1200=短距離 / 2400=長距離');
}

console.log(failures === 0 ? '\n🎉 NPC TESTS ALL PASS' : `\n💥 ${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
