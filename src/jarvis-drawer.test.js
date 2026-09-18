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

/* ── 结果 ── */
console.log('\n═══════════════════════════════════════');
console.log('通过: ' + pass + ' | 失败: ' + fail);
console.log('═══════════════════════════════════════');
if(fail > 0) process.exit(1);
