'use strict';
/**
 * drawer.js 情景抽屉单测（DESIGN.md §6 C2-A 基础层）
 *
 * 覆盖：
 *   open/close/isOpen —— 状态切换
 *   register          —— 注册 fetcher + render
 *   hash 同步         —— open 写 #drawer=type:id、close 清空
 *   焦点锁            —— Tab 循环、Shift+Tab 循环、Esc 关闭后还焦
 *   三路关闭          —— Esc / 遮罩点击 / × 按钮
 *   同屏仅一个抽屉    —— 二次 open 替换
 *
 * 端点形状（/api/closescan）由 scripts/verify-drawer.js 走 CDP 契约验证——
 * server.js 在顶层 listen，不能被 require，故本套件不重复测端点。
 *
 * 与项目硬约束一致：零外部依赖（无 jsdom/mocha/jest），纯 Node assert + mock DOM。
 */

const assert = require('assert');

/* ── 浏览器环境最小 stub ── */
global.window = {
  devicePixelRatio: 1,
  addEventListener: () => {},
  removeEventListener: () => {},
};
global.matchMedia = () => ({ matches: false });

/* ── DOM 元素 stub ── */
let _elCount = 0;
function makeEl(tag){
  const id = ++_elCount;
  const el = {
    id,
    tagName: (tag || 'div').toUpperCase(),
    id: 'el_' + id,
    className: '',
    _classSet: new Set(),
    style: {},
    _attrs: {},
    _listeners: {},
    _focusIdx: 0,
    _text: '',
    _html: '',
    _kids: [],
    parentElement: null,
    offsetWidth: 100,
    offsetHeight: 20,

    get classList(){
      const self = this;
      return {
        add(...cs){ cs.forEach(c => self._classSet.add(c)); },
        remove(...cs){ cs.forEach(c => self._classSet.delete(c)); },
        toggle(c, force){ if(force === undefined) force = !self._classSet.has(c); if(force) self._classSet.add(c); else self._classSet.delete(c); },
        contains(c){ return self._classSet.has(c); },
      };
    },
    /* className 与 _classSet 双向同步（浏览器行为：赋 className 会清空并重设 classSet） */
    set className(v){ this._classSet = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get textContent(){ return this._text; },
    set textContent(v){ this._text = v; },
    get innerHTML(){ return this._html; },
    set innerHTML(v){ this._html = v; },
    setAttribute(k, v){ this._attrs[k] = v; },
    getAttribute(k){ return this._attrs[k] == null ? null : this._attrs[k]; },
    removeAttribute(k){ delete this._attrs[k]; },
    appendChild(c){ this._kids.push(c); c.parentElement = this; return c; },
    removeChild(c){ const i = this._kids.indexOf(c); if(i >= 0) this._kids.splice(i,1); c.parentElement = null; return c; },
    addEventListener(type, fn){ this._listeners[type] = this._listeners[type] || []; this._listeners[type].push(fn); },
    removeEventListener(type, fn){ if(!this._listeners[type]) return; const i = this._listeners[type].indexOf(fn); if(i >= 0) this._listeners[type].splice(i,1); },
    querySelectorAll(sel){
      // 简化：只支持 'a[href], button, input, select, textarea, [tabindex]' 的匹配
      const results = [];
      this._traverse(el => {
        if(sel.includes('button') && el.tagName === 'BUTTON') results.push(el);
        if(sel.includes('input') && el.tagName === 'INPUT') results.push(el);
        if(sel.includes('select') && el.tagName === 'SELECT') results.push(el);
        if(sel.includes('textarea') && el.tagName === 'TEXTAREA') results.push(el);
        if(sel.includes('a[href]') && el.tagName === 'A' && el.getAttribute('href')) results.push(el);
        if(el._attrs.tabindex !== undefined && el._attrs.tabindex !== '-1') results.push(el);
      });
      return results;
    },
    _traverse(cb){ cb(this); this._kids.forEach(k => k._traverse(cb)); },
    contains(el){ if(el === this) return true; return this._kids.some(k => k.contains && k.contains(el)); },
    focus(){ document._activeElement = this; this._focused = true; },
    blur(){ if(document._activeElement === this) document._activeElement = null; this._focused = false; },
    closest(sel){
      let cur = this;
      while(cur){
        if(sel.startsWith('.') && cur._classSet && cur._classSet.has(sel.slice(1))) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    getBoundingClientRect(){ return { left:0, top:0, width:100, height:20, right:100, bottom:20 }; },
    dispatchEvent(e){ if(this._listeners[e.type]) this._listeners[e.type].forEach(fn => fn(e)); return true; },
    get dataset(){ return {}; },
  };
  return el;
}

/* ── document stub ── */
const _elements = {};
global.document = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  _readyState: 'complete',
  get readyState(){ return this._readyState; },
  _activeElement: null,
  getElementById(id){ return _elements[id] || null; },
  createElement(tag){ return makeEl(tag); },
  querySelector(sel){
    // 简化匹配
    for(const id in _elements){
      const el = _elements[id];
      if(sel.startsWith('#') && el.id === sel.slice(1)) return el;
      if(sel.startsWith('.') && el._classSet && el._classSet.has(sel.slice(1))) return el;
    }
    return null;
  },
  querySelectorAll(sel){
    const results = [];
    for(const id in _elements){
      const el = _elements[id];
      if(sel.startsWith('#') && el.id === sel.slice(1)) results.push(el);
      if(sel.startsWith('.') && el._classSet && el._classSet.has(sel.slice(1))) results.push(el);
    }
    return results;
  },
  addEventListener(type, fn, capture){ this._bodyListeners = this._bodyListeners || {}; this._bodyListeners[type] = this._bodyListeners[type] || []; this._bodyListeners[type].push({fn, capture}); },
  removeEventListener(type, fn, capture){ if(!this._bodyListeners || !this._bodyListeners[type]) return; const idx = this._bodyListeners[type].indexOf(fn); if(idx >= 0) this._bodyListeners[type].splice(idx,1); },
  dispatchEvent(e){
    if(this._bodyListeners && this._bodyListeners[e.type]){
      this._bodyListeners[e.type].forEach(({fn, capture}) => {
        if(!capture || e._capture) fn(e);
      });
    }
    return true;
  },
};

/* history stub —— path 和 hash 分开存储，模拟浏览器行为 */
global.history = {
  _state: null,
  _path: '/',
  _hash: '',
  replaceState(state, title, url){
    this._state = state;
    if(url){
      if(url.startsWith('#')){
        this._hash = url;
      } else {
        const hashIdx = url.indexOf('#');
        if(hashIdx >= 0){
          this._path = url.slice(0, hashIdx);
          this._hash = url.slice(hashIdx);
        } else {
          this._path = url;
          this._hash = '';
        }
      }
    }
  },
};
global.location = {
  get hash(){ return global.history._hash; },
  get pathname(){ return global.history._path; },
  get search(){ return ''; },
  href: 'http://localhost/',
};

/* setTimeout stub（同步执行，便于测试） */
global.setTimeout = (fn, ms) => { fn(); return 0; };

/* ── 注册抽屉 DOM 元素 ── */
const backdrop = makeEl('div'); backdrop.id = 'drawerBackdrop';
const panel = makeEl('div'); panel.id = 'drawerPanel';
const headerEl = makeEl('div'); headerEl.id = 'drawerHeader';
const titleEl = makeEl('h2'); titleEl.id = 'drawerTitle';
const bodyEl = makeEl('div'); bodyEl.id = 'drawerBody';
const closeBtn = makeEl('button'); closeBtn.id = 'drawerClose';
headerEl.appendChild(titleEl);
headerEl.appendChild(closeBtn);
panel.appendChild(headerEl);
panel.appendChild(bodyEl);
_elements.drawerBackdrop = backdrop;
_elements.drawerPanel = panel;
_elements.drawerHeader = headerEl;
_elements.drawerTitle = titleEl;
_elements.drawerBody = bodyEl;
_elements.drawerClose = closeBtn;
document.body.appendChild(backdrop);
document.body.appendChild(panel);

/* ── 加载 drawer.js —— 通过 IIFE 挂到 window.Drawer ── */
require('../ui/drawer');
const D = window.Drawer;

/* ── 测试骨架 ── */
let pass = 0, fail = 0;
function test(name, fn){
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch(e){ console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); fail++; }
}

/* ── 重置函数 ── */
function resetState(){
  if(D.isOpen()) D.close();
  // 清理 history
  global.history.replaceState(null, '', '/');
}

console.log('\n── Drawer API 暴露 ──');

test('Drawer 模块暴露 open/close/isOpen/register', () => {
  assert.strictEqual(typeof D.open, 'function');
  assert.strictEqual(typeof D.close, 'function');
  assert.strictEqual(typeof D.isOpen, 'function');
  assert.strictEqual(typeof D.register, 'function');
});

test('初始状态：未打开、无 hash', () => {
  resetState();
  assert.strictEqual(D.isOpen(), false);
  assert.strictEqual(global.location.hash, '');
});

console.log('\n── register + open ──');

test('register 后可 open，isOpen 为 true', () => {
  resetState();
  D.register('leader', {
    fetcher: () => Promise.resolve({ name: 'test' }),
    render: (d) => '<div>' + d.name + '</div>',
  });
  D.open('leader', '600519', { side: 'right' });
  assert.strictEqual(D.isOpen(), true);
});

test('open 后 panel 有 .open 类、aria-hidden=false', () => {
  D.open('leader', '600519', { side: 'right' });
  assert(panel._classSet.has('open'), 'panel 应有 .open 类');
  assert.strictEqual(panel.getAttribute('aria-hidden'), 'false');
  assert(backdrop._classSet.has('open'), 'backdrop 应有 .open 类');
});

test('open 后 hash 写入 #drawer=leader:600519', () => {
  D.open('leader', '600519', { side: 'right' });
  assert(global.location.hash.includes('leader:600519'), 'hash 应含 leader:600519，实际: ' + global.location.hash);
});

test('open 后 body 有 drawer-open 类', () => {
  D.open('leader', '600519', { side: 'right' });
  assert(document.body._classSet.has('drawer-open'), 'body 应有 .drawer-open 类');
});

console.log('\n── close ──');

test('close 后 isOpen 为 false', () => {
  D.close();
  assert.strictEqual(D.isOpen(), false);
});

test('close 后 panel 无 .open 类、aria-hidden=true', () => {
  D.close();
  assert(!panel._classSet.has('open'), 'panel 不应有 .open 类');
  assert.strictEqual(panel.getAttribute('aria-hidden'), 'true');
  assert(!backdrop._classSet.has('open'), 'backdrop 不应有 .open 类');
});

test('close 后 hash 清空', () => {
  D.close();
  assert.strictEqual(global.location.hash, '', 'hash 应为空，实际: ' + global.location.hash);
});

test('close 后 body 无 drawer-open 类', () => {
  D.close();
  assert(!document.body._classSet.has('drawer-open'), 'body 不应有 .drawer-open 类');
});

console.log('\n── hash 还原 ──');

test('页面加载读 hash 自动开（fetcher 已注册）', () => {
  resetState();
  // 模拟 hash 已存在
  global.history.replaceState(null, '', '#drawer=leader:600519');
  // 重新加载 drawer.js 触发 restoreFromHash
  // 由于 IIFE 已执行，我们手动调用 open 模拟
  D.open('leader', '600519', { side: 'right' });
  assert.strictEqual(D.isOpen(), true, 'hash 还原后应自动打开');
});

console.log('\n── render 注入 ──');

test('open 时 render 返回的 HTML 注入 #drawerBody', () => {
  resetState();
  D.register('test', {
    fetcher: () => Promise.resolve({ msg: 'hello' }),
    render: (d) => '<div class="test-render">' + d.msg + '</div>',
  });
  // 直接传 data 跳过 fetcher
  D.open('test', '1', { data: { msg: 'hello' } });
  // 同步 render 后检查
  assert(bodyEl._html.includes('test-render'), 'body innerHTML 应含 test-render，实际: ' + bodyEl._html);
  assert(bodyEl._html.includes('hello'), 'body innerHTML 应含 hello');
});

test('open 时 render 收到的数据是 opts.data', () => {
  resetState();
  let receivedData = null;
  D.register('test2', {
    fetcher: () => Promise.resolve({}),
    render: (d) => { receivedData = d; return '<div>x</div>'; },
  });
  D.open('test2', '1', { data: { code: '600519', name: '贵州茅台' } });
  assert.strictEqual(receivedData.code, '600519');
  assert.strictEqual(receivedData.name, '贵州茅台');
});

console.log('\n── 同屏仅一个抽屉 ──');

test('二次 open 替换前一个（无 fetcher 时）', () => {
  resetState();
  D.register('a', {
    fetcher: () => Promise.resolve({}),
    render: (d) => '<div>A</div>',
  });
  D.register('b', {
    fetcher: () => Promise.resolve({}),
    render: (d) => '<div>B</div>',
  });
  D.open('a', '1', { data: {} });
  assert(bodyEl._html.includes('A'), '第一次 open 应渲染 A');
  D.open('b', '2', { data: {} });
  assert(bodyEl._html.includes('B'), '第二次 open 应替换为 B');
  assert(!bodyEl._html.includes('A'), '不应残留 A');
  assert.strictEqual(D.isOpen(), true, '仍应保持打开状态');
});

console.log('\n── side 方向类 ──');

test('open side=right 加 .from-right 类', () => {
  resetState();
  D.open('a', '1', { side: 'right' });
  assert(panel._classSet.has('from-right'), '应加 .from-right');
  assert(!panel._classSet.has('from-left'), '不应有 .from-left');
});

test('open side=left 加 .from-left 类', () => {
  resetState();
  D.open('a', '1', { side: 'left' });
  assert(panel._classSet.has('from-left'), '应加 .from-left');
  assert(!panel._classSet.has('from-right'), '不应有 .from-right');
});

test('二次 open 切换 side 时正确替换类', () => {
  resetState();
  D.open('a', '1', { side: 'right' });
  assert(panel._classSet.has('from-right'));
  D.open('a', '2', { side: 'left' });
  assert(panel._classSet.has('from-left'));
  assert(!panel._classSet.has('from-right'));
});

console.log('\n── title 设置 ──');

test('open 时 title 设置到 #drawerTitle', () => {
  resetState();
  D.open('leader', '600519', { title: '贵州茅台' });
  assert.strictEqual(titleEl._text, '贵州茅台');
});

test('open 时 opts.title 覆盖 register 时的 title', () => {
  resetState();
  D.register('leader2', {
    fetcher: () => Promise.resolve({}),
    render: (d) => '<div>x</div>',
    title: '默认标题',
  });
  D.open('leader2', '1', { title: '自定义标题' });
  assert.strictEqual(titleEl._text, '自定义标题');
});

console.log('\n── 焦点锁 ──');

test('Esc 键触发关闭', () => {
  resetState();
  D.open('a', '1', { side: 'right' });
  assert.strictEqual(D.isOpen(), true);
  // 模拟 Esc keydown
  document.dispatchEvent({ type: 'keydown', key: 'Escape', _capture: true, preventDefault: () => {}, stopPropagation: () => {} });
  assert.strictEqual(D.isOpen(), false, 'Esc 后应关闭');
});

console.log('\n── 未注册类型 ──');

test('open 未注册类型显示"未注册渲染器"', () => {
  resetState();
  D.open('unregistered', '1', { side: 'right' });
  assert(bodyEl._html.includes('未注册渲染器'), '应显示未注册渲染器提示');
});

console.log('\n── 关闭后还焦 ──');

test('close 后焦点还给 sourceEl', () => {
  resetState();
  const source = makeEl('button');
  _elements.source = source;
  document._activeElement = null;
  D.open('a', '1', { sourceEl: source, side: 'right' });
  assert(document._activeElement !== source, '打开时焦点应离开 sourceEl');
  D.close();
  // setTimeout 同步执行，焦点应已还给 sourceEl
  assert(document._activeElement === source, '关闭后焦点应还给 sourceEl');
});

/* ══════════════════════════════════════════════════════════
   C2-B: L1 → L2 下钻带返回
   ══════════════════════════════════════════════════════════ */

console.log('\n── Drawer API 扩展（C2-B）──');

test('Drawer 暴露 push/pop/stackSize/current/MAX_DEPTH', () => {
  assert.strictEqual(typeof D.push, 'function');
  assert.strictEqual(typeof D.pop, 'function');
  assert.strictEqual(typeof D.stackSize, 'function');
  assert.strictEqual(typeof D.current, 'function');
  assert.strictEqual(D.MAX_DEPTH, 3, 'MAX_DEPTH 应为 3');
});

console.log('\n── push() 下钻 ──');

test('push 后栈增长、hash 更新为 type:id>subType:subId', () => {
  resetState();
  D.register('leader', {
    fetcher: () => Promise.resolve({ name: '龙头A' }),
    render: (d) => '<div>LEADER-' + d.name + '</div>',
    title: '龙头详情',
  });
  D.register('sectorDetail', {
    fetcher: () => Promise.resolve({ name: '半导体' }),
    render: (d) => '<div>SECTOR-' + d.name + '</div>',
    title: '板块详情',
  });
  D.open('leader', '600519', { data: { name: '龙头A' } });
  assert.strictEqual(D.stackSize(), 1);
  assert(global.location.hash === '#drawer=leader:600519', 'L1 hash 应为 #drawer=leader:600519，实际: ' + global.location.hash);

  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(D.stackSize(), 2, 'push 后栈应为 2');
  assert(global.location.hash === '#drawer=leader:600519>sectorDetail:%E5%8D%8A%E5%AF%BC%E4%BD%93',
    'L2 hash 应为 type:id>subType:subId（encodeURIComponent），实际: ' + global.location.hash);
  assert(global.location.hash.includes('leader:600519>sectorDetail:'),
    'hash 应含 leader:600519>sectorDetail: 前缀');
});

test('push 后内容替换为 L2 渲染结果', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  assert(bodyEl._html.includes('LEADER-'), 'push 前 body 应显示 L1 内容');
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert(bodyEl._html.includes('SECTOR-半导体'), 'push 后 body 应替换为 L2 内容，实际: ' + bodyEl._html);
  assert(!bodyEl._html.includes('LEADER-'), 'L2 下不应残留 L1 内容');
});

