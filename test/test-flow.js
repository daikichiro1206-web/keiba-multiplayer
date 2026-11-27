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
async function driveToFinish(c) {
  let dist = 0;
  while (dist < 2000) {
    dist = Math.min(2000, dist + 12);
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
  const server = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT, DATA_DIR: dataDir, KEIBA_MAX_SPEED: '600' },
    stdio: 'pipe',
  });
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  try {
    await wait(1200);

    console.log('— ヘルスチェック / 解放API —');
    const health = await fetch(BASE + '/health');
    const hj = await health.json();
    ok(health.status === 200 && hj.ok === true, 'GET /health が200で応答');

    console.log('— マルチプレイ フロー —');
    const stamp = Date.now() % 100000;
    const a = await auth('テストA' + stamp, 'pass-a');
    const b = await auth('テストB' + stamp, 'pass-b');
    ok(a.profile.balance === 1000, '登録: 初期所持金1000G');
    ok(a.profile.unlocked.length >= 4, '登録: 初期解放馬あり');
    const bad = await fetch(BASE + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'テストA' + stamp, password: 'wrong' }) });
    ok(bad.status === 401, 'ログイン: 合言葉違いを拒否');

    const unlockPoor = await fetch(BASE + '/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: a.token, horseId: 'mcqueen' }) });
    ok(unlockPoor.status === 400, '解放API: 所持金不足（2000Gの馬）を拒否');
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
    ca.ws.close(); cb.ws.close();

    console.log('— ソロモード フロー —');
    const s = await auth('テストS' + stamp, 'pass-s');
    const cs = await connect(s.token);
    await cs.waitFor('welcome');
    send(cs, { type: 'soloStart', horseId: s.profile.unlocked[0] });
    const rs = await raceToFinish(cs, 'ソロ', 'テストS' + stamp);
    ok(rs.standings.length === 18, 'ソロ結果: 自分＋NPC17頭の着順表');
    ok(rs.standings.filter(x => !x.npc).length === 1, 'ソロ結果: 人間は1人だけ');
    cs.ws.close();

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
