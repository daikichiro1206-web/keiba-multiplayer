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

    const unlockPoor = await fetch(BASE + '/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: a.token, horseId: 'equinox' }) });
    ok(unlockPoor.status === 400, '解放API: 所持金不足（5000Gの馬）を拒否');
    const catRes = await fetch(BASE + '/api/horses');
    const catJ = await catRes.json();
    ok(Array.isArray(catJ) && catJ.length === 50, '名簿: 実在50頭');
    ok(catJ.some(h => h.id === 'croix' && h.name === 'クロワデュノール'), '名簿: 推し馬クロワデュノールがいる');
    ok(catJ.filter(h => h.price === 0).length === 4, '名簿: 初期解放は4頭（0G）');
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

    console.log('— 追加フロー（1人用移植分） —');
    const api = async (p, body) => {
      const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      return { status: r.status, j: await r.json() };
    };
    const ri = await api('/api/raceinfo', { token: a.token, distance: 1500 });
    ok(ri.j.raceName === 'マイルグランプリ' && ['normal', 'g1'].includes(ri.j.grade), 'レース情報: 1500mはマイルグランプリ＋グレード抽選');

    const reliefNg = await api('/api/relief', { token: a.token });
    ok(reliefNg.status === 400, '破産救済: 残高100G以上では拒否');

    const wf = await api('/api/watch/field', { token: a.token, distance: 1500 });
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
    const claimNg = await api('/api/missions/claim', { token: a.token, id: 'first_win' });
    ok(claimNg.status === 400, 'ミッション: 未達成の請求を拒否');

    const cw = await connect(a.token);
    await cw.waitFor('welcome');
    send(cw, { type: 'watchStart' });
    const wcd = await cw.waitFor('countdown', 15000);
    ok(wcd.meta && wcd.meta.mode === 'watch' && wcd.meta.distance === 1500 && !!wcd.meta.going, '観戦: カウントダウン＋観戦メタ（距離・馬場）');
    ok(wcd.field.length === 18 && wcd.field.every(f => f.npc), '観戦: 出走表18頭は全てNPC');
    await cw.waitFor('raceStart', 15000);
    send(cw, { type: 'skip' }); // 1500m: 残り1000mまで早回し
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
    const bet2 = await api('/api/bet', { token: r2.token, type: 'trifecta', picks: wf2.j.field.slice(0, 3), stake: 950, field: wf2.j.field, grade: wf2.j.grade });
    ok(bet2.status === 200 && bet2.j.balance === 50, '救済準備: 950G賭けて残高50G');
    const reliefOk = await api('/api/relief', { token: r2.token });
    ok(reliefOk.status === 200 && reliefOk.j.balance === 550, '破産救済: 残高100G未満で500G付与');
    const reliefDup = await api('/api/relief', { token: r2.token });
    ok(reliefDup.status === 400, '破産救済: 付与後は再請求不可');

    const c1k = await connect(s.token);
    await c1k.waitFor('welcome');
    send(c1k, { type: 'soloStart', horseId: s.profile.unlocked[0], distance: 1000 });
    const cd1k = await c1k.waitFor('countdown', 15000);
    ok(cd1k.meta && cd1k.meta.distance === 1000 && !!cd1k.meta.going, '1000m: カウントダウンのメタに距離と馬場');
    await c1k.waitFor('raceStart', 15000);
    await driveToFinish(c1k, 1000);
    const res1k = await c1k.waitFor('results', 90000);
    ok(res1k.standings.length === 18 && res1k.meta && res1k.meta.distance === 1000, '1000m: 結果が返る');
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
