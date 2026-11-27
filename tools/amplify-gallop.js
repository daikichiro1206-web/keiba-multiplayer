/* Bay Horse の Gallop クリップの脚の振りを広げる加工ツール
 *
 * 背景（実測）: 付属の Gallop クリップは「集めたキャンター」寄りで、接地中の
 * 蹄の後方速度＝滑らずに走れる対地速度が約 8.7m/s（歩幅 4.37m）しかない。
 * レース速度（約17m/s）では脚の接地が地面に追いつかず、蹄が前に滑って
 * 「歩いているのに高速移動」して見える。そこで脚骨（Upper/Lower/Cannon/Hoof）
 * の回転キーを「周期平均姿勢からの偏差 ×AMP」に増幅し、蹄の前後スイープと
 * 接地速度を広げる。形状（メッシュ/スキン）には一切触れない。
 *
 * 使い方（冪等ではないので、必ず未加工の原本から生成すること。原本は
 * git 履歴にある）:
 *   git show <原本コミット>:public/assets/bay-horse.glb > /tmp/bay-orig.glb
 *   node tools/amplify-gallop.js /tmp/bay-orig.glb public/assets/bay-horse.glb
 *
 * 加工後の実測（AMP=1.3）: 滑らない速度 8.7→10.8m/s、歩幅 4.37→5.40m、
 * 浮遊期 33%→48%、蹄の最低高は +0.02m 程度の変化に収まる。
 *
 * フェーズ15で AMP=1.5 に再調整（実機で「足の動きと速度が比例しない」との
 * 指摘。ケイデンス過多の抑制が目的）。別推定法（接地判定22%閾値FK実測）では
 * 歩幅 4.74→5.43m、浮遊期 34%→37%。AMP=1.7以上は蹄の最低高が +0.15m 超
 * 上がり（脚が地面に届かない浮き）と脚の持ち上がり過多が目立つため不採用。
 * あわせてクライアントの歩幅カーブ（strideLenOf）を実馬の速度→歩幅に寄せ、
 * 滑りとケイデンスの配分を取り直した。
 */
const fs = require('fs');

const AMP = 1.5;
const LEG = /^(Front|Hind)_(Upper|Lower|Cannon|Hoof)_[LR]$/;
const [srcPath, dstPath] = process.argv.slice(2);
if (!srcPath || !dstPath) { console.error('usage: node tools/amplify-gallop.js <src.glb> <dst.glb>'); process.exit(1); }

const buf = fs.readFileSync(srcPath);
if (buf.toString('ascii', 0, 4) !== 'glTF') { console.error('not a GLB'); process.exit(1); }
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
const binChunkOff = 20 + jsonLen;
const binLen = buf.readUInt32LE(binChunkOff);
const binOff = binChunkOff + 8;
const out = Buffer.from(buf); // 出力はコピーへ書き込む（JSON・長さは不変）

function accView(idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const ncomp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const compBytes = { 5126: 4, 5123: 2, 5125: 4, 5121: 1, 5122: 2 }[acc.componentType];
  const stride = bv.byteStride || compBytes * ncomp;
  const start = binOff + (bv.byteOffset || 0) + (acc.byteOffset || 0);
  return { acc, ncomp, compBytes, stride, start };
}
function readKeys(idx) {
  const { acc, ncomp, stride, start } = accView(idx);
  const keys = [];
  for (let i = 0; i < acc.count; i++) {
    const o = start + i * stride;
    keys.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8), buf.readFloatLE(o + 12)]);
    if (ncomp !== 4) throw new Error('rotation accessor is not VEC4');
  }
  return keys;
}
function writeKeys(idx, keys) {
  const { stride, start } = accView(idx);
  keys.forEach((q, i) => {
    const o = start + i * stride;
    out.writeFloatLE(q[0], o); out.writeFloatLE(q[1], o + 4); out.writeFloatLE(q[2], o + 8); out.writeFloatLE(q[3], o + 12);
  });
}
function qSlerp(a, b, t) {
  let d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
  let bb = b; if (d < 0) { bb = b.map(v => -v); d = -d; }
  if (d > 0.9995) { const r = a.map((v, i) => v + (bb[i]-v)*t); const n = Math.hypot(...r); return r.map(v => v/n); }
  const th = Math.acos(Math.min(1, d)), s = Math.sin(th);
  return a.map((v, i) => (Math.sin((1-t)*th)*v + Math.sin(t*th)*bb[i]) / s);
}

const gallop = json.animations.find(a => a.name === 'Gallop');
if (!gallop) { console.error('Gallop clip not found'); process.exit(1); }
let touched = 0;
for (const ch of gallop.channels) {
  if (ch.target.path !== 'rotation') continue;
  const nodeName = json.nodes[ch.target.node].name;
  if (!LEG.test(nodeName)) continue;
  const smp = gallop.samplers[ch.sampler];
  const keys = readKeys(smp.output);
  // 周期平均（符号を揃えた単純平均→正規化）からの偏差を AMP 倍
  let mean = [0, 0, 0, 0];
  const ref = keys[0];
  keys.forEach(q => {
    const s = (q[0]*ref[0] + q[1]*ref[1] + q[2]*ref[2] + q[3]*ref[3]) < 0 ? -1 : 1;
    for (let c = 0; c < 4; c++) mean[c] += q[c] * s;
  });
  const mn = Math.hypot(...mean); mean = mean.map(v => v / mn);
  writeKeys(smp.output, keys.map(q => qSlerp(mean, q, AMP)));
  touched++;
}
console.log(`amplified ${touched} leg rotation tracks (AMP=${AMP})`);
fs.writeFileSync(dstPath, out);
console.log(`wrote ${dstPath} (${out.length} bytes, size unchanged: ${out.length === buf.length})`);