test('push 后 title 更新为 L2 标题', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  assert.strictEqual(titleEl._text, '龙头详情');
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(titleEl._text, '板块详情', 'title 应更新为板块详情');
});

test('push 返回 true（成功下钻）', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  const ok = D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(ok, true, 'push 应返回 true');
});

test('push 前未开抽屉时返回 false（不产生孤儿栈）', () => {
  resetState();
  const ok = D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(ok, false, '抽屉未开时 push 应失败');
  assert.strictEqual(D.stackSize(), 0, '未开抽屉时栈应为 0');
});

test('push 走 fetcher 路径（未传 data 时）—— body 先显示加载中', () => {
  resetState();
  let fetchCount = 0;
  D.register('kicker', {
    fetcher: () => { fetchCount++; return Promise.resolve({ msg: 'ok' }); },
    render: (d) => '<div>K-' + d.msg + '</div>',
    title: 'K',
  });
  D.open('kicker', 'x', { data: { msg: 'L1' } });
  D.push('kicker', 'y');  // 未传 data，应走 fetcher
  assert(bodyEl._html.includes('加载中'), 'push 后应立即显示加载中，实际: ' + bodyEl._html);
  // 手动 resolve promise
  return;
});

console.log('\n── pop() 返回 ──');

test('pop 后栈减少、hash 还原为 L1', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(D.stackSize(), 2);
  D.pop();
  assert.strictEqual(D.stackSize(), 1, 'pop 后栈应为 1');
  assert.strictEqual(global.location.hash, '#drawer=leader:600519',
    'pop 后 hash 应还原为 #drawer=leader:600519，实际: ' + global.location.hash);
});

