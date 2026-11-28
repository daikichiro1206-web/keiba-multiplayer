'use strict';
/*
 * 馬カタログ＋ゲーム経済の定数・計算 — 1人用（ts-spaces フルスタック版）の
 * server/src/catalog.ts と client/src/horses.ts / keiba-engine.js の DEFS を
 * 正として移植したもの。数値・文言は1人用と同一。
 * 馬データは1人用 DEFS（実在の名馬50頭）から生成している。
 */
const HORSES = [
 {
  "id": "deep",
  "num": 1,
  "name": "ディープインパクト",
  "short": "ディープ",
  "style": "追込",
  "styleKey": "oikomi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 94,
  "base": 16.92,
  "price": 4500,
  "heavy": 0.97,
  "coat": 6240798,
  "mane": 1642504,
  "jock": 13214247,
  "helm": 1866298,
  "trait": "最後方からでも届く、伝説の末脚",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "orfevre",
  "num": 2,
  "name": "オルフェーヴル",
  "short": "オルフェ",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 93,
  "base": 16.9,
  "price": 4000,
  "heavy": 1.06,
  "coat": 10115622,
  "mane": 13348998,
  "jock": 11546660,
  "helm": 11546660,
  "trait": "三冠馬。パワー満点で重馬場も平気",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "kitasan",
  "num": 3,
  "name": "キタサンブラック",
  "short": "キタサン",
  "style": "逃げ",
  "styleKey": "nige",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 91,
  "base": 16.86,
  "price": 0,
  "heavy": 1.04,
  "coat": 3351062,
  "mane": 919557,
  "jock": 2764598,
  "helm": 15263976,
  "trait": "逃げて粘るスタミナお化け",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "almond",
  "num": 4,
  "name": "アーモンドアイ",
  "short": "アーモンド",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 95,
  "base": 16.95,
  "price": 5000,
  "heavy": 0.99,
  "coat": 7225120,
  "mane": 1313542,
  "jock": 2902642,
  "helm": 11546660,
  "trait": "牝馬三冠＋G1・9勝の女王。万能型",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "equinox",
  "num": 5,
  "name": "イクイノックス",
  "short": "イクイノックス",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 96,
  "base": 17,
  "price": 5000,
  "heavy": 1,
  "coat": 4205080,
  "mane": 853764,
  "jock": 2902642,
  "helm": 10470621,
  "trait": "世界ランキング1位に輝いた怪物",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "contrail",
  "num": 6,
  "name": "コントレイル",
  "short": "コントレイル",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 93,
  "base": 16.9,
  "price": 4000,
  "heavy": 0.98,
  "coat": 4992794,
  "mane": 1050885,
  "jock": 2774440,
  "helm": 2774440,
  "trait": "無敗の三冠馬。切れる末脚が自慢",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "liberty",
  "num": 7,
  "name": "リバティアイランド",
  "short": "リバティ",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   1,
   2,
   1
  ],
  "rating": 90,
  "base": 16.88,
  "price": 0,
  "heavy": 0.96,
  "coat": 6502685,
  "mane": 1379333,
  "jock": 11546660,
  "helm": 13214247,
  "trait": "牝馬三冠の快速娘。軽い馬場が得意",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "sodashi",
  "num": 8,
  "name": "ソダシ",
  "short": "ソダシ",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   1,
   2,
   0
  ],
  "rating": 87,
  "base": 16.74,
  "price": 0,
  "heavy": 0.95,
  "coat": 15328730,
  "mane": 14670024,
  "jock": 13724306,
  "helm": 15921906,
  "trait": "純白のアイドルホース。先行して粘る",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "suzuka",
  "num": 9,
  "name": "サイレンススズカ",
  "short": "スズカ",
  "style": "逃げ",
  "styleKey": "nige",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 91,
  "base": 16.97,
  "price": 2500,
  "heavy": 1,
  "coat": 7029795,
  "mane": 1313542,
  "jock": 3042100,
  "helm": 3042100,
  "trait": "伝説の大逃げ。静かなる逃亡者",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "teio",
  "num": 10,
  "name": "トウカイテイオー",
  "short": "テイオー",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 90,
  "base": 16.91,
  "price": 1500,
  "heavy": 0.99,
  "coat": 5911576,
  "mane": 1181957,
  "jock": 8014476,
  "helm": 15263976,
  "trait": "帝王。奇跡の復活を果たした名馬",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "mcqueen",
  "num": 11,
  "name": "メジロマックイーン",
  "short": "マックイーン",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   0,
   2
  ],
  "rating": 88,
  "base": 16.83,
  "price": 0,
  "heavy": 1.03,
  "coat": 11775650,
  "mane": 9407102,
  "jock": 3363435,
  "helm": 3363435,
  "trait": "芦毛のステイヤー。品のある走り",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "narita",
  "num": 12,
  "name": "ナリタブライアン",
  "short": "ブライアン",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 90,
  "base": 16.89,
  "price": 1500,
  "heavy": 1.02,
  "coat": 3942166,
  "mane": 919557,
  "jock": 9187110,
  "helm": 2236962,
  "trait": "シャドーロールをつけた三冠馬",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "vodka",
  "num": 13,
  "name": "ウオッカ",
  "short": "ウオッカ",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 89,
  "base": 16.9,
  "price": 0,
  "heavy": 0.98,
  "coat": 5845787,
  "mane": 1181958,
  "jock": 13214247,
  "helm": 5845787,
  "trait": "牝馬でダービーを制した女王",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "gentil",
  "num": 14,
  "name": "ジェンティルドンナ",
  "short": "ジェンティル",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 91,
  "base": 16.91,
  "price": 0,
  "heavy": 1.01,
  "coat": 5123610,
  "mane": 1050885,
  "jock": 9187110,
  "helm": 15921906,
  "trait": "牝馬三冠＋ジャパンC連覇の貴婦人",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "elcondor",
  "num": 15,
  "name": "エルコンドルパサー",
  "short": "コンドル",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 90,
  "base": 16.93,
  "price": 1500,
  "heavy": 1,
  "coat": 3351578,
  "mane": 853764,
  "jock": 3042100,
  "helm": 13214247,
  "trait": "海外遠征で世界に挑んだ怪鳥",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "rudolf",
  "num": 16,
  "name": "シンボリルドルフ",
  "short": "ルドルフ",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 92,
  "base": 16.89,
  "price": 3500,
  "heavy": 1.01,
  "coat": 5518109,
  "mane": 1116422,
  "jock": 3363435,
  "helm": 11546660,
  "trait": "皇帝。無敗で三冠を制した絶対王者",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "duramente",
  "num": 17,
  "name": "ドゥラメンテ",
  "short": "ドゥラメンテ",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 89,
  "base": 16.88,
  "price": 0,
  "heavy": 0.99,
  "coat": 4664343,
  "mane": 985093,
  "jock": 2902642,
  "helm": 2902642,
  "trait": "鋭い末脚の二冠馬",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "chrono",
  "num": 18,
  "name": "クロノジェネシス",
  "short": "クロノ",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 89,
  "base": 16.87,
  "price": 800,
  "heavy": 1.05,
  "coat": 10327692,
  "mane": 8288364,
  "jock": 9187110,
  "helm": 15263976,
  "trait": "芦毛の女王。グランプリ3連覇",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "oguri",
  "num": 19,
  "name": "オグリキャップ",
  "short": "オグリ",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 92,
  "base": 16.9,
  "price": 3500,
  "heavy": 1.02,
  "coat": 11117722,
  "mane": 9078138,
  "jock": 3046714,
  "helm": 15921906,
  "trait": "笠松から来た芦毛の怪物。国民的アイドルホース",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "goldship",
  "num": 20,
  "name": "ゴールドシップ",
  "short": "ゴルシ",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 90,
  "base": 16.88,
  "price": 1500,
  "heavy": 1.05,
  "coat": 11907236,
  "mane": 9999242,
  "jock": 11546660,
  "helm": 2236962,
  "trait": "芦毛の個性派。気まぐれだけど決めると強い",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "kizuna",
  "num": 21,
  "name": "キズナ",
  "short": "キズナ",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 89,
  "base": 16.87,
  "price": 800,
  "heavy": 0.99,
  "coat": 2759697,
  "mane": 853764,
  "jock": 2774440,
  "helm": 15921906,
  "trait": "ダービー馬。鋭い末脚で差し切る",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "do-deuce",
  "num": 22,
  "name": "ドウデュース",
  "short": "ドウデュース",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 93,
  "base": 16.92,
  "price": 4000,
  "heavy": 0.98,
  "coat": 5518109,
  "mane": 1116422,
  "jock": 3363435,
  "helm": 13214247,
  "trait": "ダービーと有馬記念を制した王者の末脚",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "titleholder",
  "num": 23,
  "name": "タイトルホルダー",
  "short": "タイトル",
  "style": "逃げ",
  "styleKey": "nige",
  "apt": [
   0,
   0,
   2
  ],
  "rating": 90,
  "base": 16.89,
  "price": 1500,
  "heavy": 1.01,
  "coat": 5123610,
  "mane": 1050885,
  "jock": 13214247,
  "helm": 2236962,
  "trait": "長距離の逃げ馬。粘り腰は本物",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "pansalassa",
  "num": 24,
  "name": "パンサラッサ",
  "short": "パンサラッサ",
  "style": "逃げ",
  "styleKey": "nige",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 89,
  "base": 16.9,
  "price": 800,
  "heavy": 0.97,
  "coat": 6240798,
  "mane": 1313542,
  "jock": 2902642,
  "helm": 15263976,
  "trait": "大逃げで世界を沸かせた快速馬",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "bourbon",
  "num": 25,
  "name": "ミホノブルボン",
  "short": "ブルボン",
  "style": "逃げ",
  "styleKey": "nige",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 89,
  "base": 16.88,
  "price": 800,
  "heavy": 1,
  "coat": 9064226,
  "mane": 12884574,
  "jock": 8014476,
  "helm": 8014476,
  "trait": "坂路の申し子。逃げて強い二冠馬",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "operao",
  "num": 26,
  "name": "テイエムオペラオー",
  "short": "オペラオー",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 92,
  "base": 16.91,
  "price": 3500,
  "heavy": 1.02,
  "coat": 9855018,
  "mane": 7226656,
  "jock": 11546660,
  "helm": 15908888,
  "trait": "世紀末覇王。G1・7勝の栗毛の実力馬",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "staygold",
  "num": 27,
  "name": "ステイゴールド",
  "short": "ステゴ",
  "style": "追込",
  "styleKey": "oikomi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 88,
  "base": 16.84,
  "price": 300,
  "heavy": 1.03,
  "coat": 2365970,
  "mane": 722435,
  "jock": 3042100,
  "helm": 3042100,
  "trait": "最後方から突っ込む銀色の末脚",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "hishiamazon",
  "num": 28,
  "name": "ヒシアマゾン",
  "short": "アマゾン",
  "style": "追込",
  "styleKey": "oikomi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 88,
  "base": 16.83,
  "price": 500,
  "heavy": 1,
  "coat": 2891798,
  "mane": 919557,
  "jock": 13724306,
  "helm": 2236962,
  "trait": "最後方から一気に突っ込んでくる女傑",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "sweep",
  "num": 29,
  "name": "スイープトウショウ",
  "short": "スイープ",
  "style": "追込",
  "styleKey": "oikomi",
  "apt": [
   1,
   2,
   1
  ],
  "rating": 88,
  "base": 16.85,
  "price": 500,
  "heavy": 0.98,
  "coat": 4860950,
  "mane": 985093,
  "jock": 14711588,
  "helm": 15921906,
  "trait": "直線一気の末脚が自慢の快速牝馬",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "buena",
  "num": 30,
  "name": "ブエナビスタ",
  "short": "ブエナ",
  "style": "追込",
  "styleKey": "oikomi",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 90,
  "base": 16.9,
  "price": 0,
  "heavy": 0.99,
  "coat": 3022869,
  "mane": 853764,
  "jock": 9187110,
  "helm": 10470621,
  "trait": "女王の末脚。G1・6勝の実力派",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "croix",
  "num": 31,
  "name": "クロワデュノール",
  "short": "クロワ",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 93,
  "base": 16.92,
  "price": 4000,
  "heavy": 1,
  "coat": 4860950,
  "mane": 985093,
  "jock": 1842210,
  "helm": 11546660,
  "trait": "キタサンブラック産駒。ホープフルSとダービーを制した世代の王者",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "shinzan",
  "num": 32,
  "name": "シンザン",
  "short": "シンザン",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 92,
  "base": 16.9,
  "price": 3500,
  "heavy": 1.01,
  "coat": 5518109,
  "mane": 1116422,
  "jock": 3042100,
  "helm": 15921906,
  "trait": "「神馬」と呼ばれた五冠馬。シンザン記念に名を残す",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "specialweek",
  "num": 33,
  "name": "スペシャルウィーク",
  "short": "スペシャル",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 91,
  "base": 16.91,
  "price": 2500,
  "heavy": 1,
  "coat": 2759697,
  "mane": 853764,
  "jock": 2381478,
  "helm": 2381478,
  "trait": "ダービーと天皇賞（秋）を制した黒鹿毛の差し馬",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "grasswonder",
  "num": 34,
  "name": "グラスワンダー",
  "short": "グラス",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 90,
  "base": 16.89,
  "price": 1500,
  "heavy": 0.99,
  "coat": 9855018,
  "mane": 7226656,
  "jock": 11546660,
  "helm": 15908888,
  "trait": "有馬記念連覇の栗毛。海外血統の快速馬",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "airgroove",
  "num": 35,
  "name": "エアグルーヴ",
  "short": "グルーヴ",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 89,
  "base": 16.88,
  "price": 800,
  "heavy": 0.99,
  "coat": 5911576,
  "mane": 1181957,
  "jock": 8014476,
  "helm": 15263976,
  "trait": "天皇賞（秋）を制した女傑。エアの冠名の女王",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "tamamocross",
  "num": 36,
  "name": "タマモクロス",
  "short": "タマモ",
  "style": "追込",
  "styleKey": "oikomi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 89,
  "base": 16.87,
  "price": 800,
  "heavy": 1.04,
  "coat": 11117722,
  "mane": 9078138,
  "jock": 14711588,
  "helm": 2236962,
  "trait": "芦毛の怪物第二章。天皇賞春秋と宝塚を制覇",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "supercreek",
  "num": 37,
  "name": "スーパークリーク",
  "short": "クリーク",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   0,
   2
  ],
  "rating": 89,
  "base": 16.86,
  "price": 800,
  "heavy": 1.02,
  "coat": 5123610,
  "mane": 1050885,
  "jock": 3363435,
  "helm": 11546660,
  "trait": "菊花賞と天皇賞（春）のステイヤー。武豊の相棒",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "maruzensky",
  "num": 38,
  "name": "マルゼンスキー",
  "short": "マルゼン",
  "style": "逃げ",
  "styleKey": "nige",
  "apt": [
   2,
   2,
   1
  ],
  "rating": 90,
  "base": 16.93,
  "price": 1500,
  "heavy": 0.98,
  "coat": 10115622,
  "mane": 13348998,
  "jock": 2902642,
  "helm": 15921906,
  "trait": "無敗のまま引退した栗毛のスピード王",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "twinturbo",
  "num": 39,
  "name": "ツインターボ",
  "short": "ターボ",
  "style": "逃げ",
  "styleKey": "nige",
  "apt": [
   1,
   2,
   1
  ],
  "rating": 87,
  "base": 16.9,
  "price": 300,
  "heavy": 0.97,
  "coat": 6502685,
  "mane": 1379333,
  "jock": 13214247,
  "helm": 1866298,
  "trait": "大逃げ一筋。七夕賞とオールカマーの逃げ切りで有名",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "haiseiko",
  "num": 40,
  "name": "ハイセイコー",
  "short": "セイコー",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 88,
  "base": 16.85,
  "price": 500,
  "heavy": 1,
  "coat": 7029795,
  "mane": 1313542,
  "jock": 9187110,
  "helm": 9187110,
  "trait": "国民的アイドルホース。ハイセイコーブームを巻き起こした",
  "era": "1990年代以前",
  "eraKey": "pre90"
 },
 {
  "id": "daiwamajor",
  "num": 41,
  "name": "ダイワメジャー",
  "short": "メジャー",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   2,
   2,
   1
  ],
  "rating": 90,
  "base": 16.9,
  "price": 1500,
  "heavy": 1,
  "coat": 9064226,
  "mane": 6173712,
  "jock": 2381478,
  "helm": 15263976,
  "trait": "マイル王。皐月賞とマイルCSなどG1・5勝",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "heartscry",
  "num": 42,
  "name": "ハーツクライ",
  "short": "ハーツ",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 90,
  "base": 16.89,
  "price": 1500,
  "heavy": 1.01,
  "coat": 4205080,
  "mane": 853764,
  "jock": 13724306,
  "helm": 2236962,
  "trait": "有馬記念でディープインパクトに土をつけた実力馬",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "daiwascarlet",
  "num": 43,
  "name": "ダイワスカーレット",
  "short": "スカーレット",
  "style": "逃げ",
  "styleKey": "nige",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 91,
  "base": 16.91,
  "price": 2500,
  "heavy": 1,
  "coat": 10508836,
  "mane": 8012312,
  "jock": 11546660,
  "helm": 11546660,
  "trait": "牝馬で有馬記念2着の栗毛。逃げて強い女王",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "manhattan",
  "num": 44,
  "name": "マンハッタンカフェ",
  "short": "カフェ",
  "style": "追込",
  "styleKey": "oikomi",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 90,
  "base": 16.88,
  "price": 1500,
  "heavy": 1.03,
  "coat": 2365970,
  "mane": 722435,
  "jock": 2764598,
  "helm": 13214247,
  "trait": "長距離G1を3勝した青鹿毛のステイヤー",
  "era": "2000年代",
  "eraKey": "y00"
 },
 {
  "id": "lordkanaloa",
  "num": 45,
  "name": "ロードカナロア",
  "short": "カナロア",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   2,
   1,
   0
  ],
  "rating": 91,
  "base": 16.94,
  "price": 2500,
  "heavy": 0.99,
  "coat": 6240798,
  "mane": 1642504,
  "jock": 3042100,
  "helm": 15908888,
  "trait": "短距離王。スプリンターズSと香港スプリント連覇",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "maurice",
  "num": 46,
  "name": "モーリス",
  "short": "モーリス",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 92,
  "base": 16.92,
  "price": 3500,
  "heavy": 1.01,
  "coat": 4992794,
  "mane": 1050885,
  "jock": 15263976,
  "helm": 11546660,
  "trait": "「最強のマイラー」。国内外でG1・6勝",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "lysgracieux",
  "num": 47,
  "name": "リスグラシュー",
  "short": "リス",
  "style": "差し",
  "styleKey": "sashi",
  "apt": [
   0,
   2,
   2
  ],
  "rating": 91,
  "base": 16.9,
  "price": 2500,
  "heavy": 1.02,
  "coat": 3022869,
  "mane": 853764,
  "jock": 8014476,
  "helm": 15921906,
  "trait": "宝塚・有馬に海外G1も制した黒鹿毛の女王",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "saturnalia",
  "num": 48,
  "name": "サートゥルナーリア",
  "short": "サートゥル",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   2,
   2
  ],
  "rating": 90,
  "base": 16.89,
  "price": 1500,
  "heavy": 0.98,
  "coat": 3351062,
  "mane": 919557,
  "jock": 1842210,
  "helm": 10470621,
  "trait": "皐月賞とホープフルSの二冠。切れる末脚の黒鹿毛",
  "era": "2010年代",
  "eraKey": "y10"
 },
 {
  "id": "efforia",
  "num": 49,
  "name": "エフフォーリア",
  "short": "エフフォ",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   0,
   1,
   2
  ],
  "rating": 92,
  "base": 16.91,
  "price": 3500,
  "heavy": 1,
  "coat": 5845787,
  "mane": 1181958,
  "jock": 2774440,
  "helm": 15263976,
  "trait": "皐月賞・天皇賞（秋）・有馬記念の三冠級実力馬",
  "era": "2020年代",
  "eraKey": "y20"
 },
 {
  "id": "foreveryoung",
  "num": 50,
  "name": "フォーエバーヤング",
  "short": "フォーエバー",
  "style": "先行",
  "styleKey": "senko",
  "apt": [
   1,
   2,
   2
  ],
  "rating": 93,
  "base": 16.93,
  "price": 4000,
  "heavy": 1,
  "coat": 5518109,
  "mane": 1116422,
  "jock": 15921906,
  "helm": 1866298,
  "trait": "ダートで世界に挑む若き王者。サウジカップを制覇",
  "era": "2020年代",
  "eraKey": "y20"
 }
];
const horseById = id => HORSES.find(h => h.id === id);
const horseByName = name => HORSES.find(h => h.name === name);
const FIELD_SIZE = 18;
const STARTER_IDS = HORSES.filter(h => h.price === 0).map(h => h.id);
/* 初期解放（price=0）の構成（フェーズ22で4頭→8頭に強化）:
   逃げ: キタサンブラック(91) / 先行: ソダシ(87)・メジロマックイーン(88)・ジェンティルドンナ(91)
   差し: ウオッカ(89)・ドゥラメンテ(89)・リバティアイランド(90) / 追込: ブエナビスタ(90)
   全脚質を最低1頭カバーし、レーティング90以上を4頭含む（従来は87〜89のみで
   「初期馬が弱すぎる」との指摘）。残り42頭は従来どおり解放で集める。 */
