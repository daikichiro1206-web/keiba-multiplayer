'use strict';
/* 自動テスト: サーバーを起動し、wsクライアントで
 * マルチ: 登録→部屋作成→参加→馬選択→準備→カウントダウン→レース→位置同期→ゴール→着順表
 * ソロ:   登録→soloStart→カウントダウン→レース→ゴール→着順表
 * まで通ることを確認する。
 *
 * フェーズ3（サーバー権威化）対応:
 * - ゴール判定はサーバーが検証した位置ストリームだけで行われる。
 *   テストでは上限速度を環境変数 KEIBA_MAX_SPEED=600 に緩和したうえで、
 *   その範囲内（約480m/s）の申告ストリームを送って完走させる。
 * - チート検証: いきなり dist=2000 を申告しても受理されず（補正され）、
 *   ゴール扱いにならないことを state 配信で確認する。
 * - テスト用サーバーは DATA_DIR を一時フォルダに向ける（本番データを汚さない）。
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3456;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const ok = (cond, label) => { console.log((cond ? '  ✅ ' : '  ❌ ') + label); if (!cond) failures++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

async function auth(nickname, password) {
  const r = await fetch(BASE + '/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('auth failed: ' + JSON.stringify(j));
  return j;
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const client = { ws, inbox: [], waiters: [] };
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      client.inbox.push(m);
      client.waiters = client.waiters.filter(w => !w(m));
    });
    client.waitFor = (type, timeout = 15000) => new Promise((res, rej) => {
      const found = client.inbox.find(m => m.type === type);
      if (found) return res(found);
      const to = setTimeout(() => rej(new Error('timeout waiting for ' + type)), timeout);
      client.waiters.push(m => { if (m.type === type) { clearTimeout(to); res(m); return true; } return false; });
    });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', token })); resolve(client); });
    ws.on('error', reject);
  });
}
const send = (c, o) => c.ws.send(JSON.stringify(o));

// 検証済みストリームだけで完走させる（上限600m/sの範囲内: 12m/25ms ≒ 480m/s）
async function driveToFinish(c, target = 2000) {
  let dist = 0;
  while (dist < target) {
    dist = Math.min(target, dist + 12);
    send(c, { type: 'pos', dist, lane: 3, speed: 17 });
    await wait(25);
  }
}

async function raceToFinish(c, label, nickname, cheatCheck = false) {
  const cd = await c.waitFor('countdown');
  ok(cd.field && cd.field.length === 18, `${label}: カウントダウン＋出走表18頭`);
  await c.waitFor('raceStart');
  ok(true, `${label}: レース開始`);
  const stateWaiter = c.waitFor('state', 20000).then(() => true).catch(() => false);

  if (cheatCheck) {
    // いきなりゴール申告（dist=2000連打）→ サーバーが補正し、ゴール扱いしないこと
    for (let i = 0; i < 3; i++) send(c, { type: 'pos', dist: 2000, lane: 3, speed: 999 });
    await wait(500);
    const states = c.inbox.filter(m => m.type === 'state');
    const last = states[states.length - 1];
    const me = last && last.runners.find(r => r.nickname === nickname);
    ok(!!me && me.dist < 500 && !me.finished, `${label}: 距離ジャンプ申告は補正され未ゴール（受理距離=${me ? me.dist : '?'}m）`);
    ok(!c.inbox.some(m => m.type === 'results'), `${label}: ジャンプだけでは結果が確定しない`);
  }

  await driveToFinish(c);
  const sawState = await stateWaiter;
  ok(sawState, `${label}: サーバーから位置同期(state)を受信`);
  const results = await c.waitFor('results', 60000);
  return results;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keiba-test-data-'));
  /* 残高フロア移行（フェーズ23）の検証用: フラグの無い旧形式プレイヤーを
     事前に仕込む。低残高（777G）は10,000Gへ底上げされ、高残高（12,345G）は
     不変のはず。また底上げは一度きりで、消費後に再ログインしても戻らない。 */
  const stamp0 = Date.now() % 100000;
  const oldLowName = '旧低残高' + stamp0, oldHighName = '旧高残高' + stamp0;
  const mkOld = (balance) => {
    const salt = 'oldsalt' + Math.random().toString(36).slice(2, 8);
    return {
      salt, passHash: crypto.scryptSync('pass-old', salt, 32).toString('hex'),
      balance, unlocked: ['sodashi', 'mcqueen', 'vodka', 'duramente'], wins: 0, races: 0,
    };
  };
  fs.writeFileSync(path.join(dataDir, 'players.json'), JSON.stringify({
    [oldLowName]: mkOld(777), [oldHighName]: mkOld(12345),
  }));
  const server = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT, DATA_DIR: dataDir, KEIBA_MAX_SPEED: '600', KEIBA_GATE_TIMING_MS: '2500' },
    stdio: 'pipe',
  });
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  try {
    await wait(1200);

    console.log('— ヘルスチェック / 解放API —');
    const health = await fetch(BASE + '/health');
    const hj = await health.json();
    ok(health.status === 200 && hj.ok === true, 'GET /health が200で応答');

    console.log('— 残高フロア移行（フェーズ23） —');
    const oldLow = await auth(oldLowName, 'pass-old');
    ok(oldLow.profile.balance === 10000, '移行: 旧プレイヤー（777G）は10,000Gへ底上げ');
    const oldHigh = await auth(oldHighName, 'pass-old');
    ok(oldHigh.profile.balance === 12345, '移行: 旧プレイヤー（12,345G）は不変');
    const buyOld = await fetch(BASE + '/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: oldLow.token, horseId: 'equinox' }) });
    ok(buyOld.status === 200, '移行: 底上げ後に解放購入できる');
    const oldLow2 = await auth(oldLowName, 'pass-old');
    ok(oldLow2.profile.balance === 5000, '移行: 底上げは一度きり（消費後の再ログインで戻らない）');

    console.log('— マルチプレイ フロー —');
    const stamp = Date.now() % 100000;
    const a = await auth('テストA' + stamp, 'pass-a');
    const b = await auth('テストB' + stamp, 'pass-b');
    ok(a.profile.balance === 10000, '登録: 初期所持金10000G（フェーズ22）');
    ok(a.profile.unlocked.length >= 8, '登録: 初期解放馬あり（フェーズ22で8頭）');
    const bad = await fetch(BASE + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'テストA' + stamp, password: 'wrong' }) });
    ok(bad.status === 401, 'ログイン: 合言葉違いを拒否');

    // 初期1万Gでは最上位（5000G）も買える。2頭買って残高0にし、所持金不足の拒否を確認する
    const buyEq = await fetch(BASE + '/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: a.token, horseId: 'equinox' }) });
    ok(buyEq.status === 200, '解放API: 5000Gの馬を初期所持金で解放できる');
    const buyAl = await fetch(BASE + '/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: a.token, horseId: 'almond' }) });
    ok(buyAl.status === 200, '解放API: 2頭目の5000Gも解放できる（残高0）');
    const unlockPoor = await fetch(BASE + '/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: a.token, horseId: 'contrail' }) });
    ok(unlockPoor.status === 400, '解放API: 所持金不足（4000Gの馬）を拒否');
    const catRes = await fetch(BASE + '/api/horses');
    const catJ = await catRes.json();
    ok(Array.isArray(catJ) && catJ.length === 50, '名簿: 実在50頭');
    ok(catJ.some(h => h.id === 'croix' && h.name === 'クロワデュノール'), '名簿: 推し馬クロワデュノールがいる');
    ok(catJ.filter(h => h.price === 0).length === 8, '名簿: 初期解放は8頭（0G、フェーズ22）');
    ok(['nige', 'senko', 'sashi', 'oikomi'].every(k => catJ.some(h => h.price === 0 && h.styleKey === k)), '名簿: 初期解放は全脚質をカバー');
    ok(catJ.filter(h => h.price === 0 && h.rating >= 90).length >= 4, '名簿: 初期解放にレーティング90以上が4頭以上');
    const unlockDup = await fetch(BASE + '/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: a.token, horseId: a.profile.unlocked[0] }) });
    ok(unlockDup.status === 400, '解放API: 解放済みの二重解放を拒否');

    const ca = await connect(a.token);
    const cb = await connect(b.token);
    await ca.waitFor('welcome'); await cb.waitFor('welcome');
    ok(true, 'WS接続＋welcome');

    send(ca, { type: 'createRoom' });
    const roomMsg = await ca.waitFor('room');
    const code = roomMsg.room.code;
    ok(/^[A-Z2-9]{5}$/.test(code), `部屋作成: コード ${code}`);
    send(cb, { type: 'joinRoom', code });
    const joined = await cb.waitFor('room');
    ok(joined.room.players.length === 2, '参加: 2人がロビーに表示');
    send(cb, { type: 'selectHorse', horseId: a.profile.unlocked[1] });
    await wait(300);
    send(ca, { type: 'ready', ready: true });
    send(cb, { type: 'ready', ready: true });

    console.log('— ゲートタイミング合わせ（フェーズ35: 部屋レースの開始フロー） —');
    // 全員readyでも即発走せず、まずタイミング合わせフェーズに入る
    const gtA = await ca.waitFor('gateTiming');
    await cb.waitFor('gateTiming');
    ok(gtA.field && gtA.field.length === 18 && gtA.timeoutSec > 0, 'タイミング合わせ: 全員readyで gateTiming 配信（出走表18頭＋制限時間）');
    await wait(600);
    ok(!ca.inbox.some(m => m.type === 'countdown') && !ca.inbox.some(m => m.type === 'raceStart'),
      'タイミング合わせ: 誰も入力していない間はカウントダウンも発走もしない');
    send(ca, { type: 'gateInput', gateT: 0, boost: true }); // Aはパーフェクト入力
    await wait(500);
    ok(!ca.inbox.some(m => m.type === 'countdown'), 'タイミング合わせ: 1人だけ入力してもまだ始まらない');
    const roomGate = ca.inbox.filter(m => m.type === 'room').pop();
    ok(roomGate && roomGate.room.state === 'gateTiming'
      && roomGate.room.players.find(p => p.nickname === 'テストA' + stamp).gateDone === true
      && roomGate.room.players.find(p => p.nickname === 'テストB' + stamp).gateDone === false,
      'タイミング合わせ: 入力状況がロビー配信に反映される（A済み/B未）');
    send(cb, { type: 'gateInput', gateT: 1.5, boost: false }); // Bも入力 → 全員分が揃う
    const [ra, rb] = await Promise.all([
      raceToFinish(ca, 'A', 'テストA' + stamp, true),
      raceToFinish(cb, 'B', 'テストB' + stamp),
    ]);
    ok(ra.standings.length === 18, '結果: 着順表18頭');
    ok(ra.standings.some(s => s.nickname === 'テストA' + stamp) && ra.standings.some(s => s.nickname === 'テストB' + stamp), '結果: 両プレイヤーが着順表にいる');
    ok(ra.standings[0].place === 1 && ra.standings.every((s, i) => s.place === i + 1), '結果: 着順が連番で確定');
    const meA = ra.standings.find(s => s.nickname === 'テストA' + stamp);
    ok(meA && meA.dist === 2000, '結果: Aは検証済みストリームで2000m完走扱い');
    ok(rb.standings.length === 18, '結果: B側にも着順表が配信');
    const cdGate = ca.inbox.find(m => m.type === 'countdown');
    ok(cdGate && cdGate.gate && cdGate.gate['テストA' + stamp].gateT === 0 && cdGate.gate['テストA' + stamp].boost === true
      && cdGate.gate['テストB' + stamp].gateT === 1.5 && cdGate.gate['テストB' + stamp].boost === false,
      'タイミング合わせ: カウントダウンに各人の入力結果がそのまま同梱される');

    console.log('— 再戦フロー（フェーズ34: レース後の準備リセット） —');
    // inbox の現在位置以降に届いたメッセージだけを待つ（過去の同種メッセージに誤マッチしない）
    const waitSince = (c, mark, type, timeout = 20000) => new Promise((res, rej) => {
      const found = c.inbox.slice(mark).find(m => m.type === type);
      if (found) return res(found);
      const to = setTimeout(() => rej(new Error('timeout waiting for fresh ' + type)), timeout);
      c.waiters.push(m => { if (m.type === type) { clearTimeout(to); res(m); return true; } return false; });
    });
    const waitRoomWhere = (c, mark, pred, timeout = 10000) => new Promise((res, rej) => {
      const found = c.inbox.slice(mark).find(m => m.type === 'room' && pred(m.room));
      if (found) return res(found);
      const to = setTimeout(() => rej(new Error('timeout waiting for matching room')), timeout);
      c.waiters.push(m => { if (m.type === 'room' && pred(m.room)) { clearTimeout(to); res(m); return true; } return false; });
    });
    const rematchRace = async label => {
      const mA = ca.inbox.length, mB = cb.inbox.length;
      send(ca, { type: 'ready', ready: true });
      send(cb, { type: 'ready', ready: true });
      // フェーズ35: 部屋レースは ready → タイミング合わせ → 全員入力 → カウントダウン
      await waitSince(ca, mA, 'gateTiming');
      await waitSince(cb, mB, 'gateTiming');
      send(ca, { type: 'gateInput', gateT: 0.3, boost: false });
      send(cb, { type: 'gateInput', gateT: 0.8, boost: false });
      const cd = await waitSince(ca, mA, 'countdown');
      ok(cd.field && cd.field.length === 18, `${label}: カウントダウン＋出走表18頭`);
      ok(cd.gate && cd.gate['テストA' + stamp].gateT === 0.3 && cd.gate['テストB' + stamp].gateT === 0.8,
        `${label}: タイミング合わせの入力結果がカウントダウンに同梱`);
      await waitSince(cb, mB, 'countdown');
      await waitSince(ca, mA, 'raceStart');
      await Promise.all([driveToFinish(ca), driveToFinish(cb)]);
      const [rA, rB] = await Promise.all([
        waitSince(ca, mA, 'results', 60000),
        waitSince(cb, mB, 'results', 60000),
      ]);
      ok(rA.standings.length === 18 && rB.standings.length === 18, `${label}: 両者に着順表18頭`);
    };

    // 経路1: 結果画面で A が「ロビーに戻る」(backToLobby) → 全員の準備がリセットされる
    const mkA = ca.inbox.length, mkB = cb.inbox.length;
    send(ca, { type: 'backToLobby' });
    const roomResetA = await waitSince(ca, mkA, 'room', 10000);
    const roomResetB = await waitSince(cb, mkB, 'room', 10000);
    ok(roomResetA.room.state === 'lobby' && roomResetA.room.code === code, '再戦: backToLobbyで同じ部屋がロビーに戻る');
    ok(roomResetA.room.players.length === 2 && roomResetA.room.distance === 2000, '再戦: メンバーと距離はそのまま');
    ok(roomResetA.room.players.every(p => p.ready === false), '再戦: 全員の準備が未完了にリセット（A側配信）');
    ok(roomResetB.room.players.every(p => p.ready === false), '再戦: 全員の準備が未完了にリセット（B側配信）');
    await rematchRace('再戦1回目');

    // 経路2（復旧）: backToLobby を送らず B がいきなり ready を送っても固まらない
    const rkA = ca.inbox.length, rkB = cb.inbox.length;
    send(cb, { type: 'ready', ready: true });
    const recPred = room => room.state === 'lobby'
      && (room.players.find(p => p.nickname === 'テストB' + stamp) || {}).ready === true;
    const roomRecA = await waitRoomWhere(ca, rkA, recPred);
    await waitRoomWhere(cb, rkB, recPred);
    const recPa = roomRecA.room.players.find(p => p.nickname === 'テストA' + stamp);
    ok(recPa && recPa.ready === false, '復旧: finished で ready を送ると自動でロビーに戻り、本人だけ準備ON・他はリセット済み');
    const ckA = ca.inbox.length, ckB = cb.inbox.length;
    send(ca, { type: 'ready', ready: true });
    await waitSince(ca, ckA, 'gateTiming');
    await waitSince(cb, ckB, 'gateTiming');
    send(ca, { type: 'gateInput', gateT: 0.8, boost: false });
    send(cb, { type: 'gateInput', gateT: 0.8, boost: false });
    await waitSince(ca, ckA, 'countdown');
    await waitSince(cb, ckB, 'countdown');
    ok(true, '復旧: 全員ready→タイミング合わせ→カウントダウンが始まる');
    ca.ws.close(); cb.ws.close();

    console.log('— 僅差リプレイ判定（部屋レース・フェーズ34追加分） —');
    // 判定関数 closeFinishOf はクライアント（public/index.html）の純粋関数。
    // 実ファイルから抽出して単体確認し、部屋レースの実 standings でも検証する。
    const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const grabFn = re => { const m = htmlSrc.match(re); if (!m) throw new Error('抽出失敗: ' + re); return m[0]; };
    const closeFinishOf = new Function(
      grabFn(/const CLOSE_GAP_SEC = [0-9.]+;/) + '\n'
      + grabFn(/const PHOTO_GAP_SEC = [0-9.]+;/) + '\n'
      + grabFn(/function marginTerm\(diffSec\) \{[\s\S]*?\n\}/) + '\n'
      + grabFn(/function closeFinishOf\(standings\) \{[\s\S]*?\n\}/)
      + '\nreturn closeFinishOf;')();
    const mkStandings = (t1, t2) => [
      { nickname: 'X', horseName: '馬X', time: t1 }, { nickname: 'Y', horseName: '馬Y', time: t2 },
    ];
    // フェーズ36: 閾値はユーザー指定で 0.12秒 → 0.4秒 に緩和
    ok(closeFinishOf(mkStandings(100, 100.12)) !== null, '僅差判定: 着差0.12秒は発動');
    ok(closeFinishOf(mkStandings(100, 100.4)) !== null, '僅差判定: 着差0.40秒は発動（新閾値）');
    ok(closeFinishOf(mkStandings(100, 100.41)) === null, '僅差判定: 着差0.41秒は発動しない');
    ok(closeFinishOf(mkStandings(100, null)) === null, '僅差判定: 2着が未完走(time=null)は発動しない');
    // 写真判定フラグ: 写真判定の絵は着差 < 0.17秒（PHOTO_GAP_SEC）の場合だけ
    const ciPhoto = closeFinishOf(mkStandings(100, 100.1));
    ok(ciPhoto && ciPhoto.photo === true, '僅差判定: 着差0.10秒は写真判定フラグON');
    const ciEdge = closeFinishOf(mkStandings(100, 100.17));
    ok(ciEdge && ciEdge.photo === false, '僅差判定: 着差0.17秒は写真判定フラグOFF（< 0.17 が条件）');
    const ciWide = closeFinishOf(mkStandings(100, 100.3));
    ok(ciWide && ciWide.photo === false, '僅差判定: 着差0.30秒は発動するが写真判定フラグOFF（絵は出さない）');

    // 部屋レースで僅差を決定的に作る: 両者をゴール手前1190mまで進め、
    // 最後の pos を同タイミングで送って 1・2着の着差を ≈0 にする。
    const ca2 = await connect(a.token);
    const cb2 = await connect(b.token);
    await ca2.waitFor('welcome'); await cb2.waitFor('welcome');
    send(ca2, { type: 'createRoom', distance: 1200 });
    const closeRoom = await ca2.waitFor('room');
    send(cb2, { type: 'joinRoom', code: closeRoom.room.code });
    await cb2.waitFor('room');
    const cmA = ca2.inbox.length, cmB = cb2.inbox.length;
    send(ca2, { type: 'ready', ready: true });
    send(cb2, { type: 'ready', ready: true });
    await waitSince(ca2, cmA, 'gateTiming');
    send(ca2, { type: 'gateInput', gateT: 0.8, boost: false });
    send(cb2, { type: 'gateInput', gateT: 0.8, boost: false });
    await waitSince(ca2, cmA, 'countdown');
    await waitSince(ca2, cmA, 'raceStart');
    await Promise.all([driveToFinish(ca2, 1190), driveToFinish(cb2, 1190)]);
    await wait(300); // 両者の受理距離が 1190m に揃うのを待つ
    send(ca2, { type: 'pos', dist: 1200, lane: 3, speed: 17 });
    send(cb2, { type: 'pos', dist: 1200, lane: 3, speed: 17 });
    const [rcA, rcB] = await Promise.all([
      waitSince(ca2, cmA, 'results', 60000),
      waitSince(cb2, cmB, 'results', 60000),
    ]);
    ok(!rcA.standings[0].npc && !rcA.standings[1].npc, '部屋僅差: 1・2着は両プレイヤー');
    const closeGap = rcA.standings[1].time - rcA.standings[0].time;
    ok(closeGap <= 0.4, `部屋僅差: 1-2着の着差 ${closeGap.toFixed(3)}秒 ≤ 0.4秒（フェーズ36の閾値）`);
    const sig = r => r.standings.map(s => s.nickname + ':' + s.time).join('|');
    ok(sig(rcA) === sig(rcB), '部屋僅差: 両クライアントの着順・タイムが完全一致（サーバー確定値）');
    const ciA = closeFinishOf(rcA.standings), ciB = closeFinishOf(rcB.standings);
    ok(!!ciA && !!ciB && ciA.gap === ciB.gap && ciA.term === ciB.term && ciA.photo === ciB.photo && ciA.photo === true,
      `部屋僅差: 両クライアントで僅差判定が一致し発動（${ciA ? ciA.term : '—'}・写真判定フラグも一致）→ ボタン表示・自動再生の導線に乗る`);
    ca2.ws.close(); cb2.ws.close();

    console.log('— ゲートタイミング合わせ: タイムアウト自動確定（フェーズ35） —');
    // Bが最後まで入力しなくても、制限時間（テスト環境では2.5秒）で
    // 「ふつう（gateT 0.8）」として自動確定し、発走まで進むことを確認する。
    const ca3 = await connect(a.token);
    const cb3 = await connect(b.token);
    await ca3.waitFor('welcome'); await cb3.waitFor('welcome');
    send(ca3, { type: 'createRoom', distance: 1600 });
    const tRoom = await ca3.waitFor('room');
    send(cb3, { type: 'joinRoom', code: tRoom.room.code });
    await cb3.waitFor('room');
    const tmA = ca3.inbox.length, tmB = cb3.inbox.length;
    send(ca3, { type: 'ready', ready: true });
    send(cb3, { type: 'ready', ready: true });
    const gt3 = await waitSince(ca3, tmA, 'gateTiming');
    ok(gt3.timeoutSec === 2.5, 'タイムアウト: 制限時間（テスト環境2.5秒）が配信される');
    send(ca3, { type: 'gateInput', gateT: 0, boost: true }); // Aだけ入力。Bは無入力のまま
    const cdT = await waitSince(ca3, tmA, 'countdown', 15000);
    await waitSince(cb3, tmB, 'countdown', 15000);
    const gA3 = cdT.gate && cdT.gate['テストA' + stamp];
    const gB3 = cdT.gate && cdT.gate['テストB' + stamp];
    ok(gA3 && gA3.gateT === 0 && gA3.boost === true && gA3.auto === false,
      'タイムアウト: 入力した本人の判定（パーフェクト＋ブースト）がそのまま確定');
    ok(gB3 && gB3.gateT === 0.8 && gB3.boost === false && gB3.auto === true,
      'タイムアウト: 未入力者は制限時間で「ふつう（0.8秒）」として自動確定');
    await waitSince(ca3, tmA, 'raceStart', 10000);
    ok(true, 'タイムアウト: 自動確定のあと発走する（部屋が止まらない）');
    ca3.ws.close(); cb3.ws.close();

    console.log('— ロビーでの距離変更（フェーズ35追加） —');
    // 部屋を作った後でも、ロビーでホストが距離を変更できる。ゲストは変更不可。
    // 変更すると全員の準備が未完了にリセットされ、変更後の距離で発走する。
    const ca4 = await connect(a.token);
    const cb4 = await connect(b.token);
    await ca4.waitFor('welcome'); await cb4.waitFor('welcome');
    send(ca4, { type: 'createRoom', distance: 2000 });
    const dRoom = await ca4.waitFor('room');
    ok(dRoom.room.owner === 'テストA' + stamp, '距離変更: 部屋作成者がホストとして配信される');
    send(cb4, { type: 'joinRoom', code: dRoom.room.code });
    await cb4.waitFor('room');
    const dmB = cb4.inbox.length;
    send(cb4, { type: 'setDistance', distance: 2400 }); // ゲストが変更を試みる
    const guestErr = await waitSince(cb4, dmB, 'error', 5000);
    ok(/ホストだけ/.test(guestErr.message || ''), '距離変更: ゲストの変更は拒否される');
    const dmA = ca4.inbox.length, dmB2 = cb4.inbox.length;
    send(ca4, { type: 'ready', ready: true }); // 先にホストが ready しておく
    const roomReady = await waitRoomWhere(ca4, dmA, r => (r.players.find(p => p.nickname === 'テストA' + stamp) || {}).ready === true);
    ok(roomReady.room.distance === 2000, '距離変更: 変更前は作成時の2000m');
    send(ca4, { type: 'setDistance', distance: 1200 });
    const roomDistA = await waitRoomWhere(ca4, dmA, r => r.distance === 1200);
    const roomDistB = await waitRoomWhere(cb4, dmB2, r => r.distance === 1200);
    ok(roomDistA.room.raceName === '疾風スプリント', '距離変更: レース名も新しい距離に追随する');
    ok(roomDistB.room.distance === 1200, '距離変更: ゲストにも即時反映される');
    ok(roomDistA.room.players.every(p => p.ready === false), '距離変更: 変更すると全員の準備が未完了にリセットされる');
    const emA = ca4.inbox.length, emB = cb4.inbox.length;
    send(ca4, { type: 'ready', ready: true });
    send(cb4, { type: 'ready', ready: true });
    await waitSince(ca4, emA, 'gateTiming');
    send(ca4, { type: 'gateInput', gateT: 0.8, boost: false });
    send(cb4, { type: 'gateInput', gateT: 0.8, boost: false });
    const cdD = await waitSince(ca4, emA, 'countdown');
    ok(cdD.meta && cdD.meta.distance === 1200, '距離変更: カウントダウンの距離が変更後の1200m');
    await waitSince(ca4, emA, 'raceStart');
    await Promise.all([driveToFinish(ca4, 1200), driveToFinish(cb4, 1200)]);
    const rdA = await waitSince(ca4, emA, 'results', 90000);
    await waitSince(cb4, emB, 'results', 90000);
    ok(rdA.meta && rdA.meta.distance === 1200 && rdA.standings.length === 18, '距離変更: 変更後の1200mでレースが完走し結果が返る');
    ca4.ws.close(); cb4.ws.close();

    console.log('— ソロモード フロー —');
    const s = await auth('テストS' + stamp, 'pass-s');
    const cs = await connect(s.token);
    await cs.waitFor('welcome');
    send(cs, { type: 'soloStart', horseId: s.profile.unlocked[0] });
    const rs = await raceToFinish(cs, 'ソロ', 'テストS' + stamp);
    ok(!cs.inbox.some(m => m.type === 'gateTiming'), 'ソロ: タイミング合わせフェーズは挟まない（従来どおり即カウントダウン）');
    ok(rs.standings.length === 18, 'ソロ結果: 自分＋NPC17頭の着順表');
    ok(rs.standings.filter(x => !x.npc).length === 1, 'ソロ結果: 人間は1人だけ');
    cs.ws.close();

    console.log('— 追加フロー（1人用移植分） —');
    const api = async (p, body) => {
      const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      return { status: r.status, j: await r.json() };
    };
    const ri = await api('/api/raceinfo', { token: a.token, distance: 1600 });
    ok(ri.j.raceName === 'マイルグランプリ' && ['normal', 'g1'].includes(ri.j.grade), 'レース情報: 1600mはマイルグランプリ＋グレード抽選');
    const ri24 = await api('/api/raceinfo', { token: a.token, distance: 2400 });
    ok(ri24.j.raceName === '長距離ステイヤーズ' && ri24.j.distance === 2400, 'レース情報: 2400mは長距離ステイヤーズ');
    const riOld = await api('/api/raceinfo', { token: a.token, distance: 1500 });
    ok(riOld.j.distance === 2000, 'レース情報: 旧距離1500mは無効（2000mへフォールバック）');

    const reliefNg = await api('/api/relief', { token: a.token });
    ok(reliefNg.status === 400, '破産救済: 残高100G以上では拒否');

    const wf = await api('/api/watch/field', { token: a.token, distance: 1600 });
    ok(Array.isArray(wf.j.field) && wf.j.field.length === 18 && new Set(wf.j.field).size === 18, '観戦: 出走表は50頭から18頭');
    ok(wf.j.form && Object.keys(wf.j.form).length === 18, '観戦: 調子(form)が18頭分ある');

    const badStake = await api('/api/bet', { token: a.token, type: 'win', picks: [wf.j.field[0]], stake: 130, field: wf.j.field, grade: wf.j.grade });
    ok(badStake.status === 400, '賭け: 50G刻みでない賭け金を拒否');
    const badPicks = await api('/api/bet', { token: a.token, type: 'win', picks: [wf.j.field[0], wf.j.field[1]], stake: 100, field: wf.j.field, grade: wf.j.grade });
    ok(badPicks.status === 400, '賭け: 券種と頭数が合わない買い目を拒否');
    const balBefore = (await api('/api/auth', { token: a.token })).j.profile.balance;
    const bet = await api('/api/bet', { token: a.token, type: 'win', picks: [wf.j.field[0]], stake: 100, field: wf.j.field, grade: wf.j.grade });
    ok(bet.status === 200 && bet.j.balance === balBefore - 100, '賭け: 単勝100Gを購入できる');

    const mis = await api('/api/missions', { token: a.token });
    ok(Array.isArray(mis.j.missions) && mis.j.missions.length === 6, 'ミッション: 6件返る');
    // 未達成の請求拒否は「一度もレースしていない新規プレイヤー」で確認する。
    // Aは再戦フロー（フェーズ34）を含め複数レースを完走しており、勝敗次第で
    // first_win を達成済みの可能性があるため（以前からAの勝利で揺れる項目だった）。
    const fresh = await auth('未達成テスト' + stamp, 'pass-f');
    const claimNg = await api('/api/missions/claim', { token: fresh.token, id: 'first_win' });
    ok(claimNg.status === 400, 'ミッション: 未達成の請求を拒否');

    const cw = await connect(a.token);
    await cw.waitFor('welcome');
    send(cw, { type: 'watchStart' });
    const wcd = await cw.waitFor('countdown', 15000);
    ok(wcd.meta && wcd.meta.mode === 'watch' && wcd.meta.distance === 1600 && !!wcd.meta.going, '観戦: カウントダウン＋観戦メタ（距離・馬場）');
    ok(wcd.field.length === 18 && wcd.field.every(f => f.npc), '観戦: 出走表18頭は全てNPC');
    await cw.waitFor('raceStart', 15000);
    send(cw, { type: 'skip' }); // 1600m: 残り1000mまで早回し
    const wres = await cw.waitFor('results', 180000);
    ok(wres.standings.length === 18, '観戦: 結果に着順表18頭');
    ok(!!wres.betResult && typeof wres.betResult.won === 'boolean' && wres.betResult.payout >= 0, '観戦: 賭けが精算される');
    const profAfter = await api('/api/auth', { token: a.token });
    ok(profAfter.j.profile.balance === wres.betResult.balance, '観戦: 精算後の残高がサーバーと一致');
    cw.ws.close();

    const rk = await api('/api/ranking', { token: a.token });
    ok(rk.j.standings && rk.j.standings.length >= 19 && rk.j.standings.some(r => r.name === a.profile.nickname), 'ランキング: AI騎手18人＋自分（＋記録済みの勝者騎手）');
    const stt = await api('/api/stats', { token: a.token });
    ok(stt.j.betting && stt.j.betting.count >= 1 && stt.j.jockey && typeof stt.j.jockey.starts === 'number', '記録: 賭け・騎手の集計が返る');

    const r2 = await auth('救済テスト' + stamp, 'pass-r');
    const wf2 = await api('/api/watch/field', { token: r2.token, distance: 2000 });
    const bet2 = await api('/api/bet', { token: r2.token, type: 'trifecta', picks: wf2.j.field.slice(0, 3), stake: 9950, field: wf2.j.field, grade: wf2.j.grade });
    ok(bet2.status === 200 && bet2.j.balance === 50, '救済準備: 9950G賭けて残高50G（初期1万G前提）');
    const reliefOk = await api('/api/relief', { token: r2.token });
    ok(reliefOk.status === 200 && reliefOk.j.balance === 550, '破産救済: 残高100G未満で500G付与');
    const reliefDup = await api('/api/relief', { token: r2.token });
    ok(reliefDup.status === 400, '破産救済: 付与後は再請求不可');

    const c1k = await connect(s.token);
    await c1k.waitFor('welcome');
    send(c1k, { type: 'soloStart', horseId: s.profile.unlocked[0], distance: 1200 });
    const cd1k = await c1k.waitFor('countdown', 15000);
    ok(cd1k.meta && cd1k.meta.distance === 1200 && !!cd1k.meta.going, '1200m: カウントダウンのメタに距離と馬場');
    await c1k.waitFor('raceStart', 15000);
    await driveToFinish(c1k, 1200);
    const res1k = await c1k.waitFor('results', 90000);
    ok(res1k.standings.length === 18 && res1k.meta && res1k.meta.distance === 1200, '1200m: 結果が返る');
    c1k.ws.close();

    console.log(failures === 0 ? '\n🎉 ALL PASS' : `\n💥 ${failures} FAILURES`);
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error('💥 テスト例外:', e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main();