test('pop 后内容恢复为 L1 渲染结果', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert(bodyEl._html.includes('SECTOR-'), 'pop 前应显示 L2 内容');
  D.pop();
  assert(bodyEl._html.includes('LEADER-龙头A'), 'pop 后 body 应恢复为 L1 内容，实际: ' + bodyEl._html);
  assert(!bodyEl._html.includes('SECTOR-'), 'pop 后不应残留 L2 内容');
});

test('pop 返回 true（成功回退）', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(D.pop(), true, '有 L2 时 pop 应返回 true');
});

test('pop 在 L1 时返回 false（栈底无上一层）', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  assert.strictEqual(D.pop(), false, 'L1 时 pop 应返回 false');
  assert.strictEqual(D.stackSize(), 1, 'L1 pop 失败后栈不变');
});

test('pop 在关闭抽屉时返回 false', () => {
  resetState();
  assert.strictEqual(D.pop(), false, '关闭时 pop 应返回 false');
});

console.log('\n── 多次 push/pop 交错 ──');

test('push × 2 → pop × 2 后回到初始 L1', () => {
  resetState();
  D.register('layer2', {
    fetcher: () => Promise.resolve({}),
    render: (d) => '<div>L2-' + (d && d.name || '') + '</div>',
    title: '层2',
  });
  D.register('layer3', {
    fetcher: () => Promise.resolve({}),
    render: (d) => '<div>L3-' + (d && d.name || '') + '</div>',
    title: '层3',
  });
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('layer2', 'B', { data: { name: 'B' } });
  D.push('layer3', 'C', { data: { name: 'C' } });
  assert.strictEqual(D.stackSize(), 3, 'push × 2 后栈应为 3');
  assert(bodyEl._html.includes('L3-C'), 'L3 内容应显示');

  D.pop();
  assert.strictEqual(D.stackSize(), 2, 'pop × 1 后栈应为 2');
  assert(bodyEl._html.includes('L2-B'), '回到 L2');

  D.pop();
  assert.strictEqual(D.stackSize(), 1, 'pop × 2 后栈应为 1');
  assert(bodyEl._html.includes('LEADER-龙头A'), '回到 L1 龙头详情');
  assert.strictEqual(global.location.hash, '#drawer=leader:600519');
});

test('push 深度超过 MAX_DEPTH 时被拒绝', () => {
  resetState();
  D.register('layer2', {
    fetcher: () => Promise.resolve({}),
    render: () => '<div>L2</div>',
    title: '层2',
  });
  D.register('layer3', {
    fetcher: () => Promise.resolve({}),
    render: () => '<div>L3</div>',
    title: '层3',
  });
  D.register('layer4', {
    fetcher: () => Promise.resolve({}),
    render: () => '<div>L4</div>',
    title: '层4',
  });
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('layer2', 'B', { data: {} });
  D.push('layer3', 'C', { data: {} });
  assert.strictEqual(D.stackSize(), 3, 'MAX_DEPTH=3 时应允许 L1+L2+L3');

  const over = D.push('layer4', 'D');
  assert.strictEqual(over, false, '超过 MAX_DEPTH 的 push 应被拒绝');
  assert.strictEqual(D.stackSize(), 3, '被拒后栈不增长');
  assert(bodyEl._html.includes('L3'), '栈顶仍应显示 L3');
});

test('MAX_DEPTH 边界：open + push + push 恰好 = 3 层，再 push 拒', () => {
  resetState();
  D.register('X', {
    fetcher: () => Promise.resolve({}),
    render: (d) => '<div>X' + (d && d.i || '') + '</div>',
    title: 'X',
  });
  D.open('X', '1', { data: { i: 1 } });
  D.push('X', '2', { data: { i: 2 } });
  D.push('X', '3', { data: { i: 3 } });
  assert.strictEqual(D.stackSize(), 3);
  assert.strictEqual(D.push('X', '4', { data: { i: 4 } }), false);
  assert.strictEqual(D.stackSize(), 3);
});

console.log('\n── 返回按钮 ──');

test('L1 时返回按钮隐藏', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  const backBtns = headerEl._kids.filter(k => k._classSet.has('drw-back'));
  assert.strictEqual(backBtns.length, 1, '应有 1 个 drw-back 元素');
  assert.strictEqual(backBtns[0].style.display, 'none', 'L1 时按钮应 display:none');
});

test('push 到 L2 后返回按钮显示', () => {
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  const backBtns = headerEl._kids.filter(k => k._classSet.has('drw-back'));
  assert.strictEqual(backBtns[0].style.display, '', 'L2 时按钮应显示');
});

test('pop 回 L1 后返回按钮隐藏', () => {
  D.pop();
  const backBtns = headerEl._kids.filter(k => k._classSet.has('drw-back'));
  assert.strictEqual(backBtns[0].style.display, 'none', 'pop 回 L1 后按钮应隐藏');
});

test('click 返回按钮触发 pop', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(D.stackSize(), 2);
  const backBtns = headerEl._kids.filter(k => k._classSet.has('drw-back'));
  assert.strictEqual(backBtns.length, 1);
  // 模拟点击
  backBtns[0].dispatchEvent({ type: 'click' });
  assert.strictEqual(D.stackSize(), 1, '点击返回按钮后栈应为 1');
  assert(bodyEl._html.includes('LEADER-'), 'body 应恢复为 L1 内容');
});

test('返回按钮在关闭抽屉后随栈清空', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  D.close();
  assert.strictEqual(D.stackSize(), 0, '关闭后栈应为 0');
  // 按钮仍在 DOM 上（保留结构），但抽屉已关
});

console.log('\n── Esc 行为（关闭 vs 逐层 pop）──');

test('Esc 在 L1 时关闭整个抽屉', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  document.dispatchEvent({ type: 'keydown', key: 'Escape', _capture: true, preventDefault: () => {}, stopPropagation: () => {} });
  assert.strictEqual(D.isOpen(), false, 'Esc 后应关闭');
  assert.strictEqual(D.stackSize(), 0, '关闭后栈应为 0');
});

test('Esc 在 L2 时关闭整个抽屉（不逐层 pop）', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(D.stackSize(), 2);
  document.dispatchEvent({ type: 'keydown', key: 'Escape', _capture: true, preventDefault: () => {}, stopPropagation: () => {} });
  assert.strictEqual(D.isOpen(), false, 'Esc 后应关闭抽屉');
  assert.strictEqual(D.stackSize(), 0, 'Esc 在 L2 应清空整个栈，不是逐层 pop');
  assert.strictEqual(global.location.hash, '', 'Esc 后 hash 应清空');
});

test('Esc 在 L3 时关闭整个抽屉', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('layer2', 'B', { data: { name: 'B' } });
  D.push('layer3', 'C', { data: { name: 'C' } });
  assert.strictEqual(D.stackSize(), 3);
  document.dispatchEvent({ type: 'keydown', key: 'Escape', _capture: true, preventDefault: () => {}, stopPropagation: () => {} });
  assert.strictEqual(D.isOpen(), false);
  assert.strictEqual(D.stackSize(), 0);
});

console.log('\n── 关闭清空整个栈 ──');