/* 初期所持金（フェーズ22: 「初期馬が弱すぎる・手持ち1万Gくらいあってもいい」を受けて
   1,000G→10,000G。最上位の解放価格5,000Gでも序盤に1〜2頭は解放でき、
   初期解放8頭と合わせて序盤から戦える額。新規登録のみに適用され、
   既存プレイヤーの残高は変更しない） */
const INITIAL_BALANCE = 10000;

/* レース名・グレード（1人用 horses.ts RACE_INFO / rollGrade と同一） */
const RACE_INFO = {
  1000: { name: '疾風スプリント', category: '短距離' },
  1500: { name: 'マイルグランプリ', category: 'マイル' },
  2000: { name: '中距離チャンピオンシップ', category: '中距離' },
};
const DISTANCES = [1000, 1500, 2000];
const G1_PRIZE_MULT = 2;
const G1_PAYOUT_MULT = 1.5;
function rollGrade() { return Math.random() < 0.25 ? 'g1' : 'normal'; }

/* 騎手賞金: 1500m基準 [1000,500,300,200,100]、距離倍率、G1は2倍（1人用と同一） */
const DIST_PRIZE_MULT = { 1000: 0.7, 1500: 1, 2000: 1.5 };
function prizeForRank(rank, grade = 'normal', distance = 1500) {
  const base = [1000, 500, 300, 200, 100][rank - 1] || 0;
  const distMult = DIST_PRIZE_MULT[distance] != null ? DIST_PRIZE_MULT[distance] : 1;
  return Math.round(base * distMult * (grade === 'g1' ? G1_PRIZE_MULT : 1));
}

