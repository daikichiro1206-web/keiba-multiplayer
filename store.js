'use strict';
/*
 * プレイヤーデータ保存アダプタ
 *
 * 保存先は環境変数で切り替える:
 * - DATABASE_URL が設定されている → PostgreSQL に保存
 *   （Supabase 無料枠の接続文字列を想定。`pg` パッケージ使用、SSL対応）
 * - 未設定 → 従来どおりファイルに保存（DATA_DIR/players.json）
 *
 * どちらの方式でも「起動時に全件をメモリ（players オブジェクト）へ読み込み、
 * 変更のたびにアダプタ経由で書き戻す」インメモリキャッシュ方式。
 * そのため server.js 側のゲームロジックは従来どおり同期的に players を読み書きでき、
 * 永続化だけがアダプタに委譲される。
 *
 * テーブル設計（PostgreSQL）:
 *   players(nickname TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ)
 *   現行スキーマ（salt / passHash / balance / unlocked / wins / races）は
 *   丸ごと JSONB カラムに格納する。起動時に CREATE TABLE IF NOT EXISTS で自動作成。
 */
const fs = require('fs');
const path = require('path');

/* ---------------- DATABASE_URL の検証・パース（接続しない単体関数） ---------------- */
function parseDatabaseUrl(urlStr) {
  let u;
  try { u = new URL(String(urlStr || '')); }
  catch { throw new Error('DATABASE_URL の形式が不正です（URLとして解釈できません）'); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL のスキームは postgres:// である必要があります（実際: ${u.protocol}//）`);
  }
  if (!u.hostname) throw new Error('DATABASE_URL にホストが含まれていません');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL にデータベース名が含まれていません');
  const sslmode = u.searchParams.get('sslmode');
  // Supabase 等の外部DBはSSL必須。sslmode=disable 明示時と localhost 接続時のみ平文を許可する
  const ssl = sslmode === 'disable' || u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    ? false
    : { rejectUnauthorized: false }; // Supabaseプーラーの証明書チェーン対策で検証は緩める（暗号化自体は有効）
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    database,
    user: decodeURIComponent(u.username || ''),
    ssl: !!ssl,
  };
}

function detectBackend(env = process.env) {
  return env.DATABASE_URL ? 'postgres' : 'file';
}

/* ---------------- ファイル保存（従来方式） ---------------- */
class FileStore {
  constructor(dataFile) {
    this.mode = 'file';
    this.dataFile = dataFile;
  }
  describe() { return `ファイル (${this.dataFile})`; }
  async init() {
    try { return JSON.parse(fs.readFileSync(this.dataFile, 'utf8')); }
    catch { return {}; }
  }
  // ファイル方式は従来どおり全件を同期書き込みする（savePlayer も全件保存に寄せる）
  async savePlayer(_nickname, _record, allPlayers) { this.saveAllSync(allPlayers); }
  async saveAll(allPlayers) { this.saveAllSync(allPlayers); }
  saveAllSync(allPlayers) {
    if (!allPlayers) return;
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(allPlayers, null, 2));
  }
  async close() {}
}

/* ---------------- PostgreSQL 保存（Supabase想定） ---------------- */
class PgStore {
  constructor(connectionString) {
    this.mode = 'postgres';
    this.info = parseDatabaseUrl(connectionString); // 形式不正ならここで例外（起動を止めて気づけるように）
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString,
      ssl: this.info.ssl ? { rejectUnauthorized: false } : false,
    });
    this.pool.on('error', e => console.error('[store] PostgreSQL プールエラー:', e.message));
    this.chains = new Map(); // nickname -> 書き込み直列化用の Promise チェーン
  }
  describe() { return `PostgreSQL (${this.info.host}:${this.info.port}/${this.info.database})`; }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        nickname   TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const r = await this.pool.query('SELECT nickname, data FROM players');
    const players = {};
    for (const row of r.rows) players[row.nickname] = row.data;
    return players;
  }

  async upsert(nickname, record) {
    // 呼び出し時点のスナップショットを文字列化してから渡す（後続の変更と競合させない）
    const json = JSON.stringify(record);
    await this.pool.query(
      `INSERT INTO players (nickname, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (nickname) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [nickname, json],
    );
  }

  // 同一プレイヤーへの書き込みは直列化し、順序の入れ替わりを防ぐ
  savePlayer(nickname, record) {
    if (!record) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(record));
    const prev = this.chains.get(nickname) || Promise.resolve();
    const next = prev.then(() => this.upsert(nickname, snapshot));
    // チェーン自体は失敗しても継続できるよう、保存用と返却用を分ける
    this.chains.set(nickname, next.catch(() => {}));
    return next;
  }

  async saveAll(allPlayers) {
    if (!allPlayers) return;
    await Promise.all(Object.entries(allPlayers).map(([n, r]) => this.savePlayer(n, r)));
  }

  async close() {
    await Promise.all([...this.chains.values()]); // 書き込みキューの完了を待つ
    await this.pool.end();
  }
}

/* ---------------- ファクトリ ---------------- */
// env.DATABASE_URL があれば PostgreSQL、なければファイル保存。
// opts.dataFile はファイル保存時の保存先（DATA_DIR/players.json）。
function createStore(env = process.env, opts = {}) {
  if (detectBackend(env) === 'postgres') return new PgStore(env.DATABASE_URL);
  return new FileStore(opts.dataFile || path.join(__dirname, 'data', 'players.json'));
}

module.exports = { createStore, detectBackend, parseDatabaseUrl, FileStore, PgStore };