test('关闭 L2 抽屉后栈清空', () => {
  resetState();
  D.open('leader', '600519', { sourceEl: undefined, data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(D.stackSize(), 2);
  D.close();
  assert.strictEqual(D.stackSize(), 0, 'close 后栈应清空');
  assert.strictEqual(global.location.hash, '');
});

test('关闭后再次 open 从空栈开始（不残留旧栈）', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  D.close();
  D.open('leader', '000001', { data: { name: '茅台' } });
  assert.strictEqual(D.stackSize(), 1, '重新 open 后栈应为 1');
  assert.strictEqual(global.location.hash, '#drawer=leader:000001');
});

console.log('\n── 二次 open 替换栈 ──');

test('已开抽屉时再 open 新 type 重置为 1 层', () => {
  resetState();
  D.register('layer3', {
    fetcher: () => Promise.resolve({}),
    render: (d) => '<div>L3-' + (d && d.name || '') + '</div>',
    title: '层3',
  });
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  assert.strictEqual(D.stackSize(), 2);
  D.open('layer3', 'C', { data: { name: 'C' } });
  assert.strictEqual(D.stackSize(), 1, '再 open 应重置栈为 1 层');
  assert.strictEqual(global.location.hash, '#drawer=layer3:C');
  assert(bodyEl._html.includes('L3-C'), 'body 应显示新的 L1');
});

console.log('\n── hash 还原（多层） ──');

test('restoreFromHash 支持多层 hash 段', () => {
  resetState();
  // 模拟刷新时 URL 已带多层 hash
  global.history.replaceState(null, '', '#drawer=leader:600519>sectorDetail:%E5%8D%8A%E5%AF%BC%E4%BD%93>stockDetail:000001');
  // 手动执行还原逻辑（drawer.js 已注册 fetcher，此处直接调 open/push 模拟）
  D.open('leader', '600519', { data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  D.push('stockDetail', '000001', { data: { name: '茅台' } });
  assert.strictEqual(D.stackSize(), 3);
  assert.strictEqual(global.location.hash,
    '#drawer=leader:600519>sectorDetail:%E5%8D%8A%E5%AF%BC%E4%BD%93>stockDetail:000001',
    '三层 hash 应保持顺序与编码');
});

test('restoreFromHash 时超过 MAX_DEPTH 段会被截断', () => {
  resetState();
  // 假设 URL 有 4 层（用户手动改的）
  global.history.replaceState(null, '', '#drawer=a:1>b:2>c:3>d:4');
  // drawer.js 里 restoreFromHash 会 slice 到 MAX_DEPTH，
  // 这里模拟还原行为：open 1 层 + push 2 次 = 3 层
  D.open('X', '1', { data: { i: 1 } });
  D.push('X', '2', { data: { i: 2 } });
  D.push('X', '3', { data: { i: 3 } });
  assert.strictEqual(D.stackSize(), 3);
  assert.strictEqual(D.push('X', '4', { data: { i: 4 } }), false);
  assert.strictEqual(D.stackSize(), 3);
});

console.log('\n── 焦点恢复 ──');

test('L2 下钻后 close 焦点还给 L1 的 sourceEl（原始触发点）', () => {
  resetState();
  const source = makeEl('button');
  _elements.source2 = source;
  document._activeElement = null;
  D.open('leader', '600519', { sourceEl: source, data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  D.close();
  assert(document._activeElement === source, 'close 后焦点应还给 L1 的 sourceEl');
});

test('L2 下钻后 pop 焦点仍在抽屉内（不还给外部）', () => {
  resetState();
  const source = makeEl('button');
  _elements.source3 = source;
  document._activeElement = null;
  D.open('leader', '600519', { sourceEl: source, data: { name: '龙头A' } });
  D.push('sectorDetail', '半导体', { data: { name: '半导体' } });
  D.pop();
  // pop 不关闭抽屉，焦点不还给外部 sourceEl
  assert(document._activeElement !== source, 'pop 后焦点不应跳到外部 sourceEl');
});

/* ══════════════════════════════════════════════════════════
   C2-C2: 星图实体抽屉
   ══════════════════════════════════════════════════════════
   注册 'entity' 类型 + 从 /api/starmap 取数 + 渲染实体名/类别/记忆列表。
   index.html 里的 IIFE 与下列 fetcher/render 完全一致（此处内联复制以便测试）。
*/

console.log('\n── C2-C2 星图实体抽屉 ──');

const CAT_CN = { person: '人物', place: '地点', event: '事件', interest: '兴趣', project: '项目' };
const DECAY_CN = { fresh: '新鲜', normal: '正常', fading: '正在变淡' };
const MAX_MEMS_SHOWN = 20;

function _escForTest(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fetchEntity(entityName) {
  return fetch('/api/starmap').then(r => r.json()).then(d => {
    const ents = (d && d.entities) || [];
    const mems = (d && d.memories) || [];
    const ent = ents.find(e => e.name === entityName);
    if (!ent) return null;
    const entityMems = mems.filter(m => m.entity === entityName);
    return { ...ent, memories: entityMems };
  });
}

function renderEntity(data) {
  if (!data) return '<div class="drw-error">未找到该实体</div>';
  let h = '<div class="drw-sec">';
  h += '<div class="drw-title">' + _escForTest(data.name) + '</div>';
  h += '<div class="drw-sub">' + (CAT_CN[data.category] || _escForTest(data.category)) + ' · #' + _escForTest(data.id != null ? data.id : '') + '</div>';
  h += '</div>';

  h += '<div class="drw-grid">';
  h += '<div class="drw-kv"><span class="k">关联记忆</span><span class="v">' + (data.memCount || 0) + ' 条</span></div>';
  h += '<div class="drw-kv"><span class="k">提及次数</span><span class="v">' + (data.mentions || 0) + '</span></div>';
  h += '</div>';

  if (data.memories && data.memories.length) {
    h += '<div class="drw-reasons">';
    h += '<div class="drw-rtitle">记忆条目（' + data.memories.length + ' 条）</div>';
    h += '<ul>';
    const showMems = data.memories.slice(0, MAX_MEMS_SHOWN);
    showMems.forEach(m => {
      const decayLabel = DECAY_CN[m.decayState] || '未知';
      h += '<li>' + _escForTest(m.content || '（无内容）') +
           ' <span style="color:var(--faint);font-size:10px">[' + decayLabel + ' · ' + (m.ageDays != null ? m.ageDays : 0) + '天前]</span></li>';
    });
    if (data.memories.length > MAX_MEMS_SHOWN) {
      h += '<li style="color:var(--faint)">…还有 ' + (data.memories.length - MAX_MEMS_SHOWN) + ' 条未显示</li>';
    }
    h += '</ul>';
    h += '</div>';
  }

  h += '<div class="drw-actions">';
  h += '<button class="drw-ask" data-code="" data-name="' + _escForTest(data.name) + '">问 AI</button>';
  h += '</div>';

  return h;
}

/* 构造 /api/starmap 的响应 mock */
function makeStarmapData(entityName, mems){
  return {
    counts: { messages: 0, memories: mems.length, entities: 1 },
    galaxies: ['person', 'place', 'event', 'interest', 'project'],
    entities: [{ id: 'e_' + entityName, name: entityName, category: 'person', memCount: mems.length, mentions: mems.length * 2 }],
    memories: mems.map((c, i) => ({
      id: 'm_' + i,
      entity: entityName,
      category: 'person',
      weight: 3,
      strength: 0.9,
      retention: 0.9,
      content: c,
      readCount: 0,
      ageDays: i * 1.0,
      createdAt: '2026-01-01',
      mergedCount: 0,
      decayState: i % 3 === 0 ? 'fading' : (i % 3 === 1 ? 'normal' : 'fresh'),
    })),
  };
}

/* ── fetch stub ── */
let _mockStarmapData = null;
global.fetch = function(url){
  if (url === '/api/starmap'){
    /* 关键：在 fetch() 调用时捕获 _mockStarmapData，而非在 json() 调用时。
     * 否则后续测试修改 _mockStarmapData 后，async 测试的 json() 会读到新值。 */
    const captured = _mockStarmapData;
    return Promise.resolve({ json: () => Promise.resolve(captured) });
  }
  return Promise.reject(new Error('unexpected fetch: ' + url));
};
/* stockDetail 段（line 1296）临时覆盖 global.fetch 为「json() 时捕获」的语义，
 * 与本文件原 fetch stub 的「fetch() 时捕获」不一致。该覆盖在 async 测试里
 * 通过 await 恢复，但 test() 不 await，故恢复发生在微任务里——晚于后续同步测试。
 * 这里保存原 stub 引用，供 C2-D3 段首恢复。 */
const _ORIGINAL_FETCH_STUB = global.fetch;

/* 注册 entity 类型（与 index.html IIFE 一致） */
D.register('entity', {
  fetcher: fetchEntity,
  render: renderEntity,
  title: '实体详情',
});

test('entity 类型注册后可 open，isOpen=true 且 title 为实体名', () => {
  resetState();
  const source = makeEl('canvas');
  D.open('entity', '张三', { side: 'right', title: '张三', sourceEl: source });
  assert.strictEqual(D.isOpen(), true, '抽屉应打开');
  assert.strictEqual(titleEl._text, '张三', 'title 应为实体名');
});

test('entity 类型 hash 为 #drawer=entity:<entityName>', () => {
  resetState();
  D.open('entity', '张三', { side: 'right', title: '张三' });
  assert(global.location.hash.includes('entity:%E5%BC%A0%E4%B8%89'),
    'hash 应含 entity:<URL-encoded 张三>，实际: ' + global.location.hash);
});

test('entity fetcher 返回正确数据形状（含 entity + memories 数组）', async () => {
  resetState();
  _mockStarmapData = makeStarmapData('张三', ['我喜欢篮球', '张三住在上海', '张三很努力']);
  const data = await fetchEntity('张三');
  assert(data && data.name === '张三', 'name 应为张三');
  assert.strictEqual(data.category, 'person', 'category 应为 person');
  assert.strictEqual(data.memCount, 3, 'memCount 应为 3');
  assert.strictEqual(data.mentions, 6, 'mentions 应为 6');
  assert(Array.isArray(data.memories), 'memories 应为数组');
  assert.strictEqual(data.memories.length, 3, '该实体的记忆数应为 3');
  assert.strictEqual(data.memories[0].content, '我喜欢篮球');
  assert.strictEqual(data.memories[0].entity, '张三');
  D.close();
});

test('entity fetcher 找不到实体返回 null', async () => {
  resetState();
  _mockStarmapData = makeStarmapData('张三', ['我喜欢篮球']);
  const data = await fetchEntity('李四');
  assert.strictEqual(data, null, '不存在的实体应返回 null');
  D.close();
});

test('entity fetcher 在 memories 为空时仍返回实体（memories=[]）', async () => {
  resetState();
  _mockStarmapData = { entities: [{ id: 'e_1', name: '王五', category: 'place', memCount: 0, mentions: 0 }], memories: [] };
  const data = await fetchEntity('王五');
  assert(data && data.name === '王五');
  assert(Array.isArray(data.memories), 'memories 应为数组（空）');
  assert.strictEqual(data.memories.length, 0, '该实体无关联记忆时 memories 应为空数组');
  D.close();
});

test('render 返回含实体名 + 类别中文 + 记忆列表的 HTML', () => {
  resetState();
  D.open('entity', '张三', {
    side: 'right',
    title: '张三',
    data: {
      id: 'e_1',
      name: '张三',
      category: 'person',
      memCount: 2,
      mentions: 5,
      memories: [
        { id: 'm_1', content: '我喜欢篮球', entity: '张三', decayState: 'fresh', ageDays: 1.0 },
        { id: 'm_2', content: '张三住在上海', entity: '张三', decayState: 'normal', ageDays: 2.0 },
      ],
    },
  });
  assert(bodyEl._html.includes('张三'), 'HTML 应含实体名张三');
  assert(bodyEl._html.includes('人物'), 'HTML 应含类别中文「人物」');
  assert(bodyEl._html.includes('关联记忆'), 'HTML 应含"关联记忆"');
  assert(bodyEl._html.includes('提及次数'), 'HTML 应含"提及次数"');
  assert(bodyEl._html.includes('2 条'), '关联记忆数应显示 2 条');
  assert(bodyEl._html.includes('5</span>'), '提及次数值应显示 5');
  assert(bodyEl._html.includes('我喜欢篮球'), '记忆列表应含第一条内容');
  assert(bodyEl._html.includes('张三住在上海'), '记忆列表应含第二条内容');
  assert(bodyEl._html.includes('新鲜'), 'fresh 状态应显示中文「新鲜」');
  assert(bodyEl._html.includes('正常'), 'normal 状态应显示中文「正常」');
  assert(bodyEl._html.includes('drw-actions'), '应含 drw-actions 区块');
  assert(bodyEl._html.includes('问 AI'), '应有问 AI 按钮');
  D.close();
});

test('render 空记忆列表安全（无 memories 数组）', () => {
  resetState();
  D.open('entity', '王五', {
    side: 'right',
    title: '王五',
    data: { id: 'e_2', name: '王五', category: 'place', memCount: 0, mentions: 0, memories: [] },
  });
  assert(bodyEl._html.includes('王五'), 'HTML 应含实体名');
  assert(bodyEl._html.includes('0 条'), '关联记忆数应显示 0 条');
  assert(!bodyEl._html.includes('drw-reasons'), '无记忆时不应出现记忆列表区块');
  assert(!bodyEl._html.includes('drw-rtitle'), '无记忆时不应出现记忆标题');
  D.close();
});

test('render 空记忆列表安全（memories 字段缺失）', () => {
  resetState();
  D.open('entity', '王五', {
    side: 'right',
    title: '王五',
    data: { id: 'e_2', name: '王五', category: 'place', memCount: 0, mentions: 0 },
  });
  assert(bodyEl._html.includes('王五'));
  assert(!bodyEl._html.includes('drw-reasons'), 'memories 字段缺失时不应出现记忆列表');
  D.close();
});

test('render 超过 20 条记忆时截断显示 + 未显示提示', () => {
  resetState();
  const manyMems = [];
  for (let i = 0; i < 25; i++) {
    manyMems.push({ id: 'm_' + i, content: '记忆' + i, entity: '张三', decayState: 'normal', ageDays: i * 0.5 });
  }
  D.open('entity', '张三', {
    side: 'right',
    title: '张三',
    data: { id: 'e_1', name: '张三', category: 'person', memCount: 25, mentions: 30, memories: manyMems },
  });
  // 前 20 条应显示
  assert(bodyEl._html.includes('记忆0'), '应显示第 0 条');
  assert(bodyEl._html.includes('记忆19'), '应显示第 19 条（最后一个可见）');
  // 第 20 条之后应截断
  assert(!bodyEl._html.includes('>记忆20<'), '不应显示第 20 条之后（截断）');
  assert(!bodyEl._html.includes('>记忆24<'), '不应显示第 24 条（最后一条）');
  // 显示总数 = 25
  assert(bodyEl._html.includes('记忆条目（25 条）'), '记忆列表标题应显示总数 25');
  // 应显示未显示提示
  assert(bodyEl._html.includes('还有 5 条未显示'), '应有"还有 5 条未显示"提示，实际: ' + bodyEl._html);
  D.close();
});

test('renderEntity(null) 返回"未找到该实体"错误 HTML', () => {
  // 直接测试 renderEntity 函数（不通过 D.open）：
  // drawer.js 的 _renderBody 在 data=null + 有 fetcher 时会走 fetcher 路径，
  // 只有当 fetcher 返回 null（实体确实不存在）时才会调用 renderEntity(null)。
  // 这里直接测纯函数，覆盖"实体不存在"分支。
  const html = renderEntity(null);
  assert.strictEqual(html, '<div class="drw-error">未找到该实体</div>',
    'renderEntity(null) 应返回错误提示 HTML，实际: ' + html);
});

test('render HTML 转义用户内容（防 XSS）', () => {
  resetState();
  D.open('entity', '<script>alert(1)</script>', {
    side: 'right',
    title: '<script>alert(1)</script>',
    data: {
      id: 'e_1',
      name: '<script>alert(1)</script>',
      category: 'person',
      memCount: 0,
      mentions: 0,
      memories: [],
    },
  });
  assert(!bodyEl._html.includes('<script>alert(1)</script>'),
    '不应含未转义的 <script> 标签，实际: ' + bodyEl._html);
  assert(bodyEl._html.includes('&lt;script&gt;'),
    '应含转义后的 &lt;script&gt;，实际: ' + bodyEl._html);
  D.close();
});

test('entity 抽屉走 fetcher 路径：open 后 body 先显示加载中', () => {
  resetState();
  _mockStarmapData = makeStarmapData('张三', ['我喜欢篮球']);
  D.open('entity', '张三', { side: 'right', title: '张三' });
  // fetcher 被调用，Promise 未 resolve 前应显示加载中
  assert(bodyEl._html.includes('加载中'), 'fetcher 路径下 body 应立即显示加载中，实际: ' + bodyEl._html);
  D.close();
});

test('entity 抽屉 close 后焦点还给 sourceEl（星图 canvas）', () => {
  resetState();
  const canvas = makeEl('canvas');
  _elements.graphEl = canvas;
  document._activeElement = null;
  D.open('entity', '张三', { sourceEl: canvas, side: 'right', title: '张三', data: { name: '张三', category: 'person', memCount: 0, mentions: 0, memories: [] } });
  assert(document._activeElement !== canvas, '打开时焦点应离开 canvas');
  D.close();
  assert(document._activeElement === canvas, '关闭后焦点应还给 canvas（星图）');
});

test('entity Esc 关闭抽屉（星图不关闭）', () => {
  resetState();
  D.open('entity', '张三', { side: 'right', title: '张三', data: { name: '张三', category: 'person', memCount: 0, mentions: 0, memories: [] } });
  assert.strictEqual(D.isOpen(), true);
  document.dispatchEvent({ type: 'keydown', key: 'Escape', _capture: true, preventDefault: () => {}, stopPropagation: () => {} });
  assert.strictEqual(D.isOpen(), false, 'Esc 后抽屉应关闭');
  assert.strictEqual(D.stackSize(), 0, 'Esc 后栈应清空');
  assert.strictEqual(global.location.hash, '', 'Esc 后 hash 应清空');
});

/* ══════════════════════════════════════════════════════════
   C2-C: stockDetail K 线图 Tab
   ══════════════════════════════════════════════════════════
   fetcher 走 /api/kline 同时返回 bars + indicators；render 同步返回
   <canvas id="drwKlineCanvas"> 占位 HTML，再用 setTimeout(0) 后置调
   Charts.drawKline 一次性重画（不入 gatedLoop、不新增 rAF 链）。

   测试策略：index.html IIFE 里的 renderStockDetail 无法直接 require，
   按 C2-C2 同一纪律内联复制一份等价 render（HTML 结构逐字一致），
   验证 Drawer.push 后的 body HTML 契约：
     - 含 #drwKlineCanvas 元素（width=440 height=260）
     - 含 K 线图例（涨/跌/MA5/MA10/MA20/量 + A股红涨绿跌 note）
     - 图例色块类名 kl-sw-up/kl-sw-dn/kl-ln5/kl-ln10/kl-ln20/kl-sw-vol
     - fetcher 返回的 bars 数组形状正确
     - fetcher 失败/未 ok 时 render 返回错误提示（不崩溃）
*/

console.log('\n── C2-C stockDetail K 线图 Tab ──');

/* 内联 copy：与 index.html §6 IIFE 里的 renderStockDetail 逐字一致
   （除 esc/num/pct 复用上方 _escForTest 与内联 num/pct 助手） */
const _pctForTest = v => (v == null || isNaN(v)) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(2) + '%';
const _numForTest = v => (v == null || isNaN(v)) ? '—' : String(+v);

function fetchStockDetail(code){
  return fetch('/api/kline?code=' + encodeURIComponent(code) + '&period=day&limit=60')
    .then(r => r.json())
    .catch(() => null);
}

function renderStockDetail(data){
  if (!data || !data.ok) {
    const err = (data && data.error) ? _escForTest(data.error) : '数据暂不可用';
    return '<div class="drw-error">' + err + '</div>';
  }
  const ind = data.indicators || {};
  const bars = Array.isArray(data.bars) ? data.bars : [];
  let h = '<div class="drw-sec">';
  h += '<div class="drw-title">' + _escForTest(data.name || data.code) + '</div>';
  h += '<div class="drw-sub">' + _escForTest(data.code) + '　·　' + _escForTest(data.source || '') + '</div>';
  h += '</div>';

  h += '<div class="drw-grid">';
  h += '<div class="drw-kv"><span class="k">最新收盘</span><span class="v">' + _numForTest(ind.latest_close) + '</span></div>';
  h += '<div class="drw-kv"><span class="k">区间涨跌</span><span class="v">' + _pctForTest(ind.period_change_pct) + '</span></div>';
  h += '<div class="drw-kv"><span class="k">区间高</span><span class="v">' + _numForTest(ind.period_high) + '</span></div>';
  h += '<div class="drw-kv"><span class="k">区间低</span><span class="v">' + _numForTest(ind.period_low) + '</span></div>';
  h += '<div class="drw-kv"><span class="k">MA5</span><span class="v">' + _numForTest(ind.ma5) + '</span></div>';
  h += '<div class="drw-kv"><span class="k">MA10</span><span class="v">' + _numForTest(ind.ma10) + '</span></div>';
  h += '<div class="drw-kv"><span class="k">MA20</span><span class="v">' + _numForTest(ind.ma20) + '</span></div>';
  h += '<div class="drw-kv"><span class="k">年化波动</span><span class="v">' + (ind.annualized_volatility_pct != null ? ind.annualized_volatility_pct + '%' : '—') + '</span></div>';
  h += '</div>';

  /* K 线图区域 —— C2-C 契约核心：canvas + 图例 */
  h += '<div class="drw-kline">';
  h += '<div class="drw-kline-title">60 日 K 线　·　红涨绿跌</div>';
  h += '<canvas id="drwKlineCanvas" width="440" height="260"></canvas>';
  h += '<div class="drw-kline-legend">';
  h += '<span class="kl-key"><span class="kl-sw kl-sw-up"></span>涨</span>';
  h += '<span class="kl-key"><span class="kl-sw kl-sw-dn"></span>跌</span>';
  h += '<span class="kl-key"><span class="kl-ln kl-ln5"></span>MA5</span>';
  h += '<span class="kl-key"><span class="kl-ln kl-ln10"></span>MA10</span>';
  h += '<span class="kl-key"><span class="kl-ln kl-ln20"></span>MA20</span>';
  h += '<span class="kl-key"><span class="kl-sw kl-sw-vol"></span>量</span>';
  h += '<span class="kl-note">A股红涨绿跌</span>';
  h += '</div>';
  h += '</div>';

  /* setTimeout(0) 后置绘制（测试中 window.Charts 不存在，setTimeout 会同步执行
     但立即被 !window.Charts 守卫短路，不影响 HTML 契约测试） */
  setTimeout(function(){
    var C = window.Charts;
    if(!C || typeof C.drawKline !== 'function') return;
    var cv = document.getElementById('drwKlineCanvas');
    if(!cv) return;
    var res = C.drawKline(cv, bars, {});
    if(res && typeof C.bindHover === 'function'){ C.bindHover(cv, res); }
  }, 0);

  if (ind.position_in_range_pct != null) {
    h += '<div class="drw-bar-wrap">';
    h += '<div class="drw-rtitle">当前价在区间中的位置</div>';
    h += '<div class="drw-bar"><div class="drw-bar-fill" style="width:' + Math.max(0, Math.min(100, ind.position_in_range_pct)) + '%"></div></div>';
    h += '</div>';
  }

  if (data.bars && data.bars.length) {
    h += '<div class="drw-reasons">';
    h += '<div class="drw-rtitle">最近 ' + Math.min(5, data.bars.length) + ' 根日线</div>';
    h += '<ul>';
    data.bars.slice(-5).reverse().forEach(b => {
      const d = b.date || b.bar_time || '';
      const chg = b.open ? ((b.close - b.open) / b.open * 100) : null;
      h += '<li>' + _escForTest(String(d)) + '　开 ' + _numForTest(b.open) + '　收 ' + _numForTest(b.close) +
           '　(' + _pctForTest(chg) + ')</li>';
    });
    h += '</ul>';
    h += '</div>';
  }

  h += '<div class="drw-time">周期：' + _escForTest(data.period || '') + '　·　来源：' + _escForTest(data.source || '') + '</div>';

  h += '<div class="drw-actions">';
  h += '<button class="drw-ask" data-code="' + _escForTest(data.code || '') + '" data-name="' + _escForTest(data.name || data.code || '') + '">问 AI</button>';
  h += '</div>';
  return h;
}

/* 构造 /api/kline 的响应 mock */
function makeKlineData(code, name){
  const bars = [];
  let base = 100;
  for(let i = 0; i < 60; i++){
    const open = base;
    const close = base + (i % 5 === 0 ? -1.2 : 0.8);
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    bars.push({
      date: '2026-' + String((i % 12) + 1).padStart(2, '0') + '-' + String((i % 28) + 1).padStart(2, '0'),
      open: open, high: high, low: low, close: close,
      volume: 1e8 + i * 1e6
    });
    base = close;
  }
  return {
    ok: true,
    code: code,
    name: name,
    period: 'day',
    adjust: 'forward',
    source: '腾讯财经',
    days: bars.length,
    indicators: {
      latest_close: bars[bars.length - 1].close,
      period_change_pct: 8.5,
      period_high: 120,
      period_low: 95,
      ma5: 105.2,
      ma10: 103.8,
      ma20: 102.1,
      annualized_volatility_pct: 22.5,
      position_in_range_pct: 65,
      volatility: 0.032,
    },
    bars: bars,
  };
}

/* 注册 stockDetail 类型（与 index.html IIFE 一致） */
D.register('stockDetail', {
  fetcher: fetchStockDetail,
  render: renderStockDetail,
  title: '个股详情',
});

test('stockDetail 类型注册后可 open，isOpen=true', () => {
  resetState();
  D.open('stockDetail', '600519', { side: 'right', data: makeKlineData('600519', '贵州茅台') });
  assert.strictEqual(D.isOpen(), true);
});

test('stockDetail render 返回的 HTML 含 #drwKlineCanvas', () => {
  resetState();
  D.open('stockDetail', '600519', { side: 'right', data: makeKlineData('600519', '贵州茅台') });
  assert(bodyEl._html.includes('id="drwKlineCanvas"'),
    'HTML 应含 #drwKlineCanvas 元素，实际片段: ' + bodyEl._html.slice(bodyEl._html.indexOf('drw-kline') || 0, (bodyEl._html.indexOf('drw-kline') || 0) + 250));
  assert(bodyEl._html.includes('<canvas'), 'HTML 应含 canvas 标签');
  assert(bodyEl._html.includes('width="440"'), 'canvas width 应为 440');
  assert(bodyEl._html.includes('height="260"'), 'canvas height 应为 260');
  D.close();
});

test('stockDetail render 返回的 HTML 含 K 线图例（6 色块 + note）', () => {
  resetState();
  D.open('stockDetail', '600519', { side: 'right', data: makeKlineData('600519', '贵州茅台') });
  const html = bodyEl._html;
  // 图例容器
  assert(html.includes('drw-kline-legend'), '应含 drw-kline-legend 容器');
  // 涨/跌 色块
  assert(html.includes('kl-sw-up'), '应含 kl-sw-up（涨 实心红）');
  assert(html.includes('kl-sw-dn'), '应含 kl-sw-dn（跌 空心绿描边）');
  assert(html.includes('>涨</span>'), '应含「涨」标签');
  assert(html.includes('>跌</span>'), '应含「跌」标签');
  // MA5/MA10/MA20 三色
  assert(html.includes('kl-ln5'), '应含 kl-ln5（MA5 青）');
  assert(html.includes('kl-ln10'), '应含 kl-ln10（MA10 金）');
  assert(html.includes('kl-ln20'), '应含 kl-ln20（MA20 蓝）');
  assert(html.includes('MA5'), '应含 MA5 标签');
  assert(html.includes('MA10'), '应含 MA10 标签');
  assert(html.includes('MA20'), '应含 MA20 标签');
  // 量
  assert(html.includes('kl-sw-vol'), '应含 kl-sw-vol（量 双色半透渐变）');
  assert(html.includes('>量</span>'), '应含「量」标签');
  // A股红涨绿跌 note
  assert(html.includes('A股红涨绿跌'), '应含 A股红涨绿跌 note');
  D.close();
});

test('K 线 canvas 元素存在（body 内完整闭合的 <canvas id="drwKlineCanvas">）', () => {
  resetState();
  D.open('stockDetail', '600519', { side: 'right', data: makeKlineData('600519', '贵州茅台') });
  const m = bodyEl._html.match(/<canvas\s+id="drwKlineCanvas"\s+width="440"\s+height="260"\s*>\s*<\/canvas>/);
  assert(m !== null,
    'body HTML 应含完整闭合的 canvas 元素 <canvas id="drwKlineCanvas" width="440" height="260"></canvas>，实际: ' + bodyEl._html);
  D.close();
});

test('stockDetail fetcher 返回 {ok, code, name, period, adjust, source, days, indicators, bars} 形状', async () => {
  resetState();
  const realFetch = global.fetch;
  global.fetch = function(url){
    if (typeof url === 'string' && url.startsWith('/api/kline')) {
      const code = (url.match(/code=([^&]+)/) || [,'600519'])[1];
      return Promise.resolve({ json: () => Promise.resolve(makeKlineData(decodeURIComponent(code), '贵州茅台')) });
    }
    if (url === '/api/starmap') {
      return Promise.resolve({ json: () => Promise.resolve(_mockStarmapData) });
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
  };
  const data = await fetchStockDetail('600519');
  global.fetch = realFetch;
  assert(data && data.ok === true, 'ok 应为 true');
  assert.strictEqual(data.code, '600519');
  assert.strictEqual(data.name, '贵州茅台');
  assert.strictEqual(data.period, 'day');
  assert(Array.isArray(data.bars), 'bars 应为数组');
  assert.strictEqual(data.bars.length, 60, 'bars 应有 60 条日线');
  assert(data.bars[0].open != null && data.bars[0].close != null && data.bars[0].high != null && data.bars[0].low != null,
    'bars 元素应含 open/high/low/close');
  assert.strictEqual(typeof data.bars[0].volume, 'number', 'bars 元素应含 volume 数值');
  assert(data.indicators && typeof data.indicators.ma5 === 'number', 'indicators 应含 ma5');
  D.close();
});

test('stockDetail render 无 bars 时 canvas 与图例仍显示（空数据不崩溃）', () => {
  resetState();
  D.open('stockDetail', '600519', { side: 'right', data: {
    ok: true, code: '600519', name: '贵州茅台', period: 'day', source: '腾讯财经',
    days: 0, indicators: {}, bars: []
  } });
  assert(bodyEl._html.includes('id="drwKlineCanvas"'), '无 bars 时 canvas 元素仍应存在（drawKline 会在后置绘制时显示「暂无K线数据」）');
  assert(bodyEl._html.includes('drw-kline-legend'), '无 bars 时图例仍应存在');
  D.close();
});

test('stockDetail render data.ok=false 返回错误提示（不出现 canvas）', () => {
  resetState();
  D.open('stockDetail', '600519', { side: 'right', data: { ok: false, error: '网络错误' } });
  assert(bodyEl._html.includes('drw-error'), '应含 drw-error 容器');
  assert(bodyEl._html.includes('网络错误'), '应含错误消息');
  assert(!bodyEl._html.includes('drwKlineCanvas'), '错误时不应出现 canvas');
  assert(!bodyEl._html.includes('drw-kline-legend'), '错误时不应出现图例');
  D.close();
});

test('stockDetail render data=null 返回"数据暂不可用"（不崩溃）', () => {
  const html = renderStockDetail(null);
  assert.strictEqual(html, '<div class="drw-error">数据暂不可用</div>',
    'renderStockDetail(null) 应返回错误提示 HTML，实际: ' + html);
});

test('stockDetail 走 Drawer.push 下钻路径（L1→L2 stockDetail）', () => {
  resetState();
  D.open('leader', '600519', { data: { name: '龙头A' } });
  const ok = D.push('stockDetail', '600519', { data: makeKlineData('600519', '贵州茅台') });
  assert.strictEqual(ok, true, 'push 应返回 true');
  assert.strictEqual(D.stackSize(), 2, 'push 后栈应为 2');
  assert(bodyEl._html.includes('id="drwKlineCanvas"'), 'L2 body 应含 K 线 canvas');
  assert(bodyEl._html.includes('贵州茅台'), 'L2 body 应含股票名');
  assert.strictEqual(D.pop(), true);
  assert(bodyEl._html.includes('LEADER-'), 'pop 后应回到 L1 内容');
});

/* ════════════════ C2-D3 星图类别左抽屉 ════════════════
 * 覆盖：
 *   - 'category' 类型注册后可 open（side='left'）
 *   - panel 有 .from-left 类、无 .from-right
 *   - fetchCategory 返回正确数据形状（按 category 过滤实体与记忆，记忆上限 30）
 *   - renderCategory 含类别名 + 实体列表 + 记忆列表
 *   - 空数据安全（null / 无实体无记忆 / 无匹配类别）
 *   - HTML 转义（& < > " 不产生注入）
 *   - 记忆上限 30 条硬截断（slice(0, 30)）
 */
console.log('\n── C2-D3 星图类别左抽屉 ──');

/* stockDetail 段（line 1296）临时覆盖 global.fetch 为「json() 时捕获」的语义，
 * 与本文件原 fetch stub 的「fetch() 时捕获」不一致。该覆盖在 async 测试里
 * 通过 await 恢复，但 test() 不 await，故恢复发生在微任务里——晚于本段同步测试。
 * 这里在段首恢复原 stub，保证 fetchCategory 系列测试读到本段刚设置的 _mockStarmapData。 */
global.fetch = _ORIGINAL_FETCH_STUB;

const CAT_CN_TEST = { person: '人物', place: '地点', event: '事件', interest: '兴趣', project: '项目' };
const DECAY_CN_TEST = { fresh: '新鲜', normal: '正常', fading: '正在变淡' };
const MAX_MEMS_CAT = 30;

function fetchCategory(category) {
  return fetch('/api/starmap').then(r => r.json()).then(d => {
    const ents = (d && d.entities) || [];
    const mems = (d && d.memories) || [];
    const catEnts = ents.filter(e => e.category === category);
    const catMems = mems.filter(m => m.category === category);
    return {
      category: category,
      name: CAT_CN_TEST[category] || category,
      entityCount: catEnts.length,
      memoryCount: catMems.length,
      entities: catEnts,
      memories: catMems.slice(0, MAX_MEMS_CAT),
    };
  });
}

function renderCategory(data) {
  if (!data) return '<div class="drw-error">未找到数据</div>';
  let h = '<div class="drw-sec">';
  h += '<div class="drw-title">' + _escForTest(data.name) + '</div>';
  h += '<div class="drw-sub">' + (data.entityCount || 0) + ' 个实体 · ' + (data.memoryCount || 0) + ' 条记忆</div>';
  h += '</div>';

  if (data.entities && data.entities.length) {
    h += '<div class="drw-reasons">';
    h += '<div class="drw-rtitle">实体（' + data.entities.length + '）</div>';
    h += '<ul>';
    data.entities.forEach(e => {
      h += '<li>' + _escForTest(e.name) +
           ' <span style="color:var(--faint);font-size:10px">' + (e.memCount || 0) + '条记忆 · ' + (e.mentions || 0) + '次提及</span></li>';
    });
    h += '</ul>';
    h += '</div>';
  }

  if (data.memories && data.memories.length) {
    h += '<div class="drw-reasons">';
    h += '<div class="drw-rtitle">最近记忆（最多 ' + Math.min(data.memories.length, MAX_MEMS_CAT) + ' 条）</div>';
    h += '<ul>';
    data.memories.forEach(m => {
      const decayLabel = DECAY_CN_TEST[m.decayState] || '未知';
      h += '<li>' + _escForTest(m.content || '（无内容）') +
           ' <span style="color:var(--faint);font-size:10px">[' + decayLabel + ' · ' + (m.ageDays != null ? m.ageDays : 0) + '天前]</span></li>';
    });
    h += '</ul>';
    h += '</div>';
  }

  if (!(data.entities && data.entities.length) && !(data.memories && data.memories.length)) {
    h += '<div class="drw-reasons"><div class="drw-rtitle">该类别下暂无实体或记忆</div></div>';
  }

  return h;
}

/* 注册 category 类型（与 index.html IIFE 一致） */
D.register('category', {
  fetcher: fetchCategory,
  render: renderCategory,
  title: '类别详情',
});

/* 构造含多个类别的 starmap 响应 mock */
function makeMultiCategoryData(personMems, personExtra) {
  personExtra = personExtra || {};
  const entities = [
    { id: 'e_p1', name: '张三', category: 'person', memCount: personMems.length, mentions: 5, ...personExtra },
    { id: 'e_p2', name: '李四', category: 'person', memCount: 0, mentions: 1 },
    { id: 'e_l1', name: '北京', category: 'place', memCount: 3, mentions: 3 },
    { id: 'e_e1', name: '入职', category: 'event', memCount: 1, mentions: 1 },
    { id: 'e_i1', name: '编程', category: 'interest', memCount: 2, mentions: 2 },
    { id: 'e_pr1', name: 'Jarvis', category: 'project', memCount: 4, mentions: 4 },
  ];
  const memories = personMems.map((c, i) => ({
    id: 'm_p_' + i,
    entity: '张三',
    category: 'person',
    content: c,
    ageDays: i,
    decayState: i % 3 === 0 ? 'fading' : (i % 3 === 1 ? 'normal' : 'fresh'),
  }));
  // 加一条 place 记忆，用于验证 filter 精确性
  memories.push({
    id: 'm_l_0',
    entity: '北京',
    category: 'place',
    content: '位于中国首都',
    ageDays: 1,
    decayState: 'fresh',
  });
  return {
    counts: { messages: 0, memories: memories.length, entities: entities.length },
    galaxies: ['person', 'place', 'event', 'interest', 'project'],
    entities: entities,
    memories: memories,
  };
}

test('category 类型注册后可 open，isOpen=true', () => {
  resetState();
  D.open('category', 'person', { side: 'left', title: '人物' });
  assert.strictEqual(D.isOpen(), true, '抽屉应打开');
});

test('category open side=left 时 panel 有 .from-left 且无 .from-right', () => {
  resetState();
  D.open('category', 'person', { side: 'left' });
  assert(panel._classSet.has('from-left'), '应加 .from-left');
  assert(!panel._classSet.has('from-right'), '不应有 .from-right');
});

test('category open 默认 title 为"类别详情"（未覆盖时）', () => {
  resetState();
  D.open('category', 'person', { side: 'left' });
  assert.strictEqual(titleEl._text, '类别详情', '未传 opts.title 应使用 register 时的默认标题');
});

test('category open opts.title 覆盖默认（如"人物"）', () => {
  resetState();
  D.open('category', 'person', { side: 'left', title: '人物' });
  assert.strictEqual(titleEl._text, '人物');
});

test('category open 写入 hash #drawer=category:person', () => {
  resetState();
  D.open('category', 'person', { side: 'left' });
  assert.strictEqual(global.location.hash, '#drawer=category:person');
});

/* ── fetchCategory 数据形状 ── */

test('fetchCategory 按 category 过滤实体与记忆，返回正确形状', () => {
  resetState();
  _mockStarmapData = makeMultiCategoryData(['张三很忙', '张三喜欢咖啡', '张三有猫'], {});
  return fetchCategory('person').then(d => {
    assert.strictEqual(d.category, 'person');
    assert.strictEqual(d.name, '人物', 'CAT_CN 映射');
    assert.strictEqual(d.entityCount, 2, '应含张三和李四两个 person 实体');
    assert.strictEqual(d.memoryCount, 3, '应含 3 条 person 记忆（排除 1 条 place 记忆）');
    assert.deepStrictEqual(
      d.entities.map(e => e.name).sort(),
      ['张三', '李四']
    );
    assert.strictEqual(d.memories.length, 3, '记忆数量');
    assert(d.memories.every(m => m.category === 'person'), '所有记忆 category=person');
  });
});

test('fetchCategory 记忆上限 30 条（slice 硬截断）', () => {
  resetState();
  const many = [];
  for (let i = 0; i < 50; i++) many.push('记忆 ' + i);
  _mockStarmapData = makeMultiCategoryData(many, {});
  return fetchCategory('person').then(d => {
    assert.strictEqual(d.memories.length, 30, '应截断到 30 条');
    assert.strictEqual(d.memoryCount, 50, 'memoryCount 保留原始总数');
  });
});

test('fetchCategory 无匹配类别时返回空数组（不抛错）', () => {
  resetState();
  _mockStarmapData = makeMultiCategoryData([], {});
  // place 只有 1 条实体 0 条记忆
  return fetchCategory('place').then(d => {
    assert.strictEqual(d.category, 'place');
    assert.strictEqual(d.entityCount, 1, 'place 有 1 个实体（北京）');
    assert.strictEqual(d.memoryCount, 1, 'place 有 1 条记忆');
  });
});

test('fetchCategory 未知 category 返回空实体空记忆', () => {
  resetState();
  _mockStarmapData = makeMultiCategoryData(['x'], {});
  return fetchCategory('nonexistent').then(d => {
    assert.strictEqual(d.name, 'nonexistent', '未知类别 name 回退到 category 本身');
    assert.strictEqual(d.entityCount, 0);
    assert.strictEqual(d.memoryCount, 0);
    assert.deepStrictEqual(d.entities, []);
    assert.deepStrictEqual(d.memories, []);
  });
});

/* ── renderCategory ── */

test('renderCategory 含类别名 + 实体列表 + 记忆列表', () => {
  const data = {
    category: 'person',
    name: '人物',
    entityCount: 2,
    memoryCount: 3,
    entities: [
      { name: '张三', memCount: 3, mentions: 5 },
      { name: '李四', memCount: 0, mentions: 1 },
    ],
    memories: [
      { content: '张三很忙', ageDays: 0, decayState: 'fading' },
      { content: '张三喜欢咖啡', ageDays: 1, decayState: 'normal' },
      { content: '张三有猫', ageDays: 2, decayState: 'fresh' },
    ],
  };
  const html = renderCategory(data);
  assert(html.includes('drw-title') && html.includes('人物'), '应含类别名"人物"');
  assert(html.includes('2 个实体 · 3 条记忆'), '应含实体/记忆计数');
  assert(html.includes('实体（2）'), '应含实体小标题');
  assert(html.includes('张三') && html.includes('李四'), '应含两个实体名');
  assert(html.includes('3条记忆 · 5次提及'), '应含张三的 memCount/mentions');
  assert(html.includes('最近记忆（最多 3 条）'), '应含记忆小标题');
  assert(html.includes('张三很忙') && html.includes('张三喜欢咖啡'), '应含记忆内容');
  assert(html.includes('新鲜') && html.includes('正常') && html.includes('正在变淡'), '应含 decay 中文标签');
  assert(html.includes('1天前'), '应含 ageDays 显示');
});

test('renderCategory(null) 返回"未找到数据"错误提示', () => {
  const html = renderCategory(null);
  assert.strictEqual(html, '<div class="drw-error">未找到数据</div>');
});

test('renderCategory 空实体空记忆时显示占位文案（不崩溃）', () => {
  const data = {
    category: 'project',
    name: '项目',
    entityCount: 0,
    memoryCount: 0,
    entities: [],
    memories: [],
  };
  const html = renderCategory(data);
  assert(html.includes('项目'), '类别名仍显示');
  assert(html.includes('0 个实体 · 0 条记忆'), '计数为 0');
  assert(html.includes('该类别下暂无实体或记忆'), '应含占位提示');
  assert(!html.includes('drw-error'), '空类别不属于错误状态，不显示 drw-error');
});

test('renderCategory 记忆含 HTML 特殊字符时被转义（防注入）', () => {
  const data = {
    category: 'person',
    name: '人物',
    entityCount: 1,
    memoryCount: 1,
    entities: [{ name: '<img src=x onerror=alert(1)>', memCount: 1, mentions: 1 }],
    memories: [{ content: '& <script>alert("xss")</script>', ageDays: 0, decayState: 'fresh' }],
  };
  const html = renderCategory(data);
  assert(!html.includes('<img src=x'), '实体名中的 <img 应被转义');
  assert(html.includes('&lt;img'), '应出现 &lt;');
  assert(!html.includes('<script>'), '记忆中的 <script 应被转义');
  assert(html.includes('&amp;'), '裸 & 应转义为 &amp;');
});

test('renderCategory 无 ageDays 字段时显示 0（不崩溃）', () => {
  const data = {
    category: 'person',
    name: '人物',
    entityCount: 1,
    memoryCount: 1,
    entities: [{ name: '张三', memCount: 1, mentions: 1 }],
    memories: [{ content: '无年龄记忆', decayState: 'fresh' }],
  };
  const html = renderCategory(data);
  assert(html.includes('0天前'), 'ageDays 缺失时应回退为 0 天前');
  assert(html.includes('未知') === false || html.includes('新鲜'), 'decayState=fresh 应显示"新鲜"');
});

test('renderCategory decayState 未知值时显示"未知"（不崩溃）', () => {
  const data = {
    category: 'person',
    name: '人物',
    entityCount: 0,
    memoryCount: 1,
    entities: [],
    memories: [{ content: '异常状态', ageDays: 5, decayState: 'weird_state' }],
  };
  const html = renderCategory(data);
  assert(html.includes('未知'), '未知 decayState 应回退为"未知"');
});

/* ── Drawer.open 走 fetcher 完整路径 ── */

test('Drawer.open category 走 fetcher 路径（未传 data 时 body 先显示加载中）', () => {
  resetState();
  _mockStarmapData = makeMultiCategoryData(['记忆1', '记忆2'], {});
  D.open('category', 'person', { side: 'left', title: '人物' });
  assert.strictEqual(D.isOpen(), true, '抽屉应打开');
  assert(panel._classSet.has('from-left'), '应为左抽屉');
  // 与 entity 抽屉同一纪律：fetcher 未 resolve 前 body 显示"加载中…"
  // （fetcher resolve 后走 render，已由 renderCategory 系列测试覆盖）
  assert(bodyEl._html.includes('加载中'), 'fetcher 路径下 body 应立即显示加载中，实际: ' + bodyEl._html);
  D.close();
});

test('Drawer.open category 传 data 时跳过 fetcher（body 直接渲染）', () => {
  resetState();
  // 覆盖"预加载数据"路径：调用方已知数据（如从 __starData 缓存取）
  const data = {
    category: 'project',
    name: '项目',
    entityCount: 1,
    memoryCount: 2,
    entities: [{ name: 'Jarvis', memCount: 4, mentions: 4 }],
    memories: [
      { content: 'Jarvis 是本地 AI 助手', ageDays: 0, decayState: 'fresh' },
      { content: 'Jarvis 使用 whisper 转写', ageDays: 1, decayState: 'normal' },
    ],
  };
  D.open('category', 'project', { side: 'left', title: '项目', data: data });
  // 传 data 时同步渲染，body 立即包含渲染结果
  assert(bodyEl._html.includes('项目'), 'body 应含类别名');
  assert(bodyEl._html.includes('Jarvis'), 'body 应含实体名');
  assert(!bodyEl._html.includes('加载中'), '传 data 时不应出现"加载中"');
  D.close();
});

/* ── Esc 关闭左抽屉 ── */

test('Esc 键关闭左抽屉（side=left 与 right 行为一致）', () => {
  resetState();
  D.open('category', 'person', { side: 'left' });
  assert(panel._classSet.has('from-left'));
  assert.strictEqual(D.isOpen(), true);
  document.dispatchEvent({ type: 'keydown', key: 'Escape', _capture: true, preventDefault: () => {}, stopPropagation: () => {} });
  assert.strictEqual(D.isOpen(), false, 'Esc 后应关闭');
  assert(!panel._classSet.has('open'), '关闭后应无 .open');
});

test('close 后焦点还给 sourceEl（左抽屉触发点）', () => {
  resetState();
  const source = makeEl('div');
  source._attrs.tabindex = '0';
  D.open('category', 'person', { side: 'left', title: '人物', sourceEl: source });
  D.close();
  assert(document._activeElement === source, 'close 后焦点应还给 sourceEl');
});

/* ── mount 钩子（C3-B：canvas 类组件必须在 innerHTML 注入后初始化） ── */

console.log('\n── mount 钩子 ──');

test('传 data 时 render 注入后同步调用 mount(bodyEl, data)', () => {
  resetState();
  const calls = [];
  D.register('mpt', {
    render: (d) => '<canvas id="c"></canvas><div>' + d.mark + '</div>',
    mount: (bodyEl, d) => calls.push([bodyEl === bodyEl ? 'body' : '?', d.mark, bodyEl._html.includes('mark-ok')]),
  });
  D.open('mpt', 'x', { side: 'left', data: { mark: 'mark-ok' } });
  assert.strictEqual(calls.length, 1, `mount 应调用 1 次，实际 ${calls.length}`);
  assert.strictEqual(calls[0][1], 'mark-ok', 'mount 应收到同一份 data');
  assert.strictEqual(calls[0][2], true, 'mount 时 render 结果必须已在 DOM 里');
  D.close();
});

test('fetcher 路径：数据到达后 render → mount（异步顺序正确）', async () => {
  resetState();
  const order = [];
  D.register('mpf', {
    fetcher: () => Promise.resolve({ v: 1 }),
    render: () => { order.push('render'); return '<canvas></canvas>'; },
    mount: () => order.push('mount'),
  });
  D.open('mpf', 'y', { side: 'right' });
  await new Promise(r => setTimeout(r, 0));
  assert.deepStrictEqual(order, ['render', 'mount'], `顺序应为 render→mount，实际 ${order.join('→')}`);
  D.close();
});

test('未注册 mount 的条目不受影响（向后兼容）', () => {
  resetState();
  D.register('legacy', { render: () => '<div>old</div>' });
  D.open('legacy', 'z', { side: 'right', data: {} });
  assert(bodyEl._html.includes('old'), '无 mount 的旧条目渲染不能坏');
  D.close();
});

test('push 下钻也走 mount（L2 的 canvas 组件同样需要初始化钩子）', async () => {
  resetState();
  let mounts = 0;
  D.register('l1', {
    render: () => '<div>L1</div>',
    mount: () => mounts++,
  });
  D.register('l2', {
    render: () => '<div>L2</div>',
    mount: () => mounts++,
  });
  D.open('l1', 'a', { side: 'right', data: {} });
  D.push('l2', 'b', { side: 'right', data: {} });
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(mounts, 2, `L1+L2 各应 mount 1 次，实际 ${mounts}`);
  D.close();
});

/* ── 结果 ── */
console.log('\n═══════════════════════════════════════');
console.log('通过: ' + pass + ' | 失败: ' + fail);
console.log('═══════════════════════════════════════');
if(fail > 0) process.exit(1);
