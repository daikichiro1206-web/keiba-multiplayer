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
const CAT = require('./catalog');

/* ビルド識別子（フェーズ32）: クライアント(index.html の CLIENT_BUILD)と一致させる。
   2026-11-28 の事故: GitHubへのファイル別アップロードの途中のコミットで Render の
   デプロイが止まり、「画面はフェーズ25・サーバー/カタログはフェーズ24」という
   混在状態のまま公開され、1200m指定が旧カタログの距離リストに無く黙って2000mに
   化けた。/health と認証応答でこの値を返し、クライアントが不一致を検出して
   画面に警告を出すことで、混在デプロイを即座に可視化する。 */
const BUILD_VERSION = 'phase32';
/* 距離の受理: 数値化してから判定する（文字列 "1200" 等の型違いを黙って
   2000m に化けさせない）。不正値のフォールバック時はログに残す。 */
function validDistance(v) {
  const n = Number(v);
  if (CAT.DISTANCES.includes(n)) return n;
  if (v !== undefined && v !== null && v !== '') console.warn(`[distance] 不正な距離指定 ${JSON.stringify(v)} を 2000m にフォールバック`);
  return 2000;
}

const PORT = process.env.PORT || 3000;
const TRACK_LEN = 2000;          // 物理コース1周（ゴール固定。レース距離はこれ以下で、スタートが前にずれる）
const FIELD_SIZE = CAT.FIELD_SIZE; // 18頭立て（名簿50頭から抽選）
const MAX_HUMANS = 8;            // 1部屋の最大人数（残りはNPC）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // 保存先は環境変数で変更可（デプロイ先の永続ディスク向け）
const DATA_FILE = path.join(DATA_DIR, 'players.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// サーバー権威化: クライアントの距離申告は「ありえる速度」の範囲でのみ受理する
// 1人用エンジンの実効最高速度は、持続で約21.4m/s（攻め・大×末脚キック）、
// ムチ（×1.18・1.1秒）過渡のピークで約23.8m/s。旧上限22m/sではムチの
// ピークが1人用より削られていたため、上限を24m/sに合わせて引き上げた。
// 送信間隔のばらつき吸収用に小さなジッター許容を加える。
/* 実速度の倍率: フェーズ18で全馬一律 ×1.2 に底上げしたが、フェーズ21で
   ユーザー指示により実馬並み（巡航 約17m/s＝平均62km/h）へ戻し 1.0 とした。
   基準速度・上限・スタミナ消費（毎秒→距離あたり不変）・ペース熱の基準速度・
   横移動速度はすべてこの定数に連動するので、ここを変えれば一律に戻る。
   クライアント public/index.html の SPEED_MULT と必ず同値にすること */
const SPEED_MULT = 1.0;
const MAX_SPEED = Number(process.env.KEIBA_MAX_SPEED) || 24 * SPEED_MULT; // m/s（テスト時のみ環境変数で緩和）
const POS_JITTER_M = 2.5;        // 位置検証のジッター許容(m)

/* ---------------- 馬カタログ（実在の名馬50頭、catalog.js＝1人用DEFSが正） ---------------- */
const HORSES = CAT.HORSES;
const horseById = CAT.horseById;
const horseByName = CAT.horseByName;
const DEFAULT_UNLOCKED = CAT.STARTER_IDS;

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
/* プレイヤー記録の拡張フィールド（ミッション進捗カウンタ・受取済み・賭け履歴・
   騎手ランキングのシーズン状態・次のレースのグレード・観戦セッション）。
   旧データにも欠けていれば既定値を補う（1人用 actions.ts の各テーブル相当）。 */
/* 初期解放の世代管理（フェーズ22）: 初期解放は「最低限の保証」として扱い、
   プレイヤーの解放済みリストとは常に合算（ユニオン）する。スターター構成が
   変わっても、既に解放した馬が巻き戻ることは絶対にない。
   LEGACY_STARTER_IDS はフェーズ21までの初期解放4頭。購入で解放した馬の記録
   （paidIds）が無い旧データでは、「旧スターター以外の解放済み＝購入分」と
   みなして復元する（スターター化した馬を過去に買っていた人のミッション
   進捗「新しい馬を3頭解放」が減らないようにするため）。 */
const LEGACY_STARTER_IDS = ['sodashi', 'mcqueen', 'vodka', 'duramente'];
function normalizePlayer(p) {
  if (!p.counters) p.counters = {};                       // counter:<key> 相当
  if (!p.claimedMissions) p.claimedMissions = {};          // mission:<id> の claimed 相当
  if (!Array.isArray(p.bets)) p.bets = [];                 // 賭け履歴（精算・収支集計用）
  if (!p.nextBetId) p.nextBetId = 1;
  if (!p.season) p.season = { n: 1, races: 0, wins: {}, prevWins: null, prevSeason: 0 };
  if (p.pendingGrade === undefined) p.pendingGrade = null;
  if (p.watchSession === undefined) p.watchSession = null;
  if (!Array.isArray(p.unlocked)) p.unlocked = [];
  if (!Array.isArray(p.paidIds)) {
    // 旧データの移行: 旧スターター以外の解放済みは購入で解放したものとして記録
    p.paidIds = p.unlocked.filter(id => !LEGACY_STARTER_IDS.includes(id));
  }
  // 初期解放の保証マージ: 現在のスターターを合算するだけ（削除は一切しない）
  for (const id of CAT.STARTER_IDS) if (!p.unlocked.includes(id)) p.unlocked.push(id);
  /* 残高フロア移行（フェーズ23）: 初期所持金10,000G化（フェーズ22）は新規登録
     のみ適用だったため、既存プレイヤーの残高が増えていなかった。一度きりの
     移行措置として、フラグ（balanceFloorV1）が無いプレイヤーに限り、残高が
     初期所持金未満なら初期所持金まで引き上げる（10,000G以上は金額不変で
     フラグだけ立てる）。フラグは残高と一緒に永続化されるため、その後に
     賭け等で10,000Gを下回っても再び底上げされることはなく、無限付与には
     ならない。残高が尽きた場合の恒常的な受け皿は従来の破産救済
     （100G未満で500Gを請求）が担う。減らす処理は一切しない。 */
  if (!p.balanceFloorV1) {
    p.balanceFloorV1 = 1;
    const bal = Number(p.balance);
    if (!Number.isFinite(bal) || bal < CAT.INITIAL_BALANCE) p.balance = CAT.INITIAL_BALANCE;
  }
  return p;
}
function bumpCounter(p, key, by = 1) { p.counters[key] = (p.counters[key] || 0) + by; }
function counterValue(p, key) { return p.counters[key] || 0; }
function paidUnlockCount(p) {
  // 購入で解放した頭数（フェーズ22: paidIds で数える。スターター構成の変更で
  // 過去の購入分が「初期解放」に化けて進捗が減るのを防ぐ）
  if (Array.isArray(p.paidIds)) return p.paidIds.length;
  return Math.max(0, p.unlocked.filter(id => !CAT.STARTER_IDS.includes(id)).length);
}
function missionProgress(p, def) {
  return def.counter === 'unlocks' ? paidUnlockCount(p) : counterValue(p, def.counter);
}
function missionsView(p) {
  return CAT.MISSIONS.map(m => {
    const progress = missionProgress(p, m);
    return {
      id: m.id, title: m.title, desc: m.desc, target: m.target, reward: m.reward,
      progress: Math.min(progress, m.target), achieved: progress >= m.target,
      claimed: p.claimedMissions[m.id] === 1,
    };
  });
}
/* 1レース分の結果を本人の騎手ランキングへ記録（1人用 recordRaceResult と同一:
   勝ち馬の騎手に1勝、シーズン消化数を進め、30レースで次シーズンへ） */
function recordRaceResultFor(p, winnerJockey) {
  if (!winnerJockey) return;
  const s = p.season;
  s.wins[winnerJockey] = (s.wins[winnerJockey] || 0) + 1;
  s.races += 1;
  if (s.races >= CAT.SEASON_RACES) {
    s.prevWins = s.wins; s.prevSeason = s.n;
    s.n += 1; s.races = 0; s.wins = {};
  }
}
function rankingView(p, nickname) {
  const s = p.season;
  const names = new Set([nickname, ...CAT.AI_JOCKEYS, ...Object.keys(s.wins)]);
  const standings = [...names]
    .map(name => ({ name, wins: s.wins[name] || 0, isPlayer: name === nickname }))
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name, 'ja'));
  let prevChampion = null;
  if (s.prevWins) {
    const top = Object.entries(s.prevWins).map(([name, wins]) => ({ name, wins }))
      .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name, 'ja'))[0];
    if (top && top.wins > 0) prevChampion = { season: s.prevSeason, name: top.name, wins: top.wins, isPlayer: top.name === nickname };
  }
  return { season: s.n, racesInSeason: s.races, seasonRaces: CAT.SEASON_RACES, standings, prevChampion };
}
function authPlayer(nickname, password) {
  nickname = String(nickname || '').trim().slice(0, 16);
  password = String(password || '');
  if (!nickname || password.length < 3) return { error: 'ニックネームと3文字以上の合言葉が必要です' };
  let p = players[nickname];
  if (!p) {  // 新規登録
    const salt = crypto.randomBytes(8).toString('hex');
    p = players[nickname] = normalizePlayer({
      salt, passHash: hashPassword(password, salt),
      balance: CAT.INITIAL_BALANCE, unlocked: [...DEFAULT_UNLOCKED], paidIds: [], wins: 0, races: 0,
    });
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
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: Object.keys(players).length, version: BUILD_VERSION }));
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
        if (!Array.isArray(p.paidIds)) p.paidIds = [];
        p.paidIds.push(h.id); // 購入分の記録（ミッション進捗の算定用、フェーズ22）
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
        const parsed = JSON.parse(body || '{}');
        // トークン再ログイン（クライアントの自動ログイン用。セッションが生きている間だけ有効）
        if (parsed.token && sessions.has(parsed.token)) {
          const nickname = sessions.get(parsed.token);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token: parsed.token, profile: publicProfile(nickname), horses: HORSES }));
          return;
        }
        const { nickname, password } = parsed;
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
  /* ---- ゲーム経済API（1人用 actions.ts の移植。金額はすべてサーバー側で決める） ---- */
  const apiPost = (url, fn) => {
    if (req.method !== 'POST' || req.url !== url) return false;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        const args = JSON.parse(body || '{}');
        const nickname = sessions.get(args.token);
        if (!nickname || !players[nickname]) { json(401, { error: 'ログインが必要です' }); return; }
        fn({ nickname, p: normalizePlayer(players[nickname]), args, json });
      } catch (e) { json(400, { error: e.message || '不正なリクエストです' }); }
    });
    return true;
  };
  // 次のレース情報: グレードを抽選して本人に保持し、レース名と一緒に返す（1人用 rollGrade 25%）
  if (apiPost('/api/raceinfo', ({ nickname, p, args, json }) => {
    const distance = validDistance(args.distance);
    p.pendingGrade = CAT.rollGrade();
    persistPlayer(nickname);
    json(200, { grade: p.pendingGrade, raceName: CAT.RACE_INFO[distance].name, category: CAT.RACE_INFO[distance].category, distance });
  })) return;
  // 観戦レースの出走抽選: 名簿50頭から18頭＋当日の調子（新聞の印と連動する form）をサーバーが決める
  if (apiPost('/api/watch/field', ({ nickname, p, args, json }) => {
    const distance = validDistance(args.distance);
    const names = HORSES.map(h => h.name);
    for (let i = names.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [names[i], names[j]] = [names[j], names[i]]; }
    const field = names.slice(0, FIELD_SIZE);
    const form = {};
    for (const n of field) form[n] = 1 + (Math.random() * 2 - 1) * 0.0035; // 1人用 rollRaceCard と同じ ±0.35%
    const grade = p.pendingGrade || CAT.rollGrade();
    p.pendingGrade = null;
    p.watchSession = { field, form, grade, distance, betId: null };
    persistPlayer(nickname);
    json(200, { field, form, grade, distance, raceName: CAT.RACE_INFO[distance].name, category: CAT.RACE_INFO[distance].category });
  })) return;
  // 賭け券購入（1人用 placeBet と同一検証: オッズはサーバー計算、賭け金は100G以上・50G単位、MAXのみ例外）
  if (apiPost('/api/bet', ({ nickname, p, args, json }) => {
    const odds = CAT.oddsForBet(args.type, Array.isArray(args.picks) ? args.picks : [], Array.isArray(args.field) ? args.field : []);
    if (odds === null) { json(400, { error: '賭けの組み合わせが正しくありません' }); return; }
    const stake = Number(args.stake);
    if (!Number.isInteger(stake) || stake < 1 || stake > p.balance) { json(400, { error: '所持金が足りません' }); return; }
    if (stake !== p.balance && (stake < 100 || stake % 50 !== 0)) { json(400, { error: '賭け金は100G以上・50G単位で選んでください（全額賭ける時はMAX）' }); return; }
    const grade = args.grade === 'g1' ? 'g1' : 'normal';
    const bet = { id: p.nextBetId++, type: args.type, picks: [...args.picks], stake, odds, grade, settled: 0, payout: 0, refunded: 0 };
    p.bets.push(bet);
    p.balance -= stake;
    if (p.watchSession) p.watchSession.betId = bet.id;
    persistPlayer(nickname);
    json(200, { betId: bet.id, odds, balance: p.balance });
  })) return;
  // 賭け券の返金（観戦をやめた場合。精算済みは対象外）
  if (apiPost('/api/bet/refund', ({ nickname, p, args, json }) => {
    const bet = p.bets.find(b => b.id === args.betId);
    if (!bet) { json(400, { error: '賭け券が見つかりません' }); return; }
    if (bet.settled === 1) { json(200, { refunded: 0, balance: p.balance }); return; }
    bet.settled = 1; bet.payout = bet.stake; bet.refunded = 1;
    p.balance += bet.stake;
    if (p.watchSession && p.watchSession.betId === bet.id) p.watchSession.betId = null;
    persistPlayer(nickname);
    json(200, { refunded: bet.stake, balance: p.balance });
  })) return;
  // 破産救済（残高100G未満の時だけ500G。サーバー側で判定するので連打では増えない）
  if (apiPost('/api/relief', ({ nickname, p, json }) => {
    if (p.balance >= CAT.RELIEF_THRESHOLD) { json(400, { error: `救済金は所持金が${CAT.RELIEF_THRESHOLD}G未満の時だけ受け取れます` }); return; }
    p.balance += CAT.RELIEF_AMOUNT;
    persistPlayer(nickname);
    json(200, { amount: CAT.RELIEF_AMOUNT, balance: p.balance });
  })) return;
  if (apiPost('/api/missions', ({ p, json }) => json(200, { missions: missionsView(p) }))) return;
  if (apiPost('/api/missions/claim', ({ nickname, p, args, json }) => {
    const def = CAT.MISSIONS.find(m => m.id === args.id);
    if (!def) { json(400, { error: 'そのミッションは存在しません' }); return; }
    if (missionProgress(p, def) < def.target) { json(400, { error: 'まだ達成していません' }); return; }
    if (p.claimedMissions[def.id] === 1) { json(400, { error: 'この報酬はもう受け取り済みです' }); return; }
    p.claimedMissions[def.id] = 1;
    p.balance += def.reward;
    persistPlayer(nickname);
    json(200, { reward: def.reward, balance: p.balance });
  })) return;
  if (apiPost('/api/ranking', ({ nickname, p, json }) => json(200, rankingView(p, nickname)))) return;
  // 記録・収支（1人用 getStats と同一集計: 精算済み・返金分を除く賭け履歴から）
  if (apiPost('/api/stats', ({ nickname, p, json }) => {
    const settled = p.bets.filter(b => b.settled === 1 && b.refunded === 0 && !(b.payout > 0 && b.payout === b.stake));
    const totalStake = settled.reduce((s, b) => s + b.stake, 0);
    const totalPayout = settled.reduce((s, b) => s + b.payout, 0);
    const hitCount = settled.filter(b => b.payout > 0).length;
    const byType = ['win', 'place', 'wide', 'quinella', 'trio', 'trifecta'].map(t => {
      const rows = settled.filter(b => b.type === t);
      return { type: t, count: rows.length, hits: rows.filter(b => b.payout > 0).length };
    });
    const starts = counterValue(p, 'jockey_starts');
    const wins = counterValue(p, 'jockey_wins');
    const prizeTotal = counterValue(p, 'jockey_prize_total');
    const standings = rankingView(p, nickname).standings;
    json(200, {
      balance: p.balance,
      betting: {
        count: settled.length, totalStake, totalPayout, profit: totalPayout - totalStake,
        hitCount, hitRate: settled.length > 0 ? Math.round(hitCount / settled.length * 1000) / 10 : null,
        bestPayout: settled.reduce((m, b) => Math.max(m, b.payout), 0), byType,
      },
      jockey: {
        starts, wins, prizeTotal,
        winRate: starts > 0 && wins <= starts ? Math.round(wins / starts * 1000) / 10 : null,
        seasonWins: p.season.wins[nickname] || 0,
        seasonRank: standings.findIndex(s => s.name === nickname) + 1,
      },
      unlockedCount: p.unlocked.length, totalHorses: HORSES.length,
      season: p.season.n,
    });
  })) return;
  const urlPath = req.url.split('?')[0]; // クエリ付きの '/' でも index.html を返す（旧実装は '/?dbg' 等が404になっていた）
  const file = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  // ?v= 付きアセットは内容が変わらない前提で長期キャッシュ、それ以外（HTML含む）は
  // 毎回検証させ、モデルやコードの差し替えが実機に届かない事故を防ぐ
  // HTMLは no-store で保存自体を禁止（iOS Safari が no-cache でも古い画面を
  // 使い回す事故の再発防止。フェーズ32）。?v= アセットは従来どおり長期キャッシュ。
  const isHtml = path.extname(file) === '.html';
  const cacheCtl = isHtml ? 'no-cache, no-store, must-revalidate' : (req.url.includes('?v=') ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cacheCtl });
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
    code: room.code, state: room.state, mode: room.mode || 'jockey',
    distance: room.raceDist || 2000,
    raceName: CAT.RACE_INFO[room.raceDist || 2000].name,
    players: [...room.members.values()].map(m => ({
      nickname: m.nickname, horseId: m.horseId, horseName: horseById(m.horseId)?.name || '',
      ready: m.ready, connected: !!m.ws,
    })),
  };
}
/* レースの開催情報（距離・グレード・馬場）。カウントダウン/開始/結果に同梱する */
function raceMeta(room) {
  const distance = room.raceDist || 2000;
  return {
    mode: room.mode || 'jockey', distance,
    raceName: CAT.RACE_INFO[distance].name, category: CAT.RACE_INFO[distance].category,
    grade: room.grade || 'normal',
    going: room.going ? { id: room.going.id, name: room.going.name, note: room.going.note } : { id: 'ryo', name: '良馬場', note: '' },
  };
}
function broadcast(room, obj, exceptWs = null) {
  const msg = JSON.stringify(obj);
  for (const m of room.members.values()) {
    if (m.ws && m.ws !== exceptWs && m.ws.readyState === 1) m.ws.send(msg);
  }
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

/* 次のレースのグレード: ホーム表示用に抽選済みのものがあればそれを使い、無ければここで抽選 */
function consumeGrade(nickname) {
  const p = players[nickname];
  if (p && p.pendingGrade) { const g = p.pendingGrade; p.pendingGrade = null; return g; }
  return CAT.rollGrade();
}
function createRoom(hostNickname) {
  const code = makeCode();
  const room = {
    code, state: 'lobby', members: new Map(), // nickname -> member
    npcs: [], results: null, tickTimer: null, finishTimer: null, raceStartAt: 0,
    mode: 'jockey', raceDist: 2000, grade: 'normal', going: CAT.GOING_LIST[0],
    owner: null, betId: null, watchSession: null, firstFinishAt: null, paceHeat: 0, raceClock: 0,
  };
  rooms.set(code, room);
  return room;
}
function addMember(room, nickname, ws) {
  let m = room.members.get(nickname);
  if (!m) {
    m = { nickname, ws, horseId: players[nickname].unlocked[0], ready: false,
          dist: 0, lane: room.members.size, speed: 0, finished: false, finishAt: null, place: null, lastPosAt: 0,
          fouls: 0, finishClock: null, dayForm: 1 };
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
  broadcast(room, { type: 'countdown', startAt, countdownSec: 3, field: fieldList(room), meta: raceMeta(room) });
  setTimeout(() => startRace(room), 3000);
}
/* =====================================================================
   NPC走行シミュレーション — 1人用 keiba-engine.js の stepHorse / aiPace /
   decideLat をサーバーへ移植したもの。数値はすべて1人用と同一:
   ・base速度は1人用 DEFS の実値（16.74〜17.00m/s）を rating から再現する式
     base = 14.226 + 0.0289 × rating（クライアントのプレイヤー計算と同一式）
   ・目標速度 = base × レーティング係数 × dayForm × 距離適性 × ペース倍率
     × 脚質3相補正 × スタミナ低下曲線 × 微振動（1人用の target 式そのまま。
     馬場補正はマルチ版に馬場概念がないため良馬場=1.0固定）
   ・加速は exp 平滑（加速0.85 / 減速2.1）、スタミナはペース表で増減し
     スリップストリームで軽減、前の馬への追走/前詰まりキャップあり
   ・横移動は decideLat（内ラチがホーム）＋慣性（最大1.05m/s、加速度1.9）
   ・コーナー係数も1人用そのもの（コーナー区間のみ 110/(110+lat)）。
     ティックは最大1/60秒のサブステップで回し、計算粒度も1人用に一致させる
   サーバー内の lat は物理レーン基準（負=内・正=外、1人用と同じ）。
   ===================================================================== */
const LANE_W_S = 1.14, LAT_MAX_S = 9.7;
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const NPC_STYLE_KEY = { '逃げ': 'nige', '先行': 'senko', '差し': 'sashi', '追込': 'oikomi' };
const NPC_PACE = {
  hold:  { mul: 0.85,  stam: 2.0 },
  nari:  { mul: 0.965, stam: -0.12 },
  pushS: { mul: 1.075, stam: -1.3 },
  pushL: { mul: 1.19,  stam: -3.0 },
};
const NPC_STYLE_PROFILE = {
  nige:   { early: 1.030, mid: 1.004, kick: 1.004, kickFrom: 330 }, // kick はフェーズ26で 0.986→1.004（クライアント STYLE_PROFILE と同値）: 残り330mで目標速度が1.8%落ちる段差を無くし中盤の速さを維持
  senko:  { early: 1.014, mid: 1.006, kick: 1.010, kickFrom: 430 },
  /* 差し・追込の early/mid は1人用より僅かに引き上げた（仕様§5対応の意図的な
     逸脱）: 1人用の値のままだと馬群が縦長に伸びた時点で差し・追込の赤字が
     約80〜100mに達し、末脚（kick倍率）だけでは物理的に届かなかった
     （実測: 2000m良で追込の平均着順17.2/18、勝ち馬は先行・逃げのみ）。
     実競馬の追込馬は中盤も勝ち負けの圏内に脚を溜める、という範囲の調整 */
  sashi:  { early: 0.994, mid: 1.003, kick: 1.040, kickFrom: 480 },
  oikomi: { early: 0.988, mid: 1.000, kick: 1.060, kickFrom: 430 },
};
/* 距離適性（1人用 aptMulOf と同一: 距離カテゴリの適性値で ±0.25%） */
const distCatIdxOf = len => len <= 1200 ? 0 : len <= 1600 ? 1 : len <= 2000 ? 2 : 3;
const npcAptMul = (apt, len) => 1 + ((((apt || [1, 1, 1])[distCatIdxOf(len)]) ?? 1) - 1) * 0.0025;
/* コーナー係数: 1人用 cornerFactor そのもの（直線＋半径110mの半円コーナー。
   コーナー区間だけ 110/(110+lat)、直線は1）。旧マルチ版は見た目の楕円コースの
   曲率半径を全周に適用していたため、直線でも内有利が効いて隊列が内に張り付き、
   内外のメリハリ（コーナーで内に集まり直線で広がる）と逃げ馬の位置取りが
   1人用とずれていた。実測（6レース平均）: 本モデルでは逃げの平均順位が
   400m地点 4.5→2.3、馬群の広がり 1000m地点 127m→110m、勝ち時計
   110.3s→112.7s と1人用の挙動に寄る。引数 lat は物理レーン基準（外が正） */
function npcCornerFactor(room, dist, lat) {
  return npcIsCorner(room, dist) ? 110 / (110 + lat) : 1;
}
/* コーナー判定（1人用 isCorner と同じ物理座標の区間: 直線≈654.5m / 弧≈345.6m） */
function npcIsCorner(room, dist) {
  const s = ((dist + (TRACK_LEN - (room.raceDist || 2000))) % TRACK_LEN + TRACK_LEN) % TRACK_LEN;
  return (s >= 654.5 && s < 1000.1) || s >= 1654.6;
}
function npcPhaseIdx(room, dist) { const L = room.raceDist || 2000; return dist < L * 0.3 ? 0 : dist < L * 0.6 ? 1 : dist < L * 0.8 ? 2 : 3; }
/* 個体特性の決定的な導出（1人用の plan/homeLat が num 由来の位相で個体差を
   作るのと同じ流儀: 同じ馬はいつも同じ特性値になり、レースを跨いで安定する。
   仕様§7の能力値のうち、カタログに無い 加速力・持久力・コーナリング・
   瞬発力・気性 をここから個別化する。最高速(base)・距離適性(apt)・
   馬場適性(heavy) はカタログ値が正） */
function npcTrait(num, salt) {
  const x = Math.sin(num * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x); // 0..1
}
/* コーナー係数の個体版: コーナリング能力が高い馬ほど、内での利得が大きく
   外での距離損が小さい（係数を cornerMul で累乗する） */
function npcCornerFactorFor(room, n) {
  const f = npcCornerFactor(room, n.dist, n.lat);
  return n.cornerMul && n.cornerMul !== 1 ? Math.pow(f, n.cornerMul) : f;
}
/* ゲートの出遅れ抽選（1人用 startRace の NPC 分布が基準。
   気性 temper で個別化: 荒い馬ほど大出遅れが増え、穏やかな馬は安定する） */
function rollGateT(temper) {
  const t = temper == null ? 0.5 : temper;
  const pBad = 0.05 + t * 0.16;   // 大出遅れ 5%〜21%
  const pMid = 0.26 - t * 0.10;   // 小出遅れ 16%〜26%
  const r = Math.random();
  if (r < pBad) return 1.2 + Math.random() * 0.4;
  if (r < pBad + pMid) return 0.5 + Math.random() * 0.4;
  return Math.random() * 0.4;
}
function npcRankOf(view, self) { let r = 1; for (const o of view) if (o !== self && o.dist > self.dist) r++; return r; }
function npcRaceShapeMod(room, n) {
  const L = room.raceDist || 2000;
  const pr = NPC_STYLE_PROFILE[n.styleKey], p = n.dist / L, rem = L - n.dist;
  let m;
  if (rem < pr.kickFrom) {
    m = pr.kick * (n.burstMul || 1); // 瞬発力の個体差は末脚の伸びに効く
    if (room.paceHeat > 0.25) m *= (n.styleKey === 'sashi' || n.styleKey === 'oikomi') ? 1.012 : 0.994;
  }
  else if (p < 0.32) m = pr.early;
  else m = pr.mid;
  return m;
}
/* 作戦（1人用 resetRace の plan 生成を移植）: 局面ごとの目標順位＋仕掛け距離 */
function npcMakePlan(styleKey, num, startLat) {
  const pshift = ((num * 7) % 5) - 2;
  const pbase = styleKey === 'nige' ? [1, 1, 1, 1] : styleKey === 'senko' ? [3, 3, 3, 2]
    : styleKey === 'sashi' ? [11, 10, 7, 3] : [15, 15, 12, 4]; // 差し・追込の目標順位も仕様§5対応で圏内に寄せた（1人用は sashi[11,11,8,3] / oikomi[16,16,14,4]）
  const plan = {
    pos: pbase.map(v => clampN(v + pshift, 1, 18)),
    kick: NPC_STYLE_PROFILE[styleKey].kickFrom,
    gate: num, inside: startLat <= -3.4, outside: startLat >= 3.4,
  };
  if (plan.outside && (styleKey === 'nige' || styleKey === 'senko')) plan.pos[0] = clampN(plan.pos[0] + 2, 1, 18);
  if (plan.outside && (styleKey === 'sashi' || styleKey === 'oikomi')) plan.pos[0] = clampN(plan.pos[0] + 1, 1, 18);
  if (plan.inside && (styleKey === 'nige' || styleKey === 'senko')) plan.pos[0] = clampN(plan.pos[0] - 1, 1, 18);
  return plan;
}
/* ホームレーン（1人用 homeLat と同じ: 内ラチ沿いを脚質別にずらす） */
function npcHomeLat(styleKey, num) {
  const homeBase = styleKey === 'nige' ? -8.9 : styleKey === 'senko' ? -8.5 : styleKey === 'sashi' ? -7.9 : -8.3;
  return clampN(homeBase + (((num * 29) % 30) / 10 - 1.0), -9.4, -4.8);
}
/* NPCのペース判断（1人用 aiPace の移植。view は全ランナーの統一ビュー） */
function npcAiPace(room, view, n) {
  const rem = (room.raceDist || 2000) - n.dist, st = n.styleKey, stam = n.stamina;
  const ph = npcPhaseIdx(room, n.dist);
  const want = n.plan ? n.plan.pos[ph] : 8;
  const rank = npcRankOf(view, n);
  const diff = rank - want; // + = 計画より後ろ、- = 計画より前
  const kickD = (n.plan ? n.plan.kick : 420) * (stam > 55 ? 1.15 : (stam < 30 ? 0.78 : 1));
  if (rem < kickD) return stam > 18 ? 'pushL' : 'pushS';
  if (stam < 18) return 'hold';
  if (n.dist < 170) { // ゲート後の位置取り
    if (st === 'nige') return 'pushS';
    if (st === 'senko') {
      if (n.plan && n.plan.outside && rank > 4) return 'nari';
      return rank <= 3 ? 'nari' : 'pushS';
    }
    return 'nari'; // 差し・追込は後ろで脚を溜める
  }
  // 先頭争いのデュエル判定（消耗戦を避けて引く判断まで1人用どおり）
  n.duel = false;
  if (n.dist < 750 && (st === 'nige' || st === 'senko') && rank <= 2) {
    for (const o of view) {
      if (o === n) continue;
      if ((o.styleKey === 'nige' || o.styleKey === 'senko') && npcRankOf(view, o) <= 2 && Math.abs(o.dist - n.dist) < 2.2) {
        n.duel = true;
        // 気性の荒い馬（temper>=0.72）は先頭争いで引かず、消耗戦に付き合う
        n.duelYield = o.stamina >= stam && !(st === 'nige' && o.styleKey !== 'nige') && (n.temper || 0) < 0.72;
        break;
      }
    }
    if (n.duel && n.duelYield) return 'nari';
  }
  if (stam < 36) return (st === 'sashi' || st === 'oikomi') && ph < 2 ? 'hold' : (diff >= 3 ? 'nari' : 'hold');
  if (n.blocked && rem > kickD + 60) return diff >= 4 ? 'nari' : 'hold';
  if (st === 'nige') {
    if (rank === 1) {
      let gapB = 1e9;
      for (const o of view) { if (o !== n) { const gd = n.dist - o.dist; if (gd > 0 && gd < gapB) gapB = gd; } }
      if (gapB < 1.8) return 'pushS';
      if (gapB > 6) return 'hold';
      return 'nari';
    }
    if (n.dist < 700 && diff >= 1) return 'pushS';
    return diff >= 3 ? 'pushS' : 'nari';
  }
  if (st === 'senko') {
    if (rank === 1 && rem > 430) return 'hold';
    if (diff >= 3) return ph >= 2 ? 'pushS' : 'nari';
    if (diff >= 1) return stam > 48 ? 'pushS' : 'nari';
    if (diff <= -2) return 'hold';
    return 'nari';
  }
  if (st === 'sashi') {
    // 先頭との差が開きすぎたら、中盤でも圏内を保ちにいく（仕様§11の状況判断）
    let leadGapS = 0; for (const o of view) if (o.dist - n.dist > leadGapS) leadGapS = o.dist - n.dist;
    if (ph >= 1 && leadGapS > 55 && stam > 45) return 'pushS';
    if (ph <= 1) {
      if (diff <= -3) return 'hold';
      return 'nari';
    }
    if (ph === 2) {
      if (room.paceHeat > 0.3 && rem > 620) return 'nari';
      return (diff >= 2 || stam > 45) ? 'pushS' : 'nari';
    }
    return 'pushS';
  }
  // oikomi: 最後の直線まで後方で待つ（ただし中盤以降に離されすぎたら圏内へ寄せ始める）
  if (rem > 430) {
    // 先頭との差が開きすぎたら、フェーズに関わらず圏内を保ちにいく（仕様§11）。
    // 順位だけ見ていると、馬群が縦長に伸びた時に「定位置の最後方」が
    // 勝負圏外まで置いていかれるため、距離差でも判断する
    let leadGap = 0; for (const o of view) if (o.dist - n.dist > leadGap) leadGap = o.dist - n.dist;
    if (leadGap > 38 && stam > 40) return 'pushS';
    if (ph >= 2 && diff >= 3) return 'pushS';
    if (ph === 1 && diff >= 7) return 'pushS'; // 中盤で決定的に離されたら早めに寄せる
    if (diff <= -3) return 'hold';
    return 'nari';
  }
  return 'pushS';
}
/* NPCの進路判断（1人用 decideLat の移植: 内ラチがホーム。抜く時だけ一時的に外へ） */
function npcDecideLat(room, view, n) {
  const rem = (room.raceDist || 2000) - n.dist, corner = npcIsCorner(room, n.dist);
  const home = n.homeLat != null ? n.homeLat : -8;
  const startLat = (n.lane - 8.5) * LANE_W_S;
  function laneFree(lat, back, range) {
    for (const o of view) {
      if (o === n) continue;
      const dd = o.dist - n.dist;
      if (dd > back && dd < range && Math.abs(o.lat - lat) < 1.15) return false;
    }
    return true;
  }
  if (n.dist < 240) {
    if ((n.styleKey === 'nige' || n.styleKey === 'senko') && n.lat > home + 0.8 && laneFree(n.lat - 1.3, -1.5, 5.5))
      n.targetLat = n.lat - 1.3;
    else n.targetLat = startLat;
    return;
  }
  let blocker = null;
  for (const o of view) {
    if (o === n || o.finished) continue;
    const dd = o.dist - n.dist;
    if (dd > 0.4 && dd < 4.2 && Math.abs(o.lat - n.lat) < 1.15) { blocker = o; break; }
  }
  if (blocker) {
    /* 最終局面の進路選択（仕様§5）: 仕掛けている馬（pushS/pushL）が前を塞がれたら、
       ±1レーンだけでなく外へ大きく持ち出して「前に馬のいないレーン」を探す。
       実競馬の直線で後方勢が外に膨らんで進路を確保する動き。内は距離損が無い
       代わりに混むので、直線では外側の空きを優先して探す */
    if (rem < 500 && (n.pace === 'pushS' || n.pace === 'pushL')) {
      const cands = [n.lat + 1.35, n.lat + 2.7, n.lat + 4.05, n.lat - 1.35];
      for (const c of cands) {
        const cl = clampN(c, -LAT_MAX_S, LAT_MAX_S);
        if (Math.abs(cl - n.lat) < 0.3) continue;
        if (laneFree(cl, -1.5, 9.0)) { n.targetLat = cl; n.swingLat = cl; n.swingUntil = room.raceClock + 2.8; return; }
      }
    }
    const inLat = clampN(n.lat - 1.35, -LAT_MAX_S, LAT_MAX_S), outLat = clampN(n.lat + 1.35, -LAT_MAX_S, LAT_MAX_S);
    const inFree = laneFree(inLat, -1.5, 6.5), outFree = laneFree(outLat, -1.5, 6.5);
    let pick = null;
    if (corner || rem < 430) pick = inFree ? inLat : (outFree ? outLat : null);
    else pick = outFree ? outLat : (inFree ? inLat : null);
    if (pick != null) { n.targetLat = pick; n.swingLat = pick; n.swingUntil = room.raceClock + 2.4; }
    else if (room.raceClock < n.swingUntil) n.targetLat = n.swingLat;
    return;
  }
  if (room.raceClock < n.swingUntil) { n.targetLat = n.swingLat; return; }
  const baseLat = corner ? clampN(home - 0.5, -LAT_MAX_S, LAT_MAX_S) : home;
  if (rem < 430 && (n.styleKey === 'sashi' || n.styleKey === 'oikomi') && (n.pace === 'pushS' || n.pace === 'pushL')) {
    const outT = clampN(home + 2.2, -LAT_MAX_S, 4.2);
    if (laneFree(outT, -1.5, 5.5)) { n.targetLat = outT; return; }
  }
  if (Math.abs(n.lat - baseLat) > 0.35 && !laneFree(baseLat, -2.0, 3.0)) {
    // ホームが塞がれている間も、内へ1レーン分の空きがあれば少しずつ寄せる
    // （フェーズ16の最小調整: 1人用の元仕様は現位置で待ち続けるため、外へ
    // 押し出された馬や外枠の馬が「塞がれたホーム」を理由にレース中ずっと
    // 外を回り続けるケースがあった。空いている所へ1レーンずつ詰めるのは
    // 実競馬の位置取りそのもので、無理な割り込みにはならない）
    const stepIn = clampN(n.lat - 1.35, -LAT_MAX_S, LAT_MAX_S);
    if (stepIn < n.lat - 0.3 && laneFree(stepIn, -1.5, 5.5)) { n.targetLat = stepIn; return; }
    n.targetLat = n.lat; return;
  }
  n.targetLat = baseLat;
}
/* NPC 1頭分の物理更新（1人用 stepHorse のNPC分岐を移植。
   馬場補正・距離適性・ゲート出遅れも1人用 stepHorse と同じ式で入る） */
function stepNpc(room, view, n, dt, now) {
  const L = room.raceDist || 2000;
  const going = room.going || CAT.GOING_LIST[0];
  if (n.finished) {
    // ゴール後の流し: 決勝線を過ぎても止まらず、勢いのまま減速する
    const over = n.dist - L;
    const dec = (over < 40 ? 0.7 : (over < 100 ? 1.5 : 2.6)) * SPEED_MULT * SPEED_MULT; // 減速×倍率²＝流し距離を従来と同一に（フェーズ18）
    n.speed = Math.max(0, n.speed - dec * dt);
    n.dist += n.speed * dt * npcCornerFactorFor(room, n);
    return;
  }
  n.aiTimer -= dt;
  if (n.aiTimer <= 0) { n.aiTimer = 0.7 + ((n.num * 37) % 40) / 100; n.pace = npcAiPace(room, view, n); }
  n.aiLatTimer -= dt;
  if (n.aiLatTimer <= 0) { n.aiLatTimer = 0.45; npcDecideLat(room, view, n); }
  // スリップストリーム判定
  n.slip = false;
  for (const o of view) {
    if (o === n || o.finished) continue;
    const dd = o.dist - n.dist;
    if (dd > 1.0 && dd < 8.5 && Math.abs(o.lat - n.lat) < 1.15) { n.slip = true; break; }
  }
  const pc = NPC_PACE[n.pace];
  let drain = pc.stam * SPEED_MULT; // 毎秒消費×倍率＝距離あたりの消費を従来と同一に保つ（フェーズ18）
  if (drain < 0 && n.slip) drain *= (n.styleKey === 'senko' ? 0.32 : 0.45);
  if (drain < 0) {
    drain *= going.drain; // 馬場: 重いほど全馬の消費増（1人用 stepHorse と同一）
    if (going.id !== 'ryo') drain *= (1 + (1 - (n.heavy || 1)) * (going.id === 'ju' ? 1.1 : 0.55)); // 重馬場適性が高い馬は消費が軽い
    drain *= (n.endureMul || 1); // 持久力の個体差（仕様§7）
    // 距離適性（仕様§9）: その距離が苦手な馬は後半に脚が止まりやすく、得意な馬は最後まで持つ
    const aptHere = (n.apt || [1, 1, 1])[distCatIdxOf(L)] ?? 1;
    if (n.dist > L * 0.5) { if (aptHere <= 0) drain *= 1.3; else if (aptHere >= 2) drain *= 0.94; }
    if (room.paceHeat > 0.25 && npcRankOf(view, n) <= 3) drain *= 1.18; // ハイペースを作る先行勢は消耗
    if (n.duel) drain *= 1.18;
  }
  n.stamina = clampN(n.stamina + drain * dt, 0, 100);
  const tired = n.stamina < 35 ? 0.80 + 0.20 * (n.stamina / 35) : 1;
  const heavySpd = going.id === 'ryo' ? 1 : (1 + ((n.heavy || 1) - 1) * (going.id === 'ju' ? 1 : 0.55));
  let target = n.base * (1 + ((n.rating || 90) - 90) * 0.0011) * n.dayForm * npcAptMul(n.apt, L)
    * pc.mul * npcRaceShapeMod(room, n) * tired * going.speed * heavySpd
    * (1 + Math.sin(room.raceClock * 0.6 + n.num * 2.3) * 0.004);
  // 追走キャップ: 前の馬との間隔を保つ（1人用 followCap）
  if (n.dist > 60) {
    const wantGap = 2.6 + ((n.num * 13) % 10) / 6;
    for (const fo of view) {
      if (fo === n || fo.finished) continue;
      const fd = fo.dist - n.dist;
      if (fd > 0.6 && fd < 7.5 && Math.abs(fo.lat - n.lat) < 1.05) {
        const followCap = fo.speed + clampN((fd - wantGap) * 0.5, -0.7 * SPEED_MULT, 1.3 * SPEED_MULT);
        if (followCap < target) target = followCap;
      }
    }
  }
  // 前詰まりキャップ: 真ん前が壁なら減速（進路変更は decideLat の仕事）
  n.blocked = false;
  for (const b of view) {
    if (b === n || b.finished) continue;
    const bd = b.dist - n.dist;
    if (n.dist > 60 && bd > 0.5 && bd < 3.6 && Math.abs(b.lat - n.lat) < 1.02) {
      const capF = n.lat < -3.4 ? 0.962 : (n.lat > 3.4 ? 1.012 : 0.995);
      if (b.speed * capF < target) target = b.speed * capF;
      n.blocked = true;
    }
  }
  if (n.gateT > 0) { n.gateT -= dt; target = Math.min(target, 4.2 * SPEED_MULT); } // ゲート出遅れ中は加速できない（1人用と同一。キャップは倍率連動で相対ペナルティ不変）
  const rate = target > n.speed ? 0.85 * (n.accelMul || 1) : 2.1; // 加速力の個体差（仕様§7）。減速は全馬共通
  n.speed += (target - n.speed) * (1 - Math.exp(-rate * dt));
  n.dist += n.speed * dt * npcCornerFactorFor(room, n);
  if (n.dist >= L && !n.finished) {
    n.finished = true;
    // ゴール時刻はティック内を補間して精密化（写真判定の0.17秒窓に効く）
    const over = n.dist - L;
    n.finishClock = Math.max(0, room.raceClock - (n.speed > 0 ? over / n.speed : 0));
    n.finishAt = room.raceStartAt + n.finishClock * 1000;
    broadcast(room, { type: 'runnerFinished', nickname: n.nickname, t: Math.round(n.finishClock * 1000) / 1000 });
  }
  // 横移動: 慣性のある「のっそり」した動き（1人用NPCと同値）
  const wantV = clampN((n.targetLat - n.lat) * 1.4, -1.05 * SPEED_MULT, 1.05 * SPEED_MULT);
  const dvv = wantV - n.latVel, maxDv = 1.9 * SPEED_MULT * dt;
  n.latVel += clampN(dvv, -maxDv, maxDv);
  n.lat = clampN(n.lat + n.latVel * dt, -LAT_MAX_S, LAT_MAX_S);
  if ((n.lat <= -LAT_MAX_S && n.latVel < 0) || (n.lat >= LAT_MAX_S && n.latVel > 0)) n.latVel = 0;
}

/* 馬同士のセパレーション（1人用 checkInterference の物理分離をサーバーへ移植）。
   1人用では全馬ペアが相互に押し合うが、ここでは人間の横位置はクライアントが
   決めるため、人間には適用せず NPC 側にだけ押し出し＋進路ドリフトを効かせる
   （NPC同士は相互）。これが無いと、内をホームにするNPCが人間に寄せ続けて
   内ラチとの間に挟み、クライアント側の一方的な押し出しだけでは抜け出せない
   「壁」感覚になっていた。定数は1人用と同一: 接触域 2.9m × 1.04m、
   押し出し 1.6（latVel クランプ ±2.2）、進路ドリフト 1.4、並走時の速度
   ブレンド（NPC同士のみ、1人用は raceTime>3.5 で有効）。 */
function separateRunners(room, view, dt) {
  for (let i = 0; i < view.length; i++) for (let j = i + 1; j < view.length; j++) {
    const a = view[i], b = view[j];
    if (a.human && b.human) continue;
    if (a.finished || b.finished) continue;
    const dd = b.dist - a.dist, ld = b.lat - a.lat;
    if (Math.abs(dd) >= 2.9 || Math.abs(ld) >= 1.04) continue;
    const dir = ld === 0 ? (j % 2 ? 1 : -1) : Math.sign(ld);
    const fade = (1 - Math.abs(dd) / 2.9) * ((1.04 - Math.abs(ld)) / 1.04);
    const pushV = dir * fade * 1.6 * SPEED_MULT * dt, drift = dir * fade * 1.4 * SPEED_MULT * dt;
    if (!a.human) { a.latVel = clampN(a.latVel - pushV, -2.2 * SPEED_MULT, 2.2 * SPEED_MULT); a.targetLat = clampN(a.targetLat - drift, -LAT_MAX_S, LAT_MAX_S); }
    if (!b.human) { b.latVel = clampN(b.latVel + pushV, -2.2 * SPEED_MULT, 2.2 * SPEED_MULT); b.targetLat = clampN(b.targetLat + drift, -LAT_MAX_S, LAT_MAX_S); }
    if (!a.human && !b.human && Math.abs(ld) < 0.55 && room.raceClock > 3.5) {
      const avg = (a.speed + b.speed) / 2, blend = Math.min(1, dt * 2.5) * 0.5;
      a.speed += (avg - a.speed) * blend; b.speed += (avg - b.speed) * blend;
    }
  }
}

function buildField(room) {
  const L = room.raceDist || 2000;
  room.going = CAT.rollGoing(); // 馬場は開催ごとに抽選（1人用 pickGoing と同じ比率）
  // AI騎手の割り当て（1人用 assignJockeys と同一: 架空名18名をシャッフルして重複なし）
  const jockeyPool = [...CAT.AI_JOCKEYS];
  for (let i = jockeyPool.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [jockeyPool[i], jockeyPool[j]] = [jockeyPool[j], jockeyPool[i]]; }
  let jk = 0;
  const nextJockey = () => jockeyPool[jk++ % jockeyPool.length];
  room.npcs = [];
  if (room.mode === 'watch' && room.watchSession) {
    // 観戦: 出走表はセッションの18頭そのまま。全頭NPCで、調子は新聞の form を使う
    room.watchSession.field.forEach((name, lane) => {
      const h = horseByName(name);
      if (!h) return;
      const styleKey = NPC_STYLE_KEY[h.style] || 'senko';
      const startLat = (lane - 8.5) * LANE_W_S;
      room.npcs.push(makeNpc(room, h, lane, nextJockey(), room.watchSession.form[name] || 1, startLat, styleKey));
    });
  } else {
    // 騎手: 人間の馬以外からNPCを補充して18頭立て（名簿50頭からランダム抽選）
    const usedIds = new Set([...room.members.values()].map(m => m.horseId));
    const pool = HORSES.filter(h => !usedIds.has(h.id));
    let lane = room.members.size;
    while (room.members.size + room.npcs.length < FIELD_SIZE && pool.length) {
      const h = pool.splice(crypto.randomInt(pool.length), 1)[0];
      const styleKey = NPC_STYLE_KEY[h.style] || 'senko';
      const startLat = (lane - 8.5) * LANE_W_S;
      room.npcs.push(makeNpc(room, h, lane++, nextJockey(), 1 + (Math.random() - 0.5) * 0.007, startLat, styleKey));
    }
  }
  let i = 0;
  for (const m of room.members.values()) {
    m.lane = i++; m.dist = 0; m.speed = 0; m.finished = false; m.finishAt = null;
    m.fouls = 0; m.finishClock = null;
    m.dayForm = 1 + (Math.random() - 0.5) * 0.007; // 人間にも当日の調子を抽選（クライアントが自馬分を受け取る）
    m.jockey = m.nickname;
  }
}
function makeNpc(room, h, lane, jockey, dayForm, startLat, styleKey) {
  const temper = npcTrait(h.num, 53); // 気性 0..1（穏やか→荒い）
  return {
    nickname: 'NPC・' + h.name, horseId: h.id, horseName: h.name, npc: true, jockey,
    dist: 0, lane, speed: 0, finished: false, finishAt: null, finishClock: null,
    style: h.style,
    // ---- 1人用エンジン移植の走行状態 ----
    num: h.num, rating: h.rating, styleKey,
    base: h.base * SPEED_MULT, heavy: h.heavy, apt: h.apt,
    dayForm,
    // ---- 個体特性（仕様§7: カタログに無い能力値を num から決定的に導出） ----
    temper,
    accelMul: 0.88 + npcTrait(h.num, 11) * 0.24,  // 加速力: 加速の exp レート ×0.88〜1.12
    endureMul: 0.92 + npcTrait(h.num, 23) * 0.16, // 持久力: スタミナ消費 ×0.92〜1.08
    cornerMul: 0.90 + npcTrait(h.num, 37) * 0.20, // コーナリング: コーナー係数の効き ×0.90〜1.10
    burstMul: 0.97 + npcTrait(h.num, 41) * 0.06,  // 瞬発力: 末脚倍率 ×0.97〜1.03
    gateT: rollGateT(temper),
    lat: startLat, targetLat: startLat, latVel: 0,
    stamina: 100, pace: 'nari',
    aiTimer: 0.5 + ((h.num * 53) % 50) / 100, aiLatTimer: 0.4 + ((h.num * 29) % 30) / 100,
    plan: npcMakePlan(styleKey, h.num, startLat), homeLat: npcHomeLat(styleKey, h.num),
    swingUntil: 0, swingLat: 0, duel: false, duelYield: false, blocked: false, slip: false,
  };
}
function fieldList(room) {
  if (room.mode === 'watch') {
    // 観戦: 出走するのは18頭のNPCだけ（オーナーは走らない）
    return room.npcs.map(n => ({
      nickname: n.nickname, horseId: n.horseId, horseName: n.horseName, npc: true, lane: n.lane,
      style: n.style, dayForm: n.dayForm, jockey: n.jockey,
    })).sort((a, b) => a.lane - b.lane);
  }
  const humans = [...room.members.values()].map(m => ({
    nickname: m.nickname, horseId: m.horseId, horseName: horseById(m.horseId)?.name || m.horseId, npc: false, lane: m.lane,
    style: horseById(m.horseId)?.style || '先行', dayForm: m.dayForm || 1, jockey: m.nickname,
  }));
  const npcs = room.npcs.map(n => ({
    nickname: n.nickname, horseId: n.horseId, horseName: n.horseName, npc: true, lane: n.lane,
    style: n.style, dayForm: n.dayForm, jockey: n.jockey,
  }));
  return [...humans, ...npcs].sort((a, b) => a.lane - b.lane);
}
function startRace(room) {
  if (room.state !== 'countdown') return;
  room.state = 'racing';
  room.paceHeat = 0; room.raceClock = 0; // 全体ペース判定（1人用 paceHeat）をリセット
  const now0 = Date.now();
  for (const m of room.members.values()) { m.lastPosAt = now0; m.dist = 0; m.speed = 0; }
  broadcast(room, { type: 'raceStart', field: fieldList(room), meta: raceMeta(room) });
  let last = Date.now();
  room.tickTimer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    tickNpcs(room, dt, now);
    broadcast(room, { type: 'state', t: now, runners: allPositions(room) });
    checkRaceEnd(room, now);
  }, 100);
}
/* NPCティックは最大1/60秒のサブステップで回す（1人用エンジンと同じ粒度）。
   100ms刻みのままだと馬が1ティックで約1.7m進み、追走/前詰まりキャップや
   馬同士のセパレーション（速度ベースの押し出し）が反応する前に相手の領域へ
   突っ込んでしまう（トンネリング）。実測では接触ゾーン滞在が約147 pair秒
   →約33 pair秒、深い重なりが約26 pair秒→約6 pair秒まで減る（同一式・同一
   定数のまま粒度だけを1人用に一致させた効果）。配信は従来どおり100ms毎。 */
