'use strict';
/* 唤醒电平实测：分别对着两个设备各说一句「贾维斯，现在几点了」
 * 目的不是"录到没有"，而是看"说话时的 rms dBFS 够不够 -30"。
 * 昨天的教训：peak 会骗人，只有 rms 反映模型实际听到的能量。 */
const path = require('path');
const fs = require('fs');
const M = require(path.join('D:', 'jarvis', 'src', 'mic_record.js'));
const readline = require('readline');

function level(p) {
  const b = fs.readFileSync(p);
  let peak = 0, sum = 0, n = 0;
  for (let i = 44; i + 1 < b.length; i += 2) {
    const a = Math.abs(b.readInt16LE(i)); if (a > peak) peak = a; sum += a * a; n++;
  }
  const rms = Math.sqrt(sum / n);
  return { peak, rms: Math.round(rms), dbfs: Number((20 * Math.log10(rms / 32767)).toFixed(1)) };
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

(async () => {
  console.log('\n═══════ 唤醒电平实测 ═══════');
  console.log('这个测试帮贾维斯判断：你的麦克风说话时能不能达到识别所需的电平。');
  console.log('它需要你对着每个设备各说一句「贾维斯，现在几点了」。\n');

  const ds = M.listDevices();
  const results = [];
  for (const d of (ds.devices || [])) {
    console.log('── 设备 ' + d.index + '：' + d.name + ' ──');
    await ask('  准备好后按回车，然后【正常音量】说「贾维斯，现在几点了」...');
    const r = await M.record({ device: d.index, maxMs: 6000, silenceMs: 1500 });
    if (!r.ok) { console.log('  ✗ 录音失败：' + r.error); results.push({ dev: d.index, err: r.error }); continue; }
    const lv = level(r.path);
    const ok = lv.dbfs >= -30;
    const weak = lv.dbfs >= -45 && lv.dbfs < -30;
    console.log('  peak=' + lv.peak + '  rms=' + lv.rms + '  ' + lv.dbfs + ' dBFS  '
      + (ok ? '✓ 电平足够，能识别' : weak ? '⚠ 偏弱，识别不稳' : '✗ 电平过低，识别必然为空'));
    console.log('  sawSpeech=' + r.sawSpeech + '  threshold=' + r.threshold);
    results.push({ dev: d.index, name: d.name, ...lv, sawSpeech: r.sawSpeech });
  }

  console.log('\n═══════ 结论 ═══════');
  for (const r of results) {
    if (r.err) { console.log('  设备' + r.dev + '：录音失败 ' + r.err); continue; }
    console.log('  设备' + r.dev + '（' + r.name + '）：' + r.dbfs + ' dBFS'
      + (r.dbfs >= -30 ? '  ✓ 可用' : r.dbfs >= -45 ? '  ⚠ 勉强' : '  ✗ 不可用'));
  }
  const best = results.filter(r => r.dbfs != null).sort((a, b) => b.dbfs - a.dbfs)[0];
  if (best) {
    console.log('\n  电平最好的是设备 ' + best.dev + '（' + best.dbfs + ' dBFS）');
    if (best.dbfs < -30) {
      console.log('  → 即使最好的设备也低于 -30 dBFS，这就是「呼叫贾维斯没反应」的根因。');
      console.log('  → 修法不是改代码，而是：把嘴凑近麦克风、调高系统输入音量、或换设备。');
    } else {
      console.log('  → 电平够用。如果还是唤醒不了，问题在别处（唤醒词匹配 / 触发逻辑），');
      console.log('    把这个结果发给我，我接着往下查。');
    }
  }
  fs.writeFileSync(path.join('D:', 'jarvis', 'sandbox', '_wakelevel.txt'),
    results.map(r => JSON.stringify(r)).join('\n'));
  M.cleanup(0);
  rl.close();
  process.exit(0);
})().catch(e => { console.log('FATAL ' + e.stack); rl.close(); process.exit(1); });