/* 馬場状態（1人用 keiba-engine.js GOING_LIST と同一。抽選比率も同じ 55/25/20） */
const GOING_LIST = [
  { id: 'ryo', name: '良馬場', drain: 1.0, speed: 1.0, note: '標準的な馬場。いつもの走りができる。' },
  { id: 'yaya', name: '稍重馬場', drain: 1.18, speed: 0.985, note: '少し力のいる馬場。スタミナ消費がやや増える。' },
  { id: 'ju', name: '重馬場', drain: 1.38, speed: 0.965, note: '力のいる馬場！スタミナ消費が大幅増。パワー型（重◎）の馬が有利、軽い馬（重△）は苦戦。' },
];
function rollGoing() {
  const r = Math.random();
  return r < 0.55 ? GOING_LIST[0] : (r < 0.8 ? GOING_LIST[1] : GOING_LIST[2]);
}

/* ミッション（1人用 catalog.ts MISSIONS と同一） */
const MISSIONS = [
  { id: 'first_win', title: '初勝利', desc: '騎手モードで初めて1着を取る', target: 1, reward: 300, counter: 'jockey_wins' },
  { id: 'wins_5', title: '通算5勝', desc: '騎手モードで通算5回、1着を取る', target: 5, reward: 1000, counter: 'jockey_wins' },
  { id: 'wide_hit', title: 'ワイド的中', desc: '観戦モードでワイドを当てる', target: 1, reward: 300, counter: 'wide_hits' },
  { id: 'trifecta_hit', title: '三連単的中', desc: '観戦モードで三連単を当てる', target: 1, reward: 1000, counter: 'trifecta_hits' },
  { id: 'g1_win', title: 'G1制覇', desc: 'G1レースで勝つ（騎手で1着、または賭け的中）', target: 1, reward: 800, counter: 'g1_wins' },
  { id: 'unlock_3', title: '名馬コレクター', desc: '新しい馬を3頭解放する', target: 3, reward: 500, counter: 'unlocks' },
];
const RELIEF_THRESHOLD = 100;
const RELIEF_AMOUNT = 500;