function tickNpcs(room, dt, now) {
  const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) tickNpcsStep(room, h, now);
}
function tickNpcsStep(room, dt, now) {
  room.raceClock = (room.raceClock || 0) + dt;
  if (room.paceHeat == null) room.paceHeat = 0;
  // 全ランナーの統一ビュー（人間はサーバー検証済みの dist/lane/speed から組み立てる）
  const view = [];
  for (const m of room.members.values()) {
    view.push({
      dist: m.dist, speed: m.speed, lat: (m.lane - 8.5) * LANE_W_S, finished: m.finished,
      styleKey: NPC_STYLE_KEY[(horseById(m.horseId) || {}).style] || 'senko', stamina: 100, human: true,
    });
  }
  for (const n of room.npcs) view.push(n);
  // 全体ペース（1人用 paceHeat の更新式そのまま: 先頭馬の速度から算出）
  let lead = view[0];
  for (const r of view) if (r.dist > lead.dist) lead = r;
  const L = room.raceDist || 2000;
  if (lead && lead.dist < L * 0.45) {
    room.paceHeat += (clampN((lead.speed - 16.7 * SPEED_MULT) / (1.1 * SPEED_MULT), -1, 1) - room.paceHeat) * Math.min(1, dt * 0.6);
  }
  if (lead && lead.dist < L * 0.375 && view.some(r => r.duel)) {
    room.paceHeat += (0.55 - room.paceHeat) * Math.min(1, dt * 0.5);
  }
  for (const n of room.npcs) stepNpc(room, view, n, dt, now);
  separateRunners(room, view, dt);
}
function allPositions(room) {
  const humans = room.mode === 'watch' ? [] : [...room.members.values()].map(m => ({
    nickname: m.nickname, dist: Math.round(m.dist * 10) / 10, lane: m.lane,
    speed: Math.round(m.speed * 10) / 10, finished: m.finished, npc: false,
  }));
  const npcs = room.npcs.map(n => ({
    nickname: n.nickname, dist: Math.round(n.dist * 10) / 10,
    lane: Math.round((8.5 + n.lat / LANE_W_S) * 100) / 100, // 現在の横位置を連続レーンで配信
    speed: Math.round(n.speed * 10) / 10, finished: n.finished, npc: true,
  }));
  return [...humans, ...npcs];
}
function checkRaceEnd(room, now) {
  if (room.state !== 'racing') return;
  const humans = [...room.members.values()];
  const anyFinished = [...humans, ...room.npcs].some(r => r.finished);
  if (!room.firstFinishAt && anyFinished) {
    room.firstFinishAt = now;
    // 最初のゴールから20秒で打ち切り
    room.finishTimer = setTimeout(() => finishRace(room), 20000);
  }
  if (room.mode === 'watch') {
    if (room.npcs.length && room.npcs.every(n => n.finished)) finishRace(room);
    return;
  }
  const allHumansDone = humans.every(m => m.finished);
  if (allHumansDone && room.npcs.every(n => n.finished)) finishRace(room);
}
function finishRace(room) {
  if (room.state === 'finished') return;
  room.state = 'finished';
  clearInterval(room.tickTimer); clearTimeout(room.finishTimer);
  const L = room.raceDist || 2000;
  const clockOf = r => r.npc ? (r.finishClock != null ? r.finishClock : Infinity)
    : (r.finishAt != null ? (r.finishAt - room.raceStartAt) / 1000 : Infinity);
  const all = room.mode === 'watch' ? [...room.npcs] : [...room.members.values(), ...room.npcs];
  // 生の着順: 完走はゴール時刻順、未完走は距離順（1人用 showResult の並びと同一）
  const raw = [...all].sort((a, b) => {
    const ca = clockOf(a), cb = clockOf(b);
    if (ca !== Infinity && cb !== Infinity) return ca - cb;
    if (ca !== Infinity) return -1;
    if (cb !== Infinity) return 1;
    return b.dist - a.dist;
  });
  raw.forEach((r, i) => { r.rawPlace = i + 1; });
  // 降着（1人用 showResult と同一: 反則3回以上で +2、5回以上で +3、最大18位）
  const official = [...raw];
  for (const r of raw) {
    if (r.npc || !r.fouls || r.fouls < 3) continue;
    const penalty = r.fouls >= 5 ? 3 : 2;
    const from = official.indexOf(r);
    official.splice(from, 1);
    official.splice(Math.min(official.length, from + penalty), 0, r);
  }
  const winner = official[0];
  const winnerJockey = winner ? (winner.npc ? winner.jockey : winner.nickname) : undefined;
  const winnerHorseName = winner ? (winner.npc ? winner.horseName : (horseById(winner.horseId)?.name || winner.horseId)) : undefined;
  const standings = official.map((r, i) => {
    const t = clockOf(r);
    return {
      place: i + 1, rawPlace: r.rawPlace, nickname: r.nickname,
      horseName: r.npc ? r.horseName : (horseById(r.horseId)?.name || r.horseId),
      horseId: r.horseId, jockey: r.npc ? r.jockey : r.nickname,
      npc: !!r.npc, dist: Math.round(r.dist),
      time: t !== Infinity ? Math.round(t * 100) / 100 : null,
      fouls: r.npc ? 0 : (r.fouls || 0),
    };
  });
  let betResult = null;
  if (room.mode === 'watch') {
    // 観戦: 本人の賭けを精算し、ランキングへ記録（1人用 settleBet 相当をサーバーで完結）
    const owner = room.owner && players[room.owner] ? normalizePlayer(players[room.owner]) : null;
    if (owner) {
      const order = standings.map(s2 => s2.horseName);
      recordRaceResultFor(owner, winnerJockey);
      if (room.betId != null) {
        const bet = owner.bets.find(b => b.id === room.betId);
        if (bet && bet.settled !== 1) {
          const won = CAT.betWon(bet.type, bet.picks, order);
          const payout = won ? Math.floor(bet.stake * bet.odds * (bet.grade === 'g1' ? CAT.G1_PAYOUT_MULT : 1)) : 0;
          bet.settled = 1; bet.payout = payout;
          if (won) {
            if (bet.type === 'wide') bumpCounter(owner, 'wide_hits');
            if (bet.type === 'trifecta') bumpCounter(owner, 'trifecta_hits');
            if (bet.grade === 'g1') bumpCounter(owner, 'g1_wins');
          }
          if (payout > 0) owner.balance += payout;
          betResult = { betId: bet.id, type: bet.type, picks: bet.picks, stake: bet.stake, odds: bet.odds, grade: bet.grade, won, payout, balance: owner.balance };
        }
      }
      if (owner.watchSession && owner.watchSession.betId === room.betId) owner.watchSession = null;
      persistPlayer(room.owner);
    }
  } else {
    // 騎手: 公式着順で賞金・成績・ミッション進捗・ランキングを記録（1人用 awardPrize 相当）
    for (const m of room.members.values()) {
      const st = standings.find(s2 => s2.nickname === m.nickname);
      const p = players[m.nickname];
      if (p && st) {
        normalizePlayer(p);
        p.races += 1;
        if (st.place === 1) p.wins += 1;
        const prize = CAT.prizeForRank(st.place, room.grade || 'normal', L);
        p.balance += prize;
        st.prize = prize;
        bumpCounter(p, 'jockey_starts');
        if (prize > 0) bumpCounter(p, 'jockey_prize_total', prize);
        if (st.place === 1) {
          bumpCounter(p, 'jockey_wins');
          if ((room.grade || 'normal') === 'g1') bumpCounter(p, 'g1_wins');
        }
        recordRaceResultFor(p, winnerJockey);
      }
    }
    persistAll();
  }
  room.results = standings;
  broadcast(room, { type: 'results', standings, meta: raceMeta(room), winnerJockey, winnerHorseName, betResult });
}
function leaveRoom(room, nickname) {
  // 観戦レースを途中で離れたら、未精算の賭けは返金して部屋を畳む（1人用 refundBet 相当）
  if (room.mode === 'watch' && room.owner === nickname && room.state !== 'finished' && room.betId != null) {
    const p = players[nickname];
    if (p) {
      normalizePlayer(p);
      const bet = p.bets.find(b => b.id === room.betId);
      if (bet && bet.settled !== 1) {
        bet.settled = 1; bet.payout = bet.stake; bet.refunded = 1;
        p.balance += bet.stake;
        persistPlayer(nickname);
      }
      if (p.watchSession) p.watchSession = null;
    }
    room.betId = null;
  }
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
      send(ws, { type: 'welcome', profile: publicProfile(nickname), horses: HORSES, version: BUILD_VERSION });
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
        room.mode = 'jockey';
        room.raceDist = validDistance(msg.distance);
        room.grade = consumeGrade(nickname);
        member = addMember(room, nickname, ws);
        if (msg.horseId && players[nickname].unlocked.includes(msg.horseId)) member.horseId = msg.horseId;
        member.ready = true;
        send(ws, { type: 'room', room: roomSummary(room) });
        maybeStartCountdown(room);
        break;
      }
      case 'watchStart': {
        // 観戦モード: 本人のセッション（出走表＋調子）の18頭でAIレースを開始し、賭けを精算まで見届ける
        if (room) leaveRoom(room, nickname);
        const p = normalizePlayer(players[nickname]);
        const sess = p.watchSession;
        if (!sess || !Array.isArray(sess.field) || sess.field.length !== FIELD_SIZE) { send(ws, { type: 'error', message: '観戦レースの準備ができていません' }); break; }
        const bet = sess.betId != null ? p.bets.find(b => b.id === sess.betId) : null;
        if (!bet || bet.settled === 1) { send(ws, { type: 'error', message: '先に賭け券を購入してください' }); break; }
        room = createRoom(nickname);
        room.mode = 'watch';
        room.owner = nickname;
        room.watchSession = sess;
        room.betId = bet.id;
        room.raceDist = validDistance(sess.distance);
        room.grade = sess.grade || 'normal';
        member = addMember(room, nickname, ws);
        member.ready = true;
        send(ws, { type: 'room', room: roomSummary(room) });
        maybeStartCountdown(room);
        break;
      }
      case 'skip': {
        // 観戦スキップ（1人用 skipToFinal と同じ意味: 実シミュレーションを早回しする。
        // 1600m以上のみ「残り1000m」まで。最短の1200mレースには無い）
        if (!room || room.mode !== 'watch' || room.state !== 'racing') break;
        const L = room.raceDist || 2000;
        if (L <= 1200) break;
        const target = L - 1000;
        let guard = 0;
        while (guard++ < 30000) {
          let lead = 0;
          for (const n of room.npcs) if (n.dist > lead) lead = n.dist;
          if (lead >= target || room.npcs.every(n => n.finished)) break;
          tickNpcs(room, 0.05, Date.now());
        }
        broadcast(room, { type: 'state', t: Date.now(), runners: allPositions(room) });
        checkRaceEnd(room, Date.now());
        break;
      }
      case 'watchAbort': {
        if (room && room.mode === 'watch') {
          leaveRoom(room, nickname); // 未精算の賭けは leaveRoom 内で返金される
          room = null; member = null;
          send(ws, { type: 'watchAborted' });
        }
        break;
      }
      case 'leaveRoom': {
        if (room) { leaveRoom(room, nickname); room = null; member = null; }
        break;
      }
      case 'createRoom': {
        if (room) leaveRoom(room, nickname);
        room = createRoom(nickname);
        room.mode = 'jockey';
        room.raceDist = validDistance(msg.distance);
        room.grade = consumeGrade(nickname);
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
        const raceLen = room.raceDist || 2000;
        const reported = Number(msg.dist);
        if (Number.isFinite(reported)) {
          const target = Math.min(raceLen, Math.max(0, reported));
          const delta = target - member.dist;
          if (delta > 0) {
            const accepted = Math.min(delta, MAX_SPEED * dt + POS_JITTER_M);
            member.dist += accepted;
            if (dt > 0.01) member.speed = Math.min(MAX_SPEED, accepted / dt); // 速度はサーバー算出値を使う
          }
        }
        const lane = Number(msg.lane);
        if (Number.isFinite(lane)) member.lane = Math.min(FIELD_SIZE - 1, Math.max(0, lane));
        // 反則回数はクライアントの自己申告（自分の順位を下げる方向にしか効かないため受理する）
        const fouls = Number(msg.fouls);
        if (Number.isFinite(fouls)) member.fouls = Math.max(member.fouls || 0, Math.min(99, Math.floor(fouls)));
        if (member.dist >= raceLen) {
          member.dist = raceLen;
          member.finished = true;
          member.finishAt = now; // サーバー時刻で確定
          member.finishClock = (now - room.raceStartAt) / 1000;
          broadcast(room, { type: 'runnerFinished', nickname: member.nickname, t: Math.round(member.finishClock * 1000) / 1000 });
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
if (require.main === module) (async () => {
  try {
    store = createStore(process.env, { dataFile: DATA_FILE });
    const loaded = await store.init();   // PostgreSQL時はテーブル自動作成＋全件読み込み
    Object.assign(players, loaded);
    let merged = 0;
    for (const k of Object.keys(players)) {
      const before = (players[k].unlocked || []).length;
      const balBefore = players[k].balance;
      normalizePlayer(players[k]); // 旧データに拡張フィールドを補い、初期解放の保証マージ＋残高フロア移行を適用
      if ((players[k].unlocked || []).length !== before || players[k].balance !== balBefore) merged++;
    }
    if (merged > 0) { persistAll(); console.log(`[store] 起動時移行（初期解放マージ／残高フロア）を ${merged} 件に適用し保存しました`); }
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

/* テスト/計測用エクスポート（require された時だけ有効。通常起動では使わない） */
module.exports = { buildField, tickNpcs, makeNpc, npcMakePlan, CAT, SPEED_MULT, TRACK_LEN };
