'use strict';
/*
 * 3D競馬ゲーム マルチプレイ版 フェーズ1 サーバー
 * - HTTPで静的ファイル(public/)と認証APIを提供
 * - WebSocket(ws)でルーム/ロビー/レース同期
 * - プレイヤーデータの保存は store.js のアダプタ経由
 *   （DATABASE_URL 設定時: PostgreSQL / 未設定時: data/players.json、合言葉はscryptハッシュ）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createStore } = require('./store');

const PORT = process.env.PORT || 3000;
const TRACK_LEN = 2000;          // 2000m
const FIELD_SIZE = 18;           // 18頭立て
const MAX_HUMANS = 8;            // 1部屋の最大人数（残りはNPC）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // 保存先は環境変数で変更可（デプロイ先の永続ディスク向け）
const DATA_FILE = path.join(DATA_DIR, 'players.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// サーバー権威化: クライアントの距離申告は「ありえる速度」の範囲でのみ受理する
// クライアントの最高ペースは18.2m/s。余裕を持たせて22m/sを上限とし、
// 送信間隔のばらつき吸収用に小さなジッター許容を加える。
const MAX_SPEED = Number(process.env.KEIBA_MAX_SPEED) || 22; // m/s（テスト時のみ環境変数で緩和）
const POS_JITTER_M = 2.5;        // 位置検証のジッター許容(m)

/* ---------------- 馬カタログ（実在の名馬・抜粋） ---------------- */
const HORSES = [
  { id: 'deep',     name: 'ディープインパクト',   style: '追込', rating: 95, price: 0,    apt: '中距離', era: '2000年代' },
  { id: 'orfevre',  name: 'オルフェーヴル',       style: '差し', rating: 94, price: 0,    apt: '中距離', era: '2010年代' },
  { id: 'kitasan',  name: 'キタサンブラック',     style: '先行', rating: 94, price: 0,    apt: '中距離', era: '2010年代' },
  { id: 'almond',   name: 'アーモンドアイ',       style: '先行', rating: 95, price: 0,    apt: '中距離', era: '2010年代' },
  { id: 'equinox',  name: 'イクイノックス',       style: '先行', rating: 96, price: 5000, apt: '中距離', era: '2020年代' },
  { id: 'contrail', name: 'コントレイル',         style: '差し', rating: 94, price: 4000, apt: '中距離', era: '2020年代' },
  { id: 'liberty',  name: 'リバティアイランド',   style: '先行', rating: 93, price: 4000, apt: '中距離', era: '2020年代' },
  { id: 'croix',    name: 'クロワデュノール',     style: '先行', rating: 93, price: 4000, apt: '中距離', era: '2020年代' },
  { id: 'goldship', name: 'ゴールドシップ',       style: '差し', rating: 92, price: 3000, apt: '中距離', era: '2010年代' },
  { id: 'oguri',    name: 'オグリキャップ',       style: '差し', rating: 93, price: 3000, apt: 'マイル', era: '〜90年代' },
  { id: 'suzuka',   name: 'サイレンススズカ',     style: '逃げ', rating: 93, price: 3000, apt: 'マイル', era: '〜90年代' },
  { id: 'vodka',    name: 'ウオッカ',             style: '差し', rating: 92, price: 2500, apt: 'マイル', era: '2000年代' },
  { id: 'gentil',   name: 'ジェンティルドンナ',   style: '先行', rating: 93, price: 2500, apt: '中距離', era: '2010年代' },
  { id: 'rudolf',   name: 'シンボリルドルフ',     style: '先行', rating: 94, price: 3000, apt: '中距離', era: '〜90年代' },
  { id: 'teio',     name: 'トウカイテイオー',     style: '先行', rating: 92, price: 2500, apt: '中距離', era: '〜90年代' },
  { id: 'mcqueen',  name: 'メジロマックイーン',   style: '先行', rating: 91, price: 2000, apt: '長距離', era: '〜90年代' },
  { id: 'sodashi',  name: 'ソダシ',               style: '先行', rating: 90, price: 2000, apt: 'マイル', era: '2020年代' },
  { id: 'do-deuce', name: 'ドウデュース',         style: '差し', rating: 93, price: 3000, apt: '中距離', era: '2020年代' },
];
const horseById = id => HORSES.find(h => h.id === id);
const DEFAULT_UNLOCKED = HORSES.filter(h => h.price === 0).map(h => h.id);

