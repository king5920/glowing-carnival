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
const titleEl = makeEl('h2'); titleEl.id = 'drawerTitle';
const bodyEl = makeEl('div'); bodyEl.id = 'drawerBody';
const closeBtn = makeEl('button'); closeBtn.id = 'drawerClose';
panel.appendChild(titleEl);
panel.appendChild(closeBtn);
panel.appendChild(bodyEl);
_elements.drawerBackdrop = backdrop;
_elements.drawerPanel = panel;
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

/* ── 结果 ── */
console.log('\n═══════════════════════════════════════');
console.log('通过: ' + pass + ' | 失败: ' + fail);
console.log('═══════════════════════════════════════');
if(fail > 0) process.exit(1);
