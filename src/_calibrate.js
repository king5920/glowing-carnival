/**
 * 贾维斯主动意识节奏标定 —— 打印警觉度曲线和触发时刻
 * 运行：node src/_calibrate.js
 * 这是标定工具，不是测试。用来肉眼确认节奏是否符合"冷静管家"的预期。
 */
const { createJarvisMind } = require('./jarvis-persona.js');

(async () => {
  const lastMsg = { id: 1, content: 'hi', timestamp: Date.now() };

  console.log('  贾维斯主动意识节奏（用户一直不说话）');
  console.log('  阈值: observation 0.15 | considerContact 0.40 | forceContact 0.75 | prideBlock 0.40');
  console.log('');
  console.log('  时长     警觉   从容   心境   唤醒  沉浸  →  触发');
  console.log('  ' + '-'.repeat(72));

  const marks = [5, 15, 25, 40, 60, 90, 120, 180, 240, 360, 480, 720];
  for (const total of marks) {
    const m = createJarvisMind({ getLastMessage: () => lastMsg, onLog: () => {} });
    let left = total;
    while (left > 0) { const c = Math.min(30, left); await m.tick(c); left -= c; }

    const s = await m.getState();
    const t = await m.checkThresholds();
    const acts = t.map(x => {
      let n = x.action;
      if (x.reason) n += '(' + x.reason + ')';
      if (x.forced) n += '!';
      return n;
    }).join(' + ') || '—';

    const hh = Math.floor(total / 60), mm = total % 60;
    const label = (hh > 0 ? hh + 'h' : '') + (mm > 0 ? mm + 'm' : (hh > 0 ? '' : '0m'));

    console.log('  ' + label.padEnd(7) +
      s.connection.toFixed(3).padStart(6) +
      s.pride.toFixed(3).padStart(7) +
      s.valence.toFixed(3).padStart(7) +
      s.arousal.toFixed(3).padStart(7) +
      s.immersion.toFixed(2).padStart(6) +
      '  →  ' + acts);
  }

  console.log('');
  console.log('  ── 情绪事件响应 ──');
  const ev = createJarvisMind({ getLastMessage: () => lastMsg, onLog: () => {} });
  const show = async (tag) => {
    const s = await ev.getState();
    const mood = await ev.getMoodLabel();
    console.log('  ' + tag.padEnd(16) +
      'v=' + s.valence.toFixed(3).padStart(6) +
      ' a=' + s.arousal.toFixed(3).padStart(6) +
      ' p=' + s.pride.toFixed(3).padStart(6) +
      '  「' + mood + '」');
  };
  await show('初始');
  await ev.praised();        await show('被感谢');
  await ev.scolded();        await show('被骂');
  await ev.userSaid('urgent'); await show('紧急指令');
  let l = 120; while (l > 0) { const c = Math.min(30, l); await ev.tick(c); l -= c; }
  await show('2 小时后');
})();