/* ---------------- プレイヤーデータ保存 ----------------
 * 保存先は store.js のアダプタが決める:
 *   DATABASE_URL 設定時 → PostgreSQL（Supabase想定、再起動でも消えない）
 *   未設定時           → ファイル（DATA_DIR/players.json、従来方式）
 * 起動時に全件をメモリへ読み込み、変更のたびにアダプタへ書き戻す。
 * ゲームロジック側は従来どおり players を同期的に読み書きしてよい。 */
let store = null;                        // 起動時に createStore() で初期化
const players = {};                      // nickname -> {passHash, salt, balance, unlocked[], wins, races}
const sessions = new Map();              // token -> nickname

function persistPlayer(nickname) {
  if (!store || !players[nickname]) return;
  Promise.resolve(store.savePlayer(nickname, players[nickname], players))
    .catch(e => console.error('[store] プレイヤー保存に失敗:', nickname, e.message));
}
function persistAll() {
  if (!store) return;
  Promise.resolve(store.saveAll(players))
    .catch(e => console.error('[store] 全件保存に失敗:', e.message));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}
function publicProfile(nickname) {
  const p = players[nickname];
  return { nickname, balance: p.balance, unlocked: p.unlocked, wins: p.wins, races: p.races };
}
function authPlayer(nickname, password) {
  nickname = String(nickname || '').trim().slice(0, 16);
  password = String(password || '');
  if (!nickname || password.length < 3) return { error: 'ニックネームと3文字以上の合言葉が必要です' };
  let p = players[nickname];
  if (!p) {  // 新規登録
    const salt = crypto.randomBytes(8).toString('hex');
    p = players[nickname] = {
      salt, passHash: hashPassword(password, salt),
      balance: 1000, unlocked: [...DEFAULT_UNLOCKED], wins: 0, races: 0,
    };
    persistPlayer(nickname);
  } else if (p.passHash !== hashPassword(password, p.salt)) {
    return { error: '合言葉が違います' };
  }
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, nickname);
  return { token, profile: publicProfile(nickname) };
}

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: Object.keys(players).length }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/unlock') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { token, horseId } = JSON.parse(body || '{}');
        const nickname = sessions.get(token);
        const h = horseById(horseId);
        if (!nickname || !players[nickname]) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'ログインが必要です' })); return; }
        if (!h) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '馬が見つかりません' })); return; }
        const p = players[nickname];
        if (p.unlocked.includes(h.id)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '解放済みです' })); return; }
        if (p.balance < h.price) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '所持金が足りません' })); return; }
        p.balance -= h.price;
        p.unlocked.push(h.id);
        persistPlayer(nickname);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ profile: publicProfile(nickname) }));
      } catch { res.writeHead(400); res.end('{}'); }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/auth') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { nickname, password } = JSON.parse(body || '{}');
        const r = authPlayer(nickname, password);
        res.writeHead(r.error ? 401 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.error ? { error: r.error } : { token: r.token, profile: r.profile, horses: HORSES }));
      } catch { res.writeHead(400); res.end('{}'); }
    });
    return;
  }
  if (req.url === '/api/horses') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(HORSES));
    return;
  }
  const file = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