/* 騎手ランキング（1人用 catalog.ts と同一の架空AI騎手18名・30レース制） */
const AI_JOCKEYS = [
  '鷹野隼人', '桐生直樹', '早瀬健吾', '南雲颯太', '五十嵐陸', '真島航平',
  '小野寺隼', '霧島蓮', '高嶺宗一郎', '朝倉大吾', '榊原悠真', '冬木晴翔',
  '瀬戸海斗', '葉山駆', '椎名彗', '黒瀬丈', '青柳俊介', '間宮涼',
];
const SEASON_RACES = 30;

/* ---------------- オッズ計算（1人用 catalog.ts の移植） ---------------- */
const BET_PICK_COUNT = { win: 1, place: 1, wide: 2, quinella: 2, trio: 3, trifecta: 3 };
const BET_TYPES = [
  { id: 'win', label: '単勝', pickCount: 1, ordered: false, desc: '1着になる馬を当てる', minOdds: 2.0 },
  { id: 'place', label: '複勝', pickCount: 1, ordered: false, desc: '3着以内に入る馬を当てる', minOdds: 1.3 },
  { id: 'wide', label: 'ワイド', pickCount: 2, ordered: false, desc: '選んだ2頭が両方とも3着以内に入れば的中（当たりやすい分、配当は控えめ）', minOdds: 1.4 },
  { id: 'quinella', label: '馬連', pickCount: 2, ordered: false, desc: '1・2着の2頭を順不同で当てる', minOdds: 3.0 },
  { id: 'trio', label: '三連複', pickCount: 3, ordered: false, desc: '1〜3着の3頭を順不同で当てる', minOdds: 5.0 },
  { id: 'trifecta', label: '三連単', pickCount: 3, ordered: true, desc: '1・2・3着を着順どおりに当てる', minOdds: 10.0 },
];
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function toOdds(prob, minOdds) {
  if (prob <= 0) return 999.0;
  const raw = 0.82 / prob;
  const clamped = Math.min(999.0, Math.max(minOdds, raw));
  return Math.floor(clamped * 10) / 10;
}
const oddsCache = new Map();
function computeOdds(field) { // field: CatalogHorse[] （出走順）
  const key = field.map(h => h.name).join(',');
  const hit = oddsCache.get(key);
  if (hit) return hit;
  const w = field.map(h => Math.exp((h.rating - 90) * 0.17 + (h.base - 16.87) * 2.4));
  const rand = mulberry32(20261127);
  const N = 8000;
  const winC = new Array(field.length).fill(0);
  const placeC = new Array(field.length).fill(0);
  const wideC = new Map(), quinC = new Map(), trioC = new Map(), trifC = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (let n = 0; n < N; n++) {
    const rest = field.map((_, i) => i);
    const top = [];
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (const i of rest) sum += w[i];
      let r = rand() * sum;
      let pick = rest[rest.length - 1];
      for (const i of rest) { r -= w[i]; if (r <= 0) { pick = i; break; } }
      top.push(pick);
      rest.splice(rest.indexOf(pick), 1);
    }
    const [a, b, c] = top;
    winC[a]++; for (const i of top) placeC[i]++;
    bump(wideC, [a, b].sort((x, y) => x - y).join('-'));
    bump(wideC, [a, c].sort((x, y) => x - y).join('-'));
    bump(wideC, [b, c].sort((x, y) => x - y).join('-'));
    bump(quinC, [a, b].sort((x, y) => x - y).join('-'));
    bump(trioC, [a, b, c].sort((x, y) => x - y).join('-'));
    bump(trifC, [a, b, c].join('-'));
  }
  const conv = (m, min) => { const o = new Map(); for (const [k, v] of m) o.set(k, toOdds(v / N, min)); return o; };
  const table = {
    win: winC.map(v => toOdds(v / N, 2.0)),
    place: placeC.map(v => toOdds(v / N, 1.3)),
    wide: conv(wideC, 1.4), quinella: conv(quinC, 3.0), trio: conv(trioC, 5.0), trifecta: conv(trifC, 10.0),
  };
  oddsCache.set(key, table);
  return table;
}
function oddsForBet(type, picks, fieldNames) {
  if (!BET_PICK_COUNT[type] || picks.length !== BET_PICK_COUNT[type]) return null;
  if (new Set(picks).size !== picks.length) return null;
  if (fieldNames.length !== FIELD_SIZE || new Set(fieldNames).size !== fieldNames.length) return null;
  const field = [];
  for (const n of fieldNames) { const h = horseByName(n); if (!h) return null; field.push(h); }
  const idx = picks.map(name => fieldNames.indexOf(name));
  if (idx.some(i => i < 0)) return null;
  const t = computeOdds(field);
  const [a, b, c] = idx;
  switch (type) {
    case 'win': return t.win[a];
    case 'place': return t.place[a];
    case 'wide': return t.wide.get([a, b].sort((x, y) => x - y).join('-')) != null ? t.wide.get([a, b].sort((x, y) => x - y).join('-')) : 999.0;
    case 'quinella': return t.quinella.get([a, b].sort((x, y) => x - y).join('-')) != null ? t.quinella.get([a, b].sort((x, y) => x - y).join('-')) : 999.0;
    case 'trio': return t.trio.get([a, b, c].sort((x, y) => x - y).join('-')) != null ? t.trio.get([a, b, c].sort((x, y) => x - y).join('-')) : 999.0;
    case 'trifecta': return t.trifecta.get([a, b, c].join('-')) != null ? t.trifecta.get([a, b, c].join('-')) : 999.0;
  }
  return null;
}
function betWon(type, picks, order) {
  const top2 = order.slice(0, 2), top3 = order.slice(0, 3);
  switch (type) {
    case 'win': return picks[0] === order[0];
    case 'place': return picks[0] !== undefined && top3.includes(picks[0]);
    case 'wide': return picks.length === 2 && picks.every(p => top3.includes(p));
    case 'quinella': return picks.length === 2 && picks.every(p => top2.includes(p));
    case 'trio': return picks.length === 3 && picks.every(p => top3.includes(p));
    case 'trifecta': return picks.length === 3 && picks.every((p, i) => top3[i] === p);
  }
  return false;
}

module.exports = {
  HORSES, horseById, horseByName, FIELD_SIZE, STARTER_IDS, INITIAL_BALANCE,
  RACE_INFO, DISTANCES, G1_PRIZE_MULT, G1_PAYOUT_MULT, rollGrade,
  DIST_PRIZE_MULT, prizeForRank, GOING_LIST, rollGoing,
  MISSIONS, RELIEF_THRESHOLD, RELIEF_AMOUNT, AI_JOCKEYS, SEASON_RACES,
  BET_PICK_COUNT, BET_TYPES, computeOdds, oddsForBet, betWon, mulberry32,
};