/* ---------------- ルーム / レース ---------------- */
const rooms = new Map();   // code -> room
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do { code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function roomSummary(room) {
  return {
    code: room.code, state: room.state,
    players: [...room.members.values()].map(m => ({
      nickname: m.nickname, horseId: m.horseId, horseName: horseById(m.horseId)?.name || '',
      ready: m.ready, connected: !!m.ws,
    })),
  };
}
function broadcast(room, obj, exceptWs = null) {
  const msg = JSON.stringify(obj);
  for (const m of room.members.values()) {
    if (m.ws && m.ws !== exceptWs && m.ws.readyState === 1) m.ws.send(msg);
  }
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function createRoom(hostNickname) {
  const code = makeCode();
  const room = {
    code, state: 'lobby', members: new Map(), // nickname -> member
    npcs: [], results: null, tickTimer: null, finishTimer: null, raceStartAt: 0,
  };
  rooms.set(code, room);
  return room;
}
function addMember(room, nickname, ws) {
  let m = room.members.get(nickname);
  if (!m) {
    m = { nickname, ws, horseId: players[nickname].unlocked[0], ready: false,
          dist: 0, lane: room.members.size, speed: 0, finished: false, finishAt: null, place: null, lastPosAt: 0 };
    room.members.set(nickname, m);
  } else {
    m.ws = ws; // 再接続
  }
  return m;
}
function maybeStartCountdown(room) {
  if (room.state !== 'lobby') return;
  const ms = [...room.members.values()];
  if (ms.length === 0 || !ms.every(m => m.ready)) return;
  room.state = 'countdown';
  buildField(room);
  const startAt = Date.now() + 3000;
  room.raceStartAt = startAt;
  broadcast(room, { type: 'countdown', startAt, field: fieldList(room) });
  setTimeout(() => startRace(room), 3000);
}
function buildField(room) {
  // 人間の馬以外からNPCを補充して18頭立て
  const usedIds = new Set([...room.members.values()].map(m => m.horseId));
  const pool = HORSES.filter(h => !usedIds.has(h.id));
  // 人間が選んだ馬がカタログ外でもNPCはカタログから
  room.npcs = [];
  let lane = room.members.size;
  while (room.members.size + room.npcs.length < FIELD_SIZE && pool.length) {
    const h = pool.splice(crypto.randomInt(pool.length), 1)[0];
    room.npcs.push({
      nickname: 'NPC・' + h.name, horseId: h.id, horseName: h.name, npc: true,
      dist: 0, lane: lane++, speed: 0, finished: false, finishAt: null,
      baseSpeed: 15.2 + (h.rating - 87) * 0.22 + Math.random() * 0.5, // ratingで差、ただし僅差
      style: h.style, stamina: 100,
    });
  }
  let i = 0;
  for (const m of room.members.values()) { m.lane = i++; m.dist = 0; m.speed = 0; m.finished = false; m.finishAt = null; }
}
function fieldList(room) {
  const humans = [...room.members.values()].map(m => ({
    nickname: m.nickname, horseId: m.horseId, horseName: horseById(m.horseId)?.name || m.horseId, npc: false, lane: m.lane,
  }));
  const npcs = room.npcs.map(n => ({ nickname: n.nickname, horseId: n.horseId, horseName: n.horseName, npc: true, lane: n.lane }));
  return [...humans, ...npcs].sort((a, b) => a.lane - b.lane);
}
function startRace(room) {
  if (room.state !== 'countdown') return;
  room.state = 'racing';
  const now0 = Date.now();
  for (const m of room.members.values()) { m.lastPosAt = now0; m.dist = 0; m.speed = 0; }
  broadcast(room, { type: 'raceStart', field: fieldList(room) });
  let last = Date.now();
  room.tickTimer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    tickNpcs(room, dt, now);
    broadcast(room, { type: 'state', t: now, runners: allPositions(room) });
    checkRaceEnd(room, now);
  }, 100);
}
function tickNpcs(room, dt, now) {
  for (const n of room.npcs) {
    if (n.finished) continue;
    const prog = n.dist / TRACK_LEN;
    // 脚質: 逃げは序盤速く終盤失速、追込は逆
    let f = 1;
    if (n.style === '逃げ') f = prog < 0.6 ? 1.05 : 0.94;
    else if (n.style === '追込') f = prog < 0.6 ? 0.95 : 1.06;
    else if (n.style === '差し') f = prog < 0.5 ? 0.98 : 1.03;
    n.speed = n.baseSpeed * f;
    n.dist += n.speed * dt;
    if (n.dist >= TRACK_LEN) { n.dist = TRACK_LEN; n.finished = true; n.finishAt = now; }
  }
}
function allPositions(room) {
  const humans = [...room.members.values()].map(m => ({
    nickname: m.nickname, dist: Math.round(m.dist * 10) / 10, lane: m.lane,
    speed: Math.round(m.speed * 10) / 10, finished: m.finished, npc: false,
  }));
  const npcs = room.npcs.map(n => ({
    nickname: n.nickname, dist: Math.round(n.dist * 10) / 10, lane: n.lane,
    speed: Math.round(n.speed * 10) / 10, finished: n.finished, npc: true,
  }));
  return [...humans, ...npcs];
}
function checkRaceEnd(room, now) {
  if (room.state !== 'racing') return;
  const humans = [...room.members.values()];
  const allHumansDone = humans.every(m => m.finished);
  const anyFinished = [...humans, ...room.npcs].some(r => r.finished);
  if (!room.firstFinishAt && anyFinished) {
    room.firstFinishAt = now;
    // 最初のゴールから20秒で打ち切り
    room.finishTimer = setTimeout(() => finishRace(room), 20000);
  }
  if (allHumansDone && room.npcs.every(n => n.finished)) finishRace(room);
}
function finishRace(room) {
  if (room.state === 'finished') return;
  room.state = 'finished';
  clearInterval(room.tickTimer); clearTimeout(room.finishTimer);
  const all = [...room.members.values(), ...room.npcs];
  const done = all.filter(r => r.finished).sort((a, b) => a.finishAt - b.finishAt);
  const notDone = all.filter(r => !r.finished).sort((a, b) => b.dist - a.dist);
  const standings = [...done, ...notDone].map((r, i) => ({
    place: i + 1, nickname: r.nickname,
    horseName: r.npc ? r.horseName : (horseById(r.horseId)?.name || r.horseId),
    npc: !!r.npc, dist: Math.round(r.dist),
    time: r.finished ? Math.round((r.finishAt - room.raceStartAt - 3000) / 100) / 10 : null,
  }));
  // プレイヤー成績を保存（出走数・勝利数・簡易賞金）
  for (const m of room.members.values()) {
    const st = standings.find(s => s.nickname === m.nickname);
    const p = players[m.nickname];
    if (p && st) {
      p.races += 1;
      if (st.place === 1) p.wins += 1;
      const prize = [1500, 600, 300, 150, 100][st.place - 1] || 0;
      p.balance += prize;
      st.prize = prize;
    }
  }
  persistAll();
  room.results = standings;
  broadcast(room, { type: 'results', standings });
}
function leaveRoom(room, nickname) {
  const m = room.members.get(nickname);
  if (m) m.ws = null;
  if (room.state === 'lobby') {
    room.members.delete(nickname);
    broadcast(room, { type: 'room', room: roomSummary(room) });
  }
  if (room.members.size === 0 || [...room.members.values()].every(x => !x.ws)) {
    clearInterval(room.tickTimer); clearTimeout(room.finishTimer);
    setTimeout(() => { if ([...room.members.values()].every(x => !x.ws)) rooms.delete(room.code); }, 60000);
  }
}

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let nickname = null, room = null, member = null;
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') {
      nickname = sessions.get(msg.token);
      if (!nickname) { send(ws, { type: 'error', message: 'ログインが必要です' }); return; }
      send(ws, { type: 'welcome', profile: publicProfile(nickname), horses: HORSES });
      // 再接続: roomCodeがあれば元の部屋に戻す
      if (msg.roomCode && rooms.has(msg.roomCode)) {
        room = rooms.get(msg.roomCode);
        if (room.members.has(nickname)) {
          member = addMember(room, nickname, ws);
          send(ws, { type: 'room', room: roomSummary(room) });
          if (room.state === 'racing') send(ws, { type: 'raceStart', field: fieldList(room) });
          if (room.state === 'finished' && room.results) send(ws, { type: 'results', standings: room.results });
        }
      }
      return;
    }
    if (!nickname) { send(ws, { type: 'error', message: '先にhelloしてください' }); return; }
    switch (msg.type) {
      case 'soloStart': {
        // 独りモード: 部屋コード不要。自分＋NPC17頭で即カウントダウンへ
        if (room) leaveRoom(room, nickname);
        room = createRoom(nickname);
        room.solo = true;
        member = addMember(room, nickname, ws);
        if (msg.horseId && players[nickname].unlocked.includes(msg.horseId)) member.horseId = msg.horseId;
        member.ready = true;
        send(ws, { type: 'room', room: roomSummary(room) });
        maybeStartCountdown(room);
        break;
      }
      case 'leaveRoom': {
        if (room) { leaveRoom(room, nickname); room = null; member = null; }
        break;
      }
      case 'createRoom': {
        if (room) leaveRoom(room, nickname);
        room = createRoom(nickname);
        member = addMember(room, nickname, ws);
        send(ws, { type: 'room', room: roomSummary(room) });
        break;
      }
      case 'joinRoom': {
        const r = rooms.get(String(msg.code || '').toUpperCase());
        if (!r) { send(ws, { type: 'error', message: '部屋が見つかりません' }); break; }
        if (r.state !== 'lobby' && !r.members.has(nickname)) { send(ws, { type: 'error', message: 'レース中です' }); break; }
        if (!r.members.has(nickname) && r.members.size >= MAX_HUMANS) { send(ws, { type: 'error', message: '満員です' }); break; }
        if (room && room !== r) leaveRoom(room, nickname);
        room = r;
        member = addMember(room, nickname, ws);
        broadcast(room, { type: 'room', room: roomSummary(room) });
        break;
      }
      case 'selectHorse': {
        if (!room || room.state !== 'lobby') break;
        if (!players[nickname].unlocked.includes(msg.horseId)) { send(ws, { type: 'error', message: '未解放の馬です' }); break; }
        member.horseId = msg.horseId;
        broadcast(room, { type: 'room', room: roomSummary(room) });
        break;
      }
      case 'ready': {
        if (!room || room.state !== 'lobby') break;
        member.ready = !!msg.ready;
        broadcast(room, { type: 'room', room: roomSummary(room) });
        maybeStartCountdown(room);
        break;
      }
      case 'pos': {
        // サーバー権威化: 距離の申告は「前回受理からの経過時間 × 上限速度 + ジッター」
        // の範囲でのみ受理し、超えた分は切り捨てて補正する。ゴール到達は
        // サーバーが検証した距離が TRACK_LEN に達した時点でサーバー側が判定する。
        // クライアント申告のゴール通知は存在せず、ここが唯一のゴール判定経路。
        if (!room || room.state !== 'racing' || !member || member.finished) break;
        const now = Date.now();
        const dt = Math.max(0, (now - (member.lastPosAt || now)) / 1000);
        member.lastPosAt = now;
        const reported = Number(msg.dist);
        if (Number.isFinite(reported)) {
          const target = Math.min(TRACK_LEN, Math.max(0, reported));
          const delta = target - member.dist;
          if (delta > 0) {
            const accepted = Math.min(delta, MAX_SPEED * dt + POS_JITTER_M);
            member.dist += accepted;
            if (dt > 0.01) member.speed = Math.min(MAX_SPEED, accepted / dt); // 速度はサーバー算出値を使う
          }
        }
        const lane = Number(msg.lane);
        if (Number.isFinite(lane)) member.lane = Math.min(FIELD_SIZE - 1, Math.max(0, lane));
        if (member.dist >= TRACK_LEN) {
          member.dist = TRACK_LEN;
          member.finished = true;
          member.finishAt = now; // サーバー時刻で確定
        }
        break;
      }
      case 'backToLobby': {
        if (!room) break;
        if (room.state === 'finished') {
          room.state = 'lobby'; room.results = null; room.firstFinishAt = null;
          for (const m of room.members.values()) { m.ready = false; m.finished = false; m.dist = 0; }
          broadcast(room, { type: 'room', room: roomSummary(room) });
        }
        break;
      }
    }
  });
  ws.on('close', () => { if (room && nickname) leaveRoom(room, nickname); });
});

/* ---------------- 起動（保存先の初期化 → 読み込み → listen） ---------------- */
(async () => {
  try {
    store = createStore(process.env, { dataFile: DATA_FILE });
    const loaded = await store.init();   // PostgreSQL時はテーブル自動作成＋全件読み込み
    Object.assign(players, loaded);
    console.log(`[store] 保存先: ${store.describe()}（プレイヤー ${Object.keys(players).length} 件を読み込み）`);
  } catch (e) {
    // DATABASE_URL の設定ミス等で保存先が使えない場合は、データを守るため起動を止めて気づけるようにする
    console.error('[store] 保存先の初期化に失敗しました:', e.message);
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`keiba-multiplayer server listening on http://localhost:${PORT}`));
  // 終了時は書き込みキューをフラッシュしてから落とす
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { if (store) await store.close(); } catch { /* 終了処理中の保存失敗は諦める */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})();
