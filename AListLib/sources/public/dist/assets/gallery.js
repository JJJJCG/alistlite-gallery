/* AListLite 图库前端
 * 只面向图片与视频：浏览、预览、在线播放、上传与下载。
 *
 * 后端接口（对应 server/router.go 的真实路由）：
 *   POST /api/auth/login            -> { token }
 *   GET  /api/me                    -> 当前用户
 *   POST /api/fs/list  {path,password,page,per_page,refresh}
 *                                   -> { content:[{name,size,is_dir,modified,thumb,sign,type}], total, write }
 *   POST /api/fs/dirs  {path,password} -> [{name,modified}]      （注意：只有 name，没有 path）
 *   GET  /d/*path                   -> 文件本体，无鉴权，支持 Range
 *   PUT  /api/fs/put   Header: File-Path=<encodeURIComponent(path)>
 *   GET  /api/admin/storage/list  |  POST /api/admin/storage/{create,update,delete,enable,disable}
 *   GET  /api/admin/driver/info?driver=Local
 *
 * 说明：per_page 传 0 是安全的 —— 后端 model.PageReq.Validate() 会把 <1 的值改成 MaxInt，
 * 也就是「全部」，所以不要改成 100 之类的固定值，否则大目录会被截断。
 */
'use strict';

var CONFIG = window.CONFIG || {};
var BASE = (typeof CONFIG.base_path === 'string' ? CONFIG.base_path : '/').replace(/\/+$/, '');
var API = BASE + '/api';
var MEDIA = BASE + '/d';
var MAIN = (typeof CONFIG.main_color === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(CONFIG.main_color || ''))
  ? (CONFIG.main_color[0] === '#' ? CONFIG.main_color : '#' + CONFIG.main_color)
  : '#1890ff';

var IMG_EXT = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif', 'tif', 'tiff', 'ico'];
var VID_EXT = ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp', 'rmvb', 'asf'];
var NATIVE_VID = ['mp4', 'm4v', 'webm', 'ogv'];

var LS_TOKEN = 'alistlite.token';
var LS_LEGACY_TOKEN = 'token'; // 旧版本前端 / 原生端注入用的键，兼容读取
var LS_PATH = 'alistlite.path';
var LS_KIND = 'alistlite.kind';
var LS_SORT = 'alistlite.sort';
var LS_ROW = 'alistlite.row';

var SCAN_MAX_DIRS = 5000;
var SCAN_CONCURRENCY = 5;

var state = {
  token: '',
  me: null,
  settings: null,
  view: 'folder',          // 'all' = 全部（时间轴） | 'folder' = 某个文件夹
  path: '/',
  items: [],               // 当前视图的媒体
  folders: [],             // 当前文件夹的子文件夹
  rawCount: 0,             // 当前文件夹接口返回的原始条目数（含非媒体）
  kind: 'all',
  sort: 'date',
  rowH: 200,
  keyword: '',
  visible: [],             // 最后一次渲染出来的可见列表（查看器按它前后翻页）
  viewerList: [],
  viewerIndex: -1,
  scanning: false,
  cancelScan: false,
  scan: { dirs: 0, media: 0, fails: [] },
  coverCache: {},
  booted: false,
};

var diag = { list: null, storages: null, errors: [] };

/* ------------------------------------------------------------------ 基础工具 */

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function svgIcon(paths, opts) {
  var o = opts || {};
  var ns = 'http://www.w3.org/2000/svg';
  var s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', o.viewBox || '0 0 24 24');
  s.setAttribute('fill', o.fill || 'none');
  s.setAttribute('stroke', o.stroke || 'currentColor');
  s.setAttribute('stroke-width', o.width || '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  (paths || []).forEach(function (d) {
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  });
  return s;
}

var ICON = {
  folder: function () { return svgIcon(['M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2.2h7.8A2.5 2.5 0 0 1 21 9.7v7.8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z'], { width: '1.7' }); },
  image: function () { return svgIcon(['M4 5h16v14H4z', 'M4 15.5l4.5-4.5 3.5 3.5 3-3 5 5'], { width: '1.7' }); },
  play: function () { return svgIcon(['M8 5.5l11 6.5-11 6.5z'], { fill: 'currentColor', stroke: 'none' }); },
  open: function () { return svgIcon(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'], { width: '1.9' }); },
  more: function () {
    var s = svgIcon([], { fill: 'currentColor', stroke: 'none' });
    var ns = 'http://www.w3.org/2000/svg';
    [5, 12, 19].forEach(function (cx) {
      var c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', '12'); c.setAttribute('r', '1.9');
      s.appendChild(c);
    });
    return s;
  },
};

function toast(msg, ms) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 2400);
}

function ext(name) {
  var i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}

function classify(name) {
  var e = ext(name);
  if (IMG_EXT.indexOf(e) >= 0) return 'image';
  if (VID_EXT.indexOf(e) >= 0) return 'video';
  return null;
}

function joinPath(parent, name) {
  if (!parent || parent === '/') return '/' + name;
  return String(parent).replace(/\/+$/, '') + '/' + name;
}

function dirOf(p) {
  var s = String(p || '/');
  var i = s.lastIndexOf('/');
  if (i <= 0) return '/';
  return s.slice(0, i);
}

function baseName(p) {
  var s = String(p || '');
  var i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

function encodePath(p) {
  return '/' + String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/** 列表项 -> 可直接给 <img>/<video> 用的地址。
 *  item.sign 非空说明该存储开启了签名校验，必须带上，否则 403。 */
function mediaUrl(item) {
  return MEDIA + encodePath(item.path) + (item.sign ? '?sign=' + encodeURIComponent(item.sign) : '');
}

function thumbUrl(item) {
  var t = item.thumb;
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.charAt(0) === '/') return BASE + t;
  return mediaUrl(item);
}

function absUrl(item) {
  try { return new URL(mediaUrl(item), location.href).href; } catch (e) { return mediaUrl(item); }
}

function fmtSize(n) {
  if (n === undefined || n === null) return '';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = 0, v = Number(n);
  if (!isFinite(v)) return '';
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}

function fmtDateTime(t) {
  if (!t) return '';
  var d = new Date(t);
  if (isNaN(d.getTime())) return '';
  var p = function (x) { return String(x).length < 2 ? '0' + x : String(x); };
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function dateKey(t) {
  var d = new Date(t);
  if (isNaN(d.getTime())) return '0000-00-00';
  var p = function (x) { return String(x).length < 2 ? '0' + x : String(x); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

var dateFmt = null;
function dateLabel(key) {
  if (key === '0000-00-00') return '未知日期';
  var parts = key.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  try {
    if (!dateFmt) {
      dateFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    }
    return dateFmt.format(d);
  } catch (e) {
    return key;
  }
}

function hexToRgba(hex, a) {
  var h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var n = parseInt(h.slice(0, 6), 16);
  if (isNaN(n)) return 'rgba(24,144,255,' + a + ')';
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function applyTheme() {
  var root = document.documentElement;
  root.style.setProperty('--main', MAIN);
  root.style.setProperty('--main-soft', hexToRgba(MAIN, 0.09));
}

/* ------------------------------------------------------------------ 请求层 */

function ApiError(message, status, data) {
  this.name = 'ApiError';
  this.message = message;
  this.status = status;
  this.data = data;
}
ApiError.prototype = Object.create(Error.prototype);

function request(path, opt) {
  return requestOnce(path, opt || {}, 0);
}

function requestOnce(path, opt, attempt) {
  var method = opt.method || 'POST';
  var url = API + path;
  if (opt.query) {
    var qs = Object.keys(opt.query).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(opt.query[k]);
    }).join('&');
    if (qs) url += '?' + qs;
  }
  var init = { method: method, headers: {} };
  if (state.token) init.headers['Authorization'] = state.token;
  if (opt.body !== undefined && method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opt.body);
  }
  var timer = null;
  var ctrl = null;
  if (typeof AbortController === 'function') {
    ctrl = new AbortController();
    init.signal = ctrl.signal;
    timer = setTimeout(function () { ctrl.abort(); }, opt.timeout || 25000);
  }
  var started = Date.now();

  return fetch(url, init).then(function (res) {
    if (timer) clearTimeout(timer);
    return res.text().then(function (text) {
      var data = null;
      try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
      var rec = {
        method: method, url: url, status: res.status, ms: Date.now() - started,
        body: opt.body === undefined ? null : opt.body,
        raw: data ? undefined : text.slice(0, 400),
        data: data,
      };
      var bad = !res.ok || (data && typeof data.code === 'number' && data.code !== 200);
      if (bad) {
        var msg = (data && data.message) || ('HTTP ' + res.status);
        var err = new ApiError(msg, res.status, data);
        err.record = rec;
        diag.errors.push({ url: url, status: res.status, message: msg, at: new Date().toISOString() });
        if (diag.errors.length > 40) diag.errors.shift();
        throw err;
      }
      return data ? data.data : null;
    });
  }, function (err) {
    // 网络层失败：服务刚启动时可能还没开始监听，重试一次
    if (timer) clearTimeout(timer);
    if (attempt < 1) {
      return new Promise(function (resolve) {
        setTimeout(resolve, 700);
      }).then(function () { return requestOnce(path, opt, attempt + 1); });
    }
    var msg = (err && err.name === 'AbortError') ? '请求超时' : ('网络请求失败（' + (err && err.message) + '）');
    diag.errors.push({ url: url, status: 0, message: msg, at: new Date().toISOString() });
    if (diag.errors.length > 40) diag.errors.shift();
    throw new ApiError(msg, 0, null);
  });
}

function isAuthError(e) {
  return e && (e.status === 401 || e.status === 403);
}

/* 401/403 时不再弹全屏登录框挡住内容，而是在顶部给一条可关闭的提示，
 * 这样即便未登录也能看到「为什么看不到文件」。 */
var bannerState = { kind: '', text: '' };
function showBanner(kind, text, actions) {
  var box = $('#banner');
  if (bannerState.kind === kind && bannerState.text === text) return;
  bannerState = { kind: kind, text: text };
  box.className = kind === 'err' ? 'err' : '';
  box.innerHTML = '';
  box.appendChild(el('span', 'banner-text', text));
  (actions || []).forEach(function (a) {
    var b = el('button', 'btn ghost small', a.label);
    b.onclick = a.onClick;
    box.appendChild(b);
  });
  var close = el('button', 'icon-btn', '✕');
  close.style.cssText = 'width:30px;height:30px;margin-left:auto';
  close.onclick = function () { hideBanner(); };
  box.appendChild(close);
  box.hidden = false;
}
function hideBanner() {
  bannerState = { kind: '', text: '' };
  $('#banner').hidden = true;
}

/* ------------------------------------------------------------------ 登录 */

function loadToken() {
  var t = '';
  try { t = localStorage.getItem(LS_TOKEN) || ''; } catch (e) { /* 隐私模式 */ }
  if (!t) {
    try {
      var legacy = localStorage.getItem(LS_LEGACY_TOKEN) || '';
      if (legacy) { t = legacy; try { localStorage.setItem(LS_TOKEN, legacy); } catch (e2) { /* ignore */ } }
    } catch (e3) { /* ignore */ }
  }
  state.token = t;
}

function setToken(t) {
  state.token = t || '';
  try {
    if (t) localStorage.setItem(LS_TOKEN, t);
    else { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_LEGACY_TOKEN); }
  } catch (e) { /* ignore */ }
}

function openLogin(msg) {
  $('#login').hidden = false;
  $('#loginMsg').textContent = msg || '';
  $('#loginMsg').className = 'hint';
  setTimeout(function () { $('#loginUser').focus(); }, 60);
}

function doLogin() {
  var username = $('#loginUser').value.trim();
  var password = $('#loginPass').value;
  var btn = $('#loginBtn');
  if (!username) return;
  btn.disabled = true;
  $('#loginMsg').textContent = '正在登录…';
  request('/auth/login', { body: { username: username, password: password } })
    .then(function (data) {
      if (!data || !data.token) throw new Error('服务端未返回 token');
      setToken(data.token);
      hideBanner();
      $('#login').hidden = true;
      $('#loginPass').value = '';
      toast('登录成功');
      return refreshAll();
    })
    .catch(function (e) {
      $('#loginMsg').textContent = e.message;
      $('#loginMsg').className = 'hint err';
    })
    .then(function () { btn.disabled = false; });
}

/* ------------------------------------------------------------------ 目录读取 */

function listDir(path) {
  return request('/fs/list', {
    body: { path: path, password: '', page: 1, per_page: 0, refresh: false },
  });
}

function listDirs(path) {
  return request('/fs/dirs', { body: { path: path, password: '' } });
}

function toMedia(o, parent) {
  var kind = classify(o.name);
  if (!kind) return null;
  return {
    name: o.name,
    path: joinPath(parent, o.name),
    dir: parent,
    size: o.size,
    modified: o.modified,
    thumb: o.thumb || '',
    sign: o.sign || '',
    kind: kind,
  };
}

/* ------------------------------------------------------------------ 侧栏文件夹树 */

var treeCache = {};

function buildTreeRow(path, name, depth) {
  var wrap = el('div');
  var row = el('div', 'tree-row');
  var caret = el('button', 'tree-caret');
  caret.type = 'button';
  caret.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';
  var label = el('span', 'tree-name', name);
  var kids = el('div', 'tree-children');
  kids.hidden = true;
  row.appendChild(caret);
  row.appendChild(label);
  wrap.appendChild(row);
  wrap.appendChild(kids);

  var loaded = false;
  function toggle(force) {
    var open = force !== undefined ? force : kids.hidden;
    if (open === !kids.hidden) return Promise.resolve();
    kids.hidden = !open;
    caret.classList.toggle('open', open);
    if (!open || loaded) return Promise.resolve();
    loaded = true;
    kids.appendChild(el('div', 'tree-msg', '读取中…'));
    return loadChildren().then(function () {
      kids.innerHTML = '';
      var list = treeCache[path] || [];
      if (!list.length) {
        kids.appendChild(el('div', 'tree-msg', '没有子文件夹'));
        caret.classList.add('leaf');
        return;
      }
      list.forEach(function (d) {
        kids.appendChild(buildTreeRow(joinPath(path, d.name), d.name, depth + 1));
      });
    }).catch(function (e) {
      kids.innerHTML = '';
      var m = el('div', 'tree-msg', e.message);
      m.style.color = 'var(--danger)';
      kids.appendChild(m);
      loaded = false;
    });
  }

  function loadChildren() {
    if (treeCache[path]) return Promise.resolve(treeCache[path]);
    return listDirs(path).then(function (data) {
      var list = (data || []).slice().sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true });
      });
      treeCache[path] = list;
      return list;
    });
  }

  caret.addEventListener('click', function (ev) { ev.stopPropagation(); toggle(); });
  row.addEventListener('click', function () {
    goFolder(path);
    // 点名字同时也展开，省得必须去点那个小三角
    toggle(true);
    closeSidebar();
  });
  return wrap;
}

function renderTree() {
  var box = $('#tree');
  box.innerHTML = '';
  var root = buildTreeRow('/', '根目录', 0);
  box.appendChild(root);
  // 自动展开根目录，让用户一进来看得到文件夹（这是之前「什么都看不到」的主因之一）
  var caret = root.querySelector('.tree-caret');
  if (caret) caret.click();
}

function markTreeActive() {
  $$('#tree .tree-row').forEach(function (r) { r.classList.remove('active'); });
  $$('.menu-btn').forEach(function (b) { b.setAttribute('data-active', 'false'); });
  if (state.view === 'all') {
    $('#navAll').setAttribute('data-active', 'true');
    return;
  }
  $$('#tree .tree-row').forEach(function (r) {
    var name = r.querySelector('.tree-name');
    if (name && name.textContent === (state.path === '/' ? '根目录' : baseName(state.path))) {
      r.classList.add('active');
    }
  });
}

/* ------------------------------------------------------------------ 视图切换 */

function parseHash() {
  var h = decodeURIComponent(String(location.hash || '').replace(/^#/, ''));
  if (!h || h === '/' || h === '/all') return { view: 'all', path: '/' };
  if (h.indexOf('/p/') === 0) return { view: 'folder', path: h.slice(3) || '/' };
  return { view: 'folder', path: h };
}

function setHash(view, path) {
  var want = view === 'all' ? '#/all' : '#/p/' + encodeURIComponent(path || '/');
  if (location.hash === want) return false;
  location.hash = want;
  return true;
}

function goFolder(path) {
  if (setHash('folder', path)) return; // hashchange 会触发真正的加载
  openFolderNow(path);
}

function goAll() {
  if (setHash('all', '/')) return;
  openAllNow();
}

function openFolderNow(path) {
  stopScan();
  state.view = 'folder';
  state.path = path || '/';
  try { localStorage.setItem(LS_PATH, state.path); } catch (e) { /* ignore */ }
  markTreeActive();
  $('#albums').innerHTML = '';
  loadFolder(state.path);
}

function openAllNow() {
  state.view = 'all';
  markTreeActive();
  $('#albums').innerHTML = '';
  scanAll();
}

function refreshAll() {
  return state.view === 'all' ? scanAll() : loadFolder(state.path);
}

/* ------------------------------------------------------------------ 加载：单个文件夹 */

function loadFolder(path) {
  treeCache = treeCache || {};
  state.items = [];
  state.folders = [];
  state.rawCount = 0;
  renderHead('正在读取 ' + path);
  setProgress('读取目录中…', null);
  var started = Date.now();

  return listDir(path).then(function (data) {
    var content = (data && data.content) || [];
    state.rawCount = content.length;
    diag.list = { path: path, status: 200, count: content.length, ms: Date.now() - started, media: 0, folders: 0 };
    content.forEach(function (o) {
      if (o.is_dir) {
        state.folders.push({ name: o.name, path: joinPath(path, o.name), modified: o.modified });
      } else {
        var m = toMedia(o, path);
        if (m) state.items.push(m);
      }
    });
    state.folders.sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true });
    });
    diag.list.media = state.items.length;
    diag.list.folders = state.folders.length;
    hideBanner();
    setProgress(null);
    render();
  }).catch(function (e) {
    diag.list = {
      path: path, status: e.status || 0, count: 0, ms: Date.now() - started,
      media: 0, folders: 0, message: e.message,
      raw: e.record && e.record.raw ? e.record.raw : (e.data ? JSON.stringify(e.data).slice(0, 400) : ''),
    };
    setProgress(null);
    renderHead(path);
    $('#grid').innerHTML = '';
    renderErrorState(e);
    if (isAuthError(e)) {
      showBanner('warn', '读取失败：' + e.message + '（可能需要登录，或该账号没有此目录的权限）', [
        { label: '登录', onClick: function () { openLogin(); } },
        { label: '诊断', onClick: showDiag },
      ]);
    }
  });
}

/* ------------------------------------------------------------------ 加载：全部（递归扫描） */

function stopScan() {
  if (state.scanning) state.cancelScan = true;
  state.scanning = false;
}

function scanAll() {
  stopScan();
  state.view = 'all';
  state.items = [];
  state.folders = [];
  state.rawCount = 0;
  state.scan = { dirs: 0, media: 0, fails: [] };
  state.scanning = true;
  state.cancelScan = false;
  markTreeActive();
  var grid = $('#grid');
  grid.classList.remove('flat');
  grid.innerHTML = '';
  $('#albums').innerHTML = '';

  var queue = [{ path: '/', depth: 0 }];
  var seen = {};
  var live = { dates: {}, albums: {} };

  return new Promise(function (resolve) {
    function finish(reason) {
      state.scanning = false;
      setProgress(null);
      render();                      // 结束后做一次完整渲染，统一排序
      if (!state.items.length) renderScanEmpty(reason);
      else if (state.scan.fails.length) {
        showBanner('warn', '有 ' + state.scan.fails.length + ' 个目录读取失败，内容可能不完整（首个：' + state.scan.fails[0].path + ' — ' + state.scan.fails[0].message + '）', [
          { label: '诊断', onClick: showDiag },
        ]);
      }
      resolve();
    }

    function step() {
      if (state.cancelScan) return finish('cancel');
      if (!queue.length) return finish('done');
      if (state.scan.dirs > SCAN_MAX_DIRS) {
        state.scan.fails.push({ path: '(扫描上限)', message: '目录数超过 ' + SCAN_MAX_DIRS + '，已停止继续深入' });
        return finish('limit');
      }
      var batch = queue.splice(0, SCAN_CONCURRENCY);
      Promise.all(batch.map(function (t) {
        return listDir(t.path).then(function (data) {
          var content = (data && data.content) || [];
          var dirs = [], media = [];
          content.forEach(function (o) {
            var full = joinPath(t.path, o.name);
            if (o.is_dir) {
              if (!seen[full]) { seen[full] = 1; dirs.push({ path: full, depth: t.depth + 1 }); }
            } else {
              var m = toMedia(o, t.path);
              if (m) media.push(m);
            }
          });
          return { ok: true, path: t.path, dirs: dirs, media: media };
        }).catch(function (e) {
          return { ok: false, path: t.path, dirs: [], media: [], error: e };
        });
      })).then(function (results) {
        var added = [];
        results.forEach(function (r) {
          state.scan.dirs++;
          if (!r.ok) {
            state.scan.fails.push({ path: r.path, message: r.error.message });
            return;
          }
          queue = queue.concat(r.dirs);
          if (r.media.length) {
            state.items = state.items.concat(r.media);
            state.scan.media += r.media.length;
            added = added.concat(r.media);
          }
        });
        if (added.length) {
          appendTimeline(added, live);   // 边扫边出图，不整块重绘，避免缩略图反复闪烁
        }
        setProgress(
          '已扫描 ' + state.scan.dirs + ' 个目录，找到 ' + state.scan.media + ' 个媒体文件' + (queue.length ? '（待扫描 ' + queue.length + '）' : ''),
          queue.length
        );
        setTimeout(step, 0);   // 让出主线程，同时保证页面不可见时也能继续
      });
    }
    step();
  });
}

/* ------------------------------------------------------------------ 渲染 */

function render() {
  var list = sortItems(filterItems(state.items));
  state.visible = list;
  if (state.view === 'all') renderTimeline(list);
  else renderFolder(list);
}

function filterItems(list) {
  var out = list;
  if (state.kind !== 'all') {
    out = out.filter(function (i) { return i.kind === state.kind; });
  }
  var kw = state.keyword.trim().toLowerCase();
  if (kw) {
    out = out.filter(function (i) { return i.name.toLowerCase().indexOf(kw) >= 0; });
  }
  return out;
}

function sortItems(list) {
  var out = list.slice();
  if (state.sort === 'name') {
    out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-CN', { numeric: true }); });
  } else if (state.sort === 'size') {
    out.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
  } else {
    out.sort(function (a, b) { return String(b.modified || '').localeCompare(String(a.modified || '')); });
  }
  return out;
}

function renderHead(text, sub) {
  var t = $('#headTitle');
  if (!text) { t.classList.remove('show'); t.innerHTML = ''; return; }
  t.innerHTML = '';
  t.appendChild(document.createTextNode(text));
  if (sub) {
    t.appendChild(el('div', 'album-sub', sub));
  }
  t.classList.add('show');
}

function updateStat(list) {
  var s = $('#stat');
  var parts = [];
  if (state.view === 'all') {
    parts.push('共 ' + list.length + ' 项');
    if (state.scanning) parts.push('扫描中：' + state.scan.dirs + ' 个目录');
    else if (state.scan.dirs) parts.push('已扫描 ' + state.scan.dirs + ' 个目录');
  } else {
    parts.push('此文件夹 ' + list.length + ' 项');
    if (state.folders.length) parts.push(state.folders.length + ' 个子文件夹');
    if (state.rawCount && state.rawCount !== list.length) parts.push('目录共 ' + state.rawCount + ' 个条目');
  }
  if (state.kind !== 'all' || state.keyword) parts.push('筛选后 ' + list.length + ' 项');
  s.textContent = parts.join(' · ');
}

/* 进度条挂在 #grid 之外，避免 render() 清空 #grid 时一起被清掉 */
function setProgress(text, pending) {
  var bar = document.getElementById('progressBar');
  if (text === null || text === undefined) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = el('div', 'progress');
    bar.id = 'progressBar';
    bar.innerHTML = '<span class="txt"></span><span class="track"><i></i></span>';
    $('#grid').parentNode.insertBefore(bar, $('#grid'));
  }
  bar.querySelector('.txt').textContent = text;
  if (typeof pending === 'number' && pending > 0) {
    bar.classList.remove('indeterminate');
    var w = Math.max(4, Math.min(96, 100 / (1 + pending / 8)));
    bar.querySelector('.track i').style.width = w + '%';
  } else {
    bar.classList.add('indeterminate');
  }
}

/* ---- 时间轴（全部）：日期分组 -> 文件夹分块 -> 等高校验行 ---- */

function groupByDate(list) {
  var days = [];
  var index = {};
  list.forEach(function (it) {
    var key = dateKey(it.modified);
    var day = index[key];
    if (!day) {
      day = { key: key, label: dateLabel(key), albums: [], albumIndex: {} };
      index[key] = day;
      days.push(day);
    }
    var ak = it.dir || '/';
    var alb = day.albumIndex[ak];
    if (!alb) {
      alb = { key: ak, label: ak === '/' ? '根目录' : ak, path: ak, items: [] };
      day.albumIndex[ak] = alb;
      day.albums.push(alb);
    }
    alb.items.push(it);
  });
  days.sort(function (a, b) { return a.key < b.key ? 1 : (a.key > b.key ? -1 : 0); });
  days.forEach(function (d) {
    d.albums.sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-CN', { numeric: true }); });
  });
  return days;
}

function renderTimeline(list) {
  var grid = $('#grid');
  grid.classList.remove('flat');
  grid.innerHTML = '';
  updateStat(list);
  renderHead(null);

  if (!list.length) {
    if (state.scanning) return;
    grid.appendChild(buildEmpty());
    return;
  }

  var days = groupByDate(list);
  days.forEach(function (day) {
    var g = el('div', 'day-group');
    g.appendChild(el('div', 'day-head', day.label));
    day.albums.forEach(function (alb) {
      g.appendChild(buildAlbumBlock(alb));
    });
    grid.appendChild(g);
  });
}

function buildAlbumBlock(alb) {
  var block = el('div', 'album-block');
  var name = el('div', 'album-name', alb.label + ' · ' + alb.items.length);
  name.title = alb.path;
  name.onclick = function () { goFolder(alb.path); };
  block.appendChild(name);
  var gallery = el('div', 'gallery nested');
  alb.items.forEach(function (it) { gallery.appendChild(buildTile(it)); });
  block.appendChild(gallery);
  markLayout(gallery);
  return block;
}

/** 扫描过程中增量插入：只新增节点，不重绘已有缩略图 */
function appendTimeline(items, live) {
  var grid = $('#grid');
  if (!live || !live.albums) return render();
  items.forEach(function (it) {
    var dk = dateKey(it.modified);
    var day = live.dates[dk];
    if (!day) {
      day = { key: dk, el: el('div', 'day-group') };
      day.el.appendChild(el('div', 'day-head', dateLabel(dk)));
      // 日期倒序插入
      var before = null;
      $$('#grid .day-group').forEach(function (n) {
        if (before) return;
        var h = n.querySelector('.day-head');
        var otherKey = n.dataset.dk || '';
        if (otherKey && otherKey < dk) before = n;
      });
      day.el.dataset.dk = dk;
      if (before) grid.insertBefore(day.el, before); else grid.appendChild(day.el);
      live.dates[dk] = day;
    }
    var ak = dk + '|' + (it.dir || '/');
    var blk = live.albums[ak];
    if (!blk) {
      var alb = { label: (it.dir || '/') === '/' ? '根目录' : it.dir, path: it.dir || '/', items: [] };
      blk = buildAlbumBlock(alb);
      day.el.appendChild(blk);
      live.albums[ak] = blk;
    }
    var gallery = blk.querySelector('.gallery');
    gallery.appendChild(buildTile(it));
    markLayout(gallery);
  });
  updateStat(state.items);
}

/* ---- 文件夹视图：上方文件夹方块 + 下方等高校验行 ---- */

function renderFolder(list) {
  var grid = $('#grid');
  var albumsBox = $('#albums');
  grid.classList.add('flat');
  grid.innerHTML = '';
  albumsBox.innerHTML = '';

  var title = state.path === '/' ? '根目录' : baseName(state.path);
  var sub = state.path === '/' ? '' : state.path;
  renderHead(title, sub);
  updateStat(list);

  if (state.folders.length) {
    state.folders.forEach(function (f) {
      albumsBox.appendChild(buildAlbumBox(f));
    });
  }

  if (!list.length) {
    grid.appendChild(buildEmpty());
    return;
  }

  list.forEach(function (it) { grid.appendChild(buildTile(it)); });
  markLayout(grid);
}

function buildAlbumBox(folder) {
  var box = el('div', 'album-box');
  box.title = folder.path;
  var cover = el('div', 'cover');
  var ph = el('div', 'ph pulse');
  ph.appendChild(ICON.folder());
  cover.appendChild(ph);
  var img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  cover.appendChild(img);
  box.appendChild(cover);
  box.appendChild(el('p', null, folder.name));
  box.onclick = function () { goFolder(folder.path); };

  // 封面用该文件夹里的第一张图；没有就向上找一层子文件夹，再没有就保留文件夹图标
  if (!folder.path) return box;
  loadCover(folder.path, 2).then(function (item) {
    if (!item) { ph.classList.remove('pulse'); return; }
    img.onload = function () { img.classList.add('ready'); ph.remove(); };
    img.onerror = function () { ph.classList.remove('pulse'); };
    img.src = thumbUrl(item) || mediaUrl(item);
    return item;
  }).catch(function () { ph.classList.remove('pulse'); });
  return box;
}

function loadCover(path, depth) {
  if (state.coverCache[path] !== undefined) return Promise.resolve(state.coverCache[path]);
  if (depth <= 0) { state.coverCache[path] = null; return Promise.resolve(null); }
  return listDir(path).then(function (data) {
    var content = (data && data.content) || [];
    var firstImg = null;
    var subDir = null;
    content.forEach(function (o) {
      if (firstImg) return;
      if (o.is_dir) { if (!subDir) subDir = o.name; return; }
      if (classify(o.name) === 'image') firstImg = toMedia(o, path);
    });
    if (firstImg) { state.coverCache[path] = firstImg; return firstImg; }
    if (subDir) {
      return loadCover(joinPath(path, subDir), depth - 1).then(function (it) {
        state.coverCache[path] = it || null;
        return it || null;
      });
    }
    state.coverCache[path] = null;
    return null;
  }).catch(function () {
    state.coverCache[path] = null;
    return null;
  });
}

/* ---- 单个缩略图（等高校验行的一格） ---- */

var tileObserver = null;
function observeTile(node, start) {
  if (!('IntersectionObserver' in window)) { start(); return; }
  if (!tileObserver) {
    tileObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var fn = e.target.__start;
        if (fn) fn();
        tileObserver.unobserve(e.target);
      });
    }, { rootMargin: '700px 0px' });
  }
  node.__start = start;
  tileObserver.observe(node);
}

/* ---- 等高校验行布局 ----
 * 按宽高比把缩略图分行：除最后一行外，每行严格填满容器宽度（行高固定为 --row-h，
 * 图片用 object-fit: cover 裁切）；最后一行不足时保持自然宽度、右侧留白，
 * 这也是 Google Photos / PhotoView 的处理方式，避免单张图被拉成一条。
 * 宽高比要等图片加载完才知道，所以每次拿到真实比例就重排所在的那一块。
 */
var dirtyBlocks = [];
var layoutQueued = false;

function markLayout(galleryEl) {
  if (!galleryEl || !galleryEl.classList) return;
  if (dirtyBlocks.indexOf(galleryEl) < 0) dirtyBlocks.push(galleryEl);
  if (layoutQueued) return;
  layoutQueued = true;
  // 用定时器而不是 requestAnimationFrame：页面不可见（后台标签页/息屏）时
  // rAF 不会触发，布局就会一直卡在待办里。
  setTimeout(function () {
    layoutQueued = false;
    var list = dirtyBlocks;
    dirtyBlocks = [];
    list.forEach(layoutBlock);
  }, 0);
}

function ratioOf(tile) {
  var r = Number(tile.dataset.ratio);
  return (r > 0.05 && r < 20) ? r : 1.5;
}

function layoutBlock(galleryEl) {
  if (!galleryEl || !galleryEl.isConnected) return;
  var tiles = Array.prototype.filter.call(galleryEl.children, function (n) {
    return n.classList && n.classList.contains('tile');
  });
  if (!tiles.length) return;
  var W = galleryEl.clientWidth;
  if (!W) return;
  var H = state.rowH;
  var GAP = 4;             // .tile 左右各 2px margin
  var rows = [];
  var cur = [];
  var sum = 0;
  for (var i = 0; i < tiles.length; i++) {
    cur.push(i);
    sum += ratioOf(tiles[i]);
    var avail = W - GAP * cur.length;
    if (sum > 0 && avail / sum <= H) {
      rows.push(cur);
      cur = [];
      sum = 0;
    }
  }
  if (cur.length) rows.push(cur);

  rows.forEach(function (row, ri) {
    var avail = W - GAP * row.length - 1;   // 留 1px 余量，避免亚像素多换一行
    var s = 0;
    row.forEach(function (idx) { s += ratioOf(tiles[idx]); });
    var isLast = (ri === rows.length - 1);
    // 满行按剩余宽度等比铺满；最后一行也尽量铺满，但最多放大到 1.3 倍行高，
    // 免得单张图被拉成一条横幅（那种情况下宁可右侧留白）。
    var rowH = Math.min(isLast ? H * 1.3 : H, avail / s);
    row.forEach(function (idx) {
      var t = tiles[idx];
      t.style.width = Math.max(72, Math.round(ratioOf(t) * rowH)) + 'px';
      t.style.height = Math.round(rowH) + 'px';
    });
  });
}

function relayoutAll() {
  $$('#grid, .gallery.nested').forEach(function (g) { markLayout(g); });
}

function buildTile(item) {
  var tile = el('div', 'tile');
  tile.tabIndex = 0;
  tile.dataset.ratio = String(item.kind === 'video' ? 16 / 9 : 3 / 2);
  tile.dataset.path = item.path;

  var ph = el('div', 'ph');
  ph.appendChild(item.kind === 'video' ? ICON.play() : ICON.image());
  ph.appendChild(el('div', 'ext', ext(item.name) || item.kind));
  tile.appendChild(ph);

  if (item.kind === 'image') {
    var img = document.createElement('img');
    img.alt = item.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onload = function () {
      tile.classList.add('loaded');
      if (img.naturalWidth && img.naturalHeight) {
        tile.dataset.ratio = String(img.naturalWidth / img.naturalHeight);
        markLayout(tile.parentNode);
      }
      ph.remove();
    };
    img.onerror = function () {
      ph.innerHTML = '';
      ph.appendChild(ICON.image());
      ph.appendChild(el('div', 'ext', '无法加载'));
    };
    tile.appendChild(img);
    img.src = thumbUrl(item) || mediaUrl(item);
  } else {
    var video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'none';
    video.setAttribute('muted', '');
    var started = false;
    var start = function () {
      if (started) return;
      started = true;
      video.preload = 'metadata';
      // 取第一帧当封面（#t 片段会让浏览器解码到指定时间点）
      video.src = mediaUrl(item) + '#t=0.1';
    };
    video.onloadeddata = function () {
      tile.classList.add('loaded');
      if (video.videoWidth && video.videoHeight) {
        tile.dataset.ratio = String(video.videoWidth / video.videoHeight);
        markLayout(tile.parentNode);
      }
      ph.remove();
    };
    video.onerror = function () {
      ph.innerHTML = '';
      ph.appendChild(ICON.play());
      ph.appendChild(el('div', 'ext', ext(item.name) || 'video'));
    };
    if (item.thumb) {
      var cov = document.createElement('img');
      cov.alt = item.name;
      cov.loading = 'lazy';
      cov.onload = function () { tile.classList.add('loaded'); ph.remove(); };
      tile.appendChild(cov);
      cov.src = thumbUrl(item);
      observeTile(tile, start);
    } else {
      tile.appendChild(video);
      observeTile(tile, start);
    }

    var play = el('div', 'play');
    play.appendChild(ICON.play());
    tile.appendChild(play);

    var corner = el('div', 'corner', ext(item.name) || 'video');
    tile.appendChild(corner);
  }

  var acts = el('div', 'acts');
  var bOpen = el('button');
  bOpen.title = '在新标签页打开';
  bOpen.appendChild(ICON.open());
  bOpen.onclick = function (e) { e.stopPropagation(); window.open(absUrl(item), '_blank', 'noopener'); };
  var bMore = el('button');
  bMore.title = '更多操作';
  bMore.appendChild(ICON.more());
  bMore.onclick = function (e) {
    e.stopPropagation();
    var r = bMore.getBoundingClientRect();
    openItemMenu(item, r.right - 6, r.bottom + 4);
  };
  acts.appendChild(bOpen);
  acts.appendChild(bMore);
  tile.appendChild(acts);

  tile.onclick = function () { if (Date.now() < suppressClickUntil) return; openViewerAt(item); };
  tile.oncontextmenu = function (e) { e.preventDefault(); openItemMenu(item, e.clientX, e.clientY); };
  attachLongPress(tile, item);
  return tile;
}

function buildEmpty() {
  var box = el('div', 'empty');
  if (state.view === 'all') {
    box.innerHTML = '<b>没有找到图片或视频</b>';
    var hint = el('div', 'hint');
    if (state.scanning) {
      hint.textContent = '正在扫描…';
    } else if (state.scan.fails.length) {
      hint.textContent = '有 ' + state.scan.fails.length + ' 个目录读取失败，多半是权限或网络问题。点「诊断」看具体原因。';
    } else if (state.kind !== 'all' || state.keyword) {
      hint.textContent = '当前有筛选条件，试试切回「全部」或清空搜索。';
    } else {
      hint.textContent = '已扫描 ' + state.scan.dirs + ' 个目录。若手机里确实有照片，请到「挂载管理」确认存储是否正常，或点「诊断」查看接口返回。';
    }
    box.appendChild(hint);
    var acts = el('div');
    acts.style.marginTop = '14px';
    var b1 = el('button', 'btn ghost small', '诊断');
    b1.onclick = showDiag;
    acts.appendChild(b1);
    box.appendChild(acts);
  } else {
    if (state.folders.length) box.classList.add('compact');
    box.innerHTML = '<b>这个文件夹里没有图片或视频</b>';
    var h2 = el('div', 'hint');
    var nonMedia = state.rawCount - state.items.length - state.folders.length;
    var bits = [];
    if (state.rawCount) bits.push('接口返回 ' + state.rawCount + ' 个条目');
    if (state.folders.length) bits.push('其中 ' + state.folders.length + ' 个子文件夹（见上方）');
    if (nonMedia > 0) bits.push(nonMedia + ' 个非图片/视频文件已忽略');
    h2.textContent = bits.join('，') + '。';
    box.appendChild(h2);
    if (state.folders.length) {
      var h3 = el('div', 'hint');
      h3.textContent = '请点上面的文件夹继续往下看。';
      box.appendChild(h3);
    }
  }
  return box;
}

function renderScanEmpty(reason) {
  var grid = $('#grid');
  grid.innerHTML = '';
  var box = buildEmpty();
  if (state.scan.fails.length) {
    var pre = el('pre', 'diag-pre');
    pre.textContent = state.scan.fails.slice(0, 8).map(function (f) {
      return f.path + '  →  ' + f.message;
    }).join('\n');
    box.appendChild(pre);
  }
  grid.appendChild(box);
}

function renderErrorState(e) {
  var grid = $('#grid');
  grid.innerHTML = '';
  var box = el('div', 'empty');
  box.innerHTML = '<b>读取失败</b>';
  box.appendChild(el('div', 'hint', e.message + (e.status ? '（HTTP ' + e.status + '）' : '')));
  var acts = el('div');
  acts.style.marginTop = '14px';
  var b1 = el('button', 'btn ghost small', '诊断');
  b1.onclick = showDiag;
  acts.appendChild(b1);
  if (isAuthError(e)) {
    var b2 = el('button', 'btn ghost small', '登录');
    b2.onclick = function () { openLogin(e.message); };
    b2.style.marginLeft = '8px';
    acts.appendChild(b2);
  }
  box.appendChild(acts);
  grid.appendChild(box);
}

/* ------------------------------------------------------------------ 查看器 */

var viewerTimer = null;

function openViewerAt(item) {
  var list = state.visible && state.visible.length ? state.visible : state.items;
  var i = list.indexOf(item);
  if (i < 0) {
    list = state.items;
    i = list.indexOf(item);
  }
  state.viewerList = list.slice();
  openViewer(i);
}

function openViewer(index) {
  var list = state.viewerList;
  if (index < 0 || index >= list.length) return;
  state.viewerIndex = index;
  var item = list[index];
  var viewer = $('#viewer');
  viewer.hidden = false;
  document.body.style.overflow = 'hidden';

  $('#vTitle').textContent = item.name + '  ·  ' + fmtSize(item.size);

  var stage = $('#vStage');
  stage.innerHTML = '';
  if (item.kind === 'image') {
    var img = document.createElement('img');
    img.alt = item.name;
    img.src = mediaUrl(item);
    stage.appendChild(img);
  } else {
    var video = document.createElement('video');
    video.src = mediaUrl(item);
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    stage.appendChild(video);
    var e = ext(item.name);
    if (NATIVE_VID.indexOf(e) < 0) {
      stage.appendChild(el('div', 'v-tip', '该容器（' + e + '）浏览器多半不支持，若无法播放请直接下载'));
    }
    video.onerror = function () {
      var tip = el('div', 'v-tip', '无法播放该文件，请下载后用本地播放器打开');
      stage.appendChild(tip);
    };
  }

  $('#vPrev').disabled = index <= 0;
  $('#vNext').disabled = index >= list.length - 1;
  revealViewerControls();
}

function viewerStep(step) {
  var i = state.viewerIndex + step;
  if (i < 0 || i >= state.viewerList.length) return;
  openViewer(i);
}

function closeViewer() {
  var v = $('#vStage video');
  if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ } }
  $('#vStage').innerHTML = '';
  $('#viewer').hidden = true;
  state.viewerIndex = -1;
  state.viewerList = [];
  document.body.style.overflow = '';
  clearTimeout(viewerTimer);
}

function revealViewerControls() {
  var top = $('#vTop');
  top.classList.remove('hide');
  clearTimeout(viewerTimer);
  viewerTimer = setTimeout(function () {
    if (!$('#viewer').hidden) top.classList.add('hide');
  }, 2500);
}

/* ------------------------------------------------------------------ 复制 / 右键菜单 */

var suppressClickUntil = 0;

async function copyText(text, okMsg) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast(okMsg || '已复制');
      return true;
    }
  } catch (e) { /* 走兜底 */ }
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = document.execCommand('copy');
    ta.remove();
    if (ok) { toast(okMsg || '已复制'); return true; }
  } catch (e2) { /* 走兜底 */ }
  // 通过 http://局域网IP 访问时不是安全上下文，剪贴板 API 不可用，退化为手动复制
  window.prompt('自动复制失败，请长按选中后复制：', text);
  return false;
}

function hideCtxMenu() {
  var m = $('#ctxMenu');
  if (m) m.hidden = true;
}

function showCtxMenu(x, y, items, headText) {
  var menu = $('#ctxMenu');
  menu.innerHTML = '';
  if (headText) menu.appendChild(el('div', 'ctx-head', headText));
  items.forEach(function (it) {
    if (it.sep) { menu.appendChild(el('div', 'ctx-sep')); return; }
    var b = el('button', 'ctx-item' + (it.danger ? ' danger' : ''), it.label);
    b.onclick = function () { hideCtxMenu(); it.onClick(); };
    menu.appendChild(b);
  });
  menu.hidden = false;
  var r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 10)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 10)) + 'px';
}

function openItemMenu(item, x, y) {
  if (!item) return;
  var abs = absUrl(item);
  showCtxMenu(x, y, [
    { label: '复制下载链接', onClick: function () { copyText(abs, '下载链接已复制'); } },
    { label: '复制文件名', onClick: function () { copyText(item.name, '文件名已复制'); } },
    { label: '复制 Markdown', onClick: function () { copyText('[' + item.name + '](' + abs + ')', 'Markdown 已复制'); } },
    { sep: true },
    { label: '在新标签页打开', onClick: function () { window.open(abs, '_blank', 'noopener'); } },
    { label: '下载', onClick: function () { downloadItem(item, abs); } },
  ], item.name);
}

function downloadItem(item, url) {
  var a = document.createElement('a');
  a.href = url;
  a.download = item.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function attachLongPress(node, item) {
  var timer = null, sx = 0, sy = 0;
  function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
  node.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    cancel();
    timer = setTimeout(function () {
      suppressClickUntil = Date.now() + 900;
      openItemMenu(item, sx, sy);
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e2) { /* ignore */ } }
    }, 500);
  }, { passive: true });
  node.addEventListener('touchmove', function (e) {
    if (!e.touches.length) return;
    if (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10) cancel();
  }, { passive: true });
  node.addEventListener('touchend', cancel, { passive: true });
  node.addEventListener('touchcancel', cancel, { passive: true });
}

/* ------------------------------------------------------------------ 上传 */

function uploadTarget() {
  return state.view === 'all' ? null : (state.path || '/');
}

function pickAndUpload() {
  if (uploadTarget() === null) {
    toast('「全部」视图下无法上传，请先进入某个文件夹');
    return;
  }
  $('#filePicker').click();
}

function uploadFiles(files) {
  var dir = uploadTarget();
  if (!dir || !files.length) return;
  var total = files.length, done = 0, failed = 0;
  toast('开始上传 ' + total + ' 个文件…', 3000);
  Array.prototype.forEach.call(files, function (f) {
    var dest = joinPath(dir, f.name);
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', API + '/fs/put', true);
    if (state.token) xhr.setRequestHeader('Authorization', state.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('File-Path', encodeURIComponent(dest));
    function settle(ok) {
      done++;
      if (!ok) failed++;
      if (done === total) {
        toast(failed ? '上传结束：成功 ' + (total - failed) + ' 个，失败 ' + failed + ' 个' : '已上传 ' + total + ' 个文件', 4000);
        refreshAll();
      }
    }
    xhr.onload = function () { settle(xhr.status >= 200 && xhr.status < 300); };
    xhr.onerror = function () { settle(false); };
    xhr.onabort = function () { settle(false); };
    xhr.send(f);
  });
}

/* ------------------------------------------------------------------ 诊断 */

function row(k, v, cls) {
  var r = el('div', 'diag-row');
  r.appendChild(el('div', 'k', k));
  var val = el('div', 'v' + (cls ? ' ' + cls : ''));
  if (v instanceof Node) val.appendChild(v); else val.textContent = v;
  r.appendChild(val);
  return r;
}

function showDiag() {
  $('#diag').hidden = false;
  runDiag();
}

function runDiag() {
  var body = $('#diagBody');
  body.innerHTML = '';
  body.appendChild(el('div', 'diag-sec', '站点'));
  body.appendChild(el('div', 'hint', '正在检测…'));

  var settingsP = request('/public/settings', { method: 'GET' }).catch(function (e) { return { __err: e }; });
  var meP = state.token ? request('/me', { method: 'GET' }).catch(function (e) { return { __err: e }; }) : Promise.resolve(null);
  var stP = state.token ? request('/admin/storage/list', { method: 'GET' }).catch(function (e) { return { __err: e }; }) : Promise.resolve(null);

  Promise.all([settingsP, meP, stP]).then(function (res) {
    var settings = res[0], me = res[1], storages = res[2];
    body.innerHTML = '';

    body.appendChild(el('div', 'diag-sec', '站点'));
    if (settings && settings.__err) {
      body.appendChild(row('站点信息', settings.__err.message, 'diag-bad'));
    } else {
      body.appendChild(row('标题', (settings && settings.site_title) || '(未设置)'));
      body.appendChild(row('版本', (settings && settings.version) || '-'));
    }
    body.appendChild(row('接口前缀', API));
    body.appendChild(row('文件前缀', MEDIA));

    body.appendChild(el('div', 'diag-sec', '登录状态'));
    body.appendChild(row('本地 token', state.token ? '有（' + state.token.slice(0, 12) + '…）' : '无', state.token ? 'diag-ok' : 'diag-bad'));
    if (me && me.__err) {
      body.appendChild(row('/api/me', me.__err.message + (me.__err.status ? '（HTTP ' + me.__err.status + '）' : ''), 'diag-bad'));
    } else if (!me) {
      body.appendChild(row('/api/me', '未请求（没有 token）', 'diag-bad'));
    } else {
      body.appendChild(row('用户名', me.username || '-'));
      var roleName = me.role === 2 ? '管理员' : (me.role === 1 ? '普通用户' : '访客');
      body.appendChild(row('角色', roleName + '（role=' + me.role + '）', me.role === 0 ? 'diag-bad' : 'diag-ok'));
      if (me.base_path && me.base_path !== '/') body.appendChild(row('用户根目录', me.base_path));
      if (me.disabled) body.appendChild(row('账号状态', '已禁用', 'diag-bad'));
    }

    body.appendChild(el('div', 'diag-sec', '存储挂载'));
    var list = storages && !storages.__err ? ((storages.content) || []) : null;
    if (storages && storages.__err) {
      body.appendChild(row('读取失败', storages.__err.message + '（' + storages.__err.status + '）', 'diag-bad'));
      body.appendChild(el('div', 'hint', '若不是管理员账号，这里读不到存储列表是正常的。'));
    } else if (list) {
      if (!list.length) {
        body.appendChild(row('数量', '0 个', 'diag-bad'));
        body.appendChild(el('div', 'hint', '没有任何挂载，所以看不到文件。点右上角齿轮（挂载管理）添加一个「本地存储」，根目录一般填 /storage/emulated/0。'));
      } else {
        body.appendChild(row('数量', list.length + ' 个'));
        list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).forEach(function (s) {
          var txt = (s.mount_path || '/') + '  ·  ' + (s.driver || '?') +
            (s.disabled ? '  ·  已停用' : '  ·  ' + (s.status || 'work')) +
            (s.enable_sign ? '  ·  签名开启' : '');
          body.appendChild(row('挂载', txt, s.disabled || s.status === 'error' ? 'diag-bad' : 'diag-ok'));
        });
      }
    } else {
      body.appendChild(row('存储列表', '未登录，未请求', 'diag-bad'));
    }

    body.appendChild(el('div', 'diag-sec', '最近一次目录读取'));
    var L = diag.list;
    if (!L) {
      body.appendChild(el('div', 'hint', '还没有发起过读取。'));
    } else {
      body.appendChild(row('路径', L.path));
      body.appendChild(row('HTTP', String(L.status), L.status === 200 ? 'diag-ok' : 'diag-bad'));
      body.appendChild(row('耗时', L.ms + ' ms'));
      body.appendChild(row('条目数', String(L.count)));
      body.appendChild(row('子文件夹', String(L.folders)));
      body.appendChild(row('图片/视频', String(L.media)));
      if (L.message) body.appendChild(row('错误', L.message, 'diag-bad'));
      if (L.raw) body.appendChild(el('pre', 'diag-pre', L.raw));
    }

    if (state.scan.dirs) {
      body.appendChild(el('div', 'diag-sec', '扫描统计'));
      body.appendChild(row('已扫描目录', String(state.scan.dirs)));
      body.appendChild(row('命中媒体', String(state.scan.media)));
      body.appendChild(row('失败目录', String(state.scan.fails.length), state.scan.fails.length ? 'diag-bad' : 'diag-ok'));
      if (state.scan.fails.length) {
        body.appendChild(el('pre', 'diag-pre', state.scan.fails.slice(0, 10).map(function (f) {
          return f.path + '  →  ' + f.message;
        }).join('\n')));
      }
    }

    if (diag.errors.length) {
      body.appendChild(el('div', 'diag-sec', '最近的接口错误'));
      body.appendChild(el('pre', 'diag-pre', diag.errors.slice(-8).map(function (e) {
        return e.status + '  ' + e.url + '  →  ' + e.message;
      }).join('\n')));
    }
  });
}

/* ------------------------------------------------------------------ 挂载管理 */

var DRIVER_TEMPLATE = {
  Local: { root_folder_path: '/storage/emulated/0', thumbnail: false, thumb_cache_folder: '', show_hidden: true, mkdir_perm: '777', recycle_bin_path: 'delete permanently' },
  SMB: { host: '', username: '', password: '', share_name: '', root_folder_path: '/' },
  SFTP: { host: '', username: '', password: '', private_key: '', passphrase: '', root_folder_path: '/' },
  WebDAV: { url: '', username: '', password: '', vendor: 'other', root_folder_path: '/' },
};
var DRIVER_HINT = {
  Local: 'root_folder_path 填手机上的绝对路径，例如 /storage/emulated/0（内置存储根目录）或 /storage/emulated/0/DCIM。',
  SMB: 'host 形如 192.168.1.9:445，share_name 填共享名（不是路径）。',
  SFTP: 'host 形如 192.168.1.9:22，可填密码或 private_key。',
  WebDAV: 'url 填完整地址，例如 https://example.com/dav。',
};
var editingId = 0;

function openAdmin() {
  $('#admin').hidden = false;
  refreshStorages();
}

function refreshStorages() {
  var box = $('#storageList');
  box.innerHTML = '';
  box.appendChild(el('div', 'hint', '读取中…'));
  request('/admin/storage/list', { method: 'GET' }).then(function (data) {
    var list = (data && data.content) || [];
    box.innerHTML = '';
    if (!list.length) {
      box.appendChild(el('div', 'hint', '还没有挂载任何存储。没有存储就看不到任何文件，请在下面新增一个。'));
      return;
    }
    list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    list.forEach(function (s) {
      var item = el('div', 'storage-item');
      var top = el('div', 'top');
      top.appendChild(el('span', 'nm', s.mount_path || '/'));
      top.appendChild(el('span', 'pill', s.driver || ''));
      top.appendChild(el('span', 'pill ' + (s.disabled ? 'off' : 'on'), s.disabled ? '已停用' : (s.status || 'work')));
      if (s.enable_sign) top.appendChild(el('span', 'pill', '签名'));
      var acts = el('span', 'acts');
      var bEdit = el('button', 'btn ghost small', '编辑');
      bEdit.onclick = function () { fillForm(s); };
      var bToggle = el('button', 'btn ghost small', s.disabled ? '启用' : '停用');
      bToggle.onclick = function () {
        request('/admin/storage/' + (s.disabled ? 'enable' : 'disable'), { body: { id: s.id } })
          .then(function () { toast(s.disabled ? '已启用' : '已停用'); refreshStorages(); })
          .catch(function (e) { toast(e.message); });
      };
      var bDel = el('button', 'btn ghost small danger', '删除');
      bDel.onclick = function () {
        if (!confirm('确认删除挂载「' + (s.mount_path || '/') + '」？不会删除源文件。')) return;
        request('/admin/storage/delete', { body: { id: s.id } })
          .then(function () { toast('已删除'); refreshStorages(); })
          .catch(function (e) { toast(e.message); });
      };
      acts.appendChild(bEdit); acts.appendChild(bToggle); acts.appendChild(bDel);
      top.appendChild(acts);
      item.appendChild(top);
      var sub = el('div', 'sub', '顺序 ' + (s.order || 0) + (s.addition ? ' · ' + s.addition : ''));
      item.appendChild(sub);
      box.appendChild(item);
    });
  }).catch(function (e) {
    box.innerHTML = '';
    box.appendChild(el('div', 'hint err', '读取存储列表失败：' + e.message + '（需要管理员账号）'));
  });
}

function fillForm(s) {
  editingId = s.id || 0;
  $('#stFormTitle').textContent = editingId ? ('编辑挂载 ' + (s.mount_path || '')) : '新增挂载';
  $('#stDriver').value = s.driver || 'Local';
  $('#stMount').value = s.mount_path || '/';
  $('#stOrder').value = s.order || 0;
  $('#stSign').checked = !!s.enable_sign;
  var add = s.addition || '';
  try {
    var obj = JSON.parse(add);
    $('#stAddition').value = JSON.stringify(obj, null, 2);
  } catch (e) {
    $('#stAddition').value = add || JSON.stringify(DRIVER_TEMPLATE[s.driver || 'Local'], null, 2);
  }
  onDriverChange();
  window.scrollTo(0, 0);
  $('#admin').querySelector('.sheet-body').scrollTop = 99999;
}

function onDriverChange() {
  var d = $('#stDriver').value;
  $('#stDriverHint').textContent = DRIVER_HINT[d] || '';
  if (!editingId) {
    $('#stAddition').value = JSON.stringify(DRIVER_TEMPLATE[d] || {}, null, 2);
  }
  $('#stSchema').innerHTML = '';
}

function saveStorage() {
  var driver = $('#stDriver').value;
  var addition = $('#stAddition').value.trim();
  if (addition) {
    try { addition = JSON.stringify(JSON.parse(addition)); } catch (e) {
      toast('配置不是合法 JSON：' + e.message, 4000);
      return;
    }
  } else {
    addition = '{}';
  }
  var payload = {
    id: editingId || undefined,
    mount_path: ($('#stMount').value.trim() || '/'),
    order: Number($('#stOrder').value || 0),
    driver: driver,
    addition: addition,
    enable_sign: $('#stSign').checked,
    disabled: false,
    remark: '',
  };
  var path = editingId ? '/admin/storage/update' : '/admin/storage/create';
  request(path, { body: payload }).then(function () {
    toast(editingId ? '已保存' : '已添加');
    editingId = 0;
    $('#stFormTitle').textContent = '新增挂载';
    refreshStorages();
    loadMeAndStorages();
    treeCache = {};
    renderTree();
  }).catch(function (e) {
    toast('保存失败：' + e.message, 4000);
  });
}

function showSchema() {
  var d = $('#stDriver').value;
  var box = $('#stSchema');
  box.innerHTML = '';
  box.appendChild(el('div', 'hint', '读取字段说明…'));
  request('/admin/driver/info', { method: 'GET', query: { driver: d } }).then(function (items) {
    box.innerHTML = '';
    if (!items || !items.length) {
      box.appendChild(el('div', 'hint', '该驱动没有额外字段。'));
      return;
    }
    var table = el('table');
    var head = el('tr');
    ['字段', '类型', '默认值', '说明'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    items.forEach(function (it) {
      var tr = el('tr');
      var c1 = el('td'); c1.appendChild(el('code', null, it.name || '')); tr.appendChild(c1);
      tr.appendChild(el('td', null, it.type || ''));
      tr.appendChild(el('td', null, it.default === undefined ? '' : String(it.default)));
      var help = (it.help || '') + (it.required ? '（必填）' : '');
      tr.appendChild(el('td', null, help));
      table.appendChild(tr);
    });
    box.appendChild(table);
  }).catch(function (e) {
    box.innerHTML = '';
    box.appendChild(el('div', 'hint err', '读取失败：' + e.message));
  });
}

/* ------------------------------------------------------------------ 侧栏开关 */

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#scrim').classList.add('show');
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('show');
}

/* ------------------------------------------------------------------ 启动 */

function loadMeAndStorages() {
  if (!state.token) {
    return Promise.resolve(null);
  }
  return request('/me', { method: 'GET' }).then(function (me) {
    state.me = me;
    return request('/admin/storage/list', { method: 'GET' }).then(function (data) {
      var list = (data && data.content) || [];
      diag.storages = list;
      if (!list.length) {
        showBanner('warn', '当前没有任何存储挂载，所以看不到文件。', [
          { label: '挂载管理', onClick: openAdmin },
        ]);
      }
      return list;
    }).catch(function () { return null; });
  }).catch(function (e) {
    if (isAuthError(e)) {
      setToken('');
      showBanner('warn', '登录已失效，请重新登录。', [{ label: '登录', onClick: function () { openLogin(); } }]);
    }
    return null;
  });
}

function bindUi() {
  $('#navAll').onclick = function () { goAll(); closeSidebar(); };
  $('#navSettings').onclick = function () { openAdmin(); closeSidebar(); };
  $('#btnAdmin').onclick = openAdmin;
  $('#btnMenu').onclick = openSidebar;
  $('#scrim').onclick = closeSidebar;
  $('#btnDiag').onclick = showDiag;
  $('#diagRerun').onclick = runDiag;
  $('#diagLogout').onclick = function () {
    setToken('');
    state.me = null;
    $('#diag').hidden = true;
    showBanner('warn', '已退出登录。', [{ label: '登录', onClick: function () { openLogin(); } }]);
    refreshAll();
  };
  $('#loginBtn').onclick = doLogin;
  $('#loginPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('#stDriver').addEventListener('change', onDriverChange);
  $('#stSchemaBtn').onclick = showSchema;
  $('#stSave').onclick = saveStorage;
  $('#stCancel').onclick = function () {
    editingId = 0;
    $('#stFormTitle').textContent = '新增挂载';
    $('#stMount').value = '/';
    $('#stOrder').value = 0;
    $('#stSign').checked = false;
    onDriverChange();
  };

  $$('[data-close]').forEach(function (b) {
    b.onclick = function () { $('#' + b.dataset.close).hidden = true; };
  });

  $('#btnUpload').onclick = pickAndUpload;
  $('#filePicker').addEventListener('change', function (e) {
    uploadFiles(e.target.files);
    e.target.value = '';
  });

  $('#btnRefresh').onclick = function () {
    treeCache = {};
    refreshAll();
  };

  $$('#segKind button').forEach(function (b) {
    b.onclick = function () {
      state.kind = b.dataset.kind;
      $$('#segKind button').forEach(function (x) { x.setAttribute('data-active', String(x === b)); });
      render();
    };
  });

  $('#sortSel').value = state.sort;
  $('#sortSel').onchange = function () {
    state.sort = $('#sortSel').value;
    try { localStorage.setItem(LS_SORT, state.sort); } catch (e) { /* ignore */ }
    render();
  };

  $('#sizeSel').value = String(state.rowH);
  $('#sizeSel').onchange = function () {
    state.rowH = Number($('#sizeSel').value) || 200;
    try { localStorage.setItem(LS_ROW, String(state.rowH)); } catch (e) { /* ignore */ }
    applyRowH();
  };

  var kwTimer = null;
  $('#searchInput').addEventListener('input', function (e) {
    clearTimeout(kwTimer);
    var v = e.target.value;
    kwTimer = setTimeout(function () { state.keyword = v; render(); }, 180);
  });

  // 查看器
  $('#vClose').onclick = closeViewer;
  $('#vPrev').onclick = function () { viewerStep(-1); };
  $('#vNext').onclick = function () { viewerStep(1); };
  $('#vCopy').onclick = function () {
    var item = state.viewerList[state.viewerIndex];
    if (item) copyText(absUrl(item), '下载链接已复制');
  };
  $('#vMore').onclick = function () {
    var item = state.viewerList[state.viewerIndex];
    if (!item) return;
    var r = $('#vMore').getBoundingClientRect();
    openItemMenu(item, r.right - 6, r.bottom + 6);
  };
  $('#viewer').addEventListener('mousemove', revealViewerControls);
  $('#viewer').addEventListener('click', function (e) {
    if (e.target === $('#viewer') || e.target === $('#vStage')) closeViewer();
    else revealViewerControls();
  });

  // 查看器滑动切换
  var tsX = 0, tsY = 0, tsT = 0;
  $('#viewer').addEventListener('touchstart', function (e) {
    revealViewerControls();
    if (e.touches.length !== 1) return;
    tsX = e.touches[0].clientX; tsY = e.touches[0].clientY; tsT = Date.now();
  }, { passive: true });
  $('#viewer').addEventListener('touchend', function (e) {
    if (!tsT) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - tsX, dy = t.clientY - tsY;
    tsT = 0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      viewerStep(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (!$('#viewer').hidden) {
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') viewerStep(-1);
      else if (e.key === 'ArrowRight') viewerStep(1);
      else revealViewerControls();
      return;
    }
    if (e.key === '/' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      var s = $('#searchInput');
      if (s && s.offsetParent !== null) s.focus();
    }
    if (e.key === 'Escape') { hideCtxMenu(); hideBanner(); }
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('#ctxMenu')) hideCtxMenu();
  });
  window.addEventListener('resize', function () {
    hideCtxMenu();
    clearTimeout(bindUi._rt);
    bindUi._rt = setTimeout(relayoutAll, 160);
  });
  window.addEventListener('scroll', hideCtxMenu, true);

  window.addEventListener('hashchange', function () {
    var r = parseHash();
    if (r.view === 'all') openAllNow(); else openFolderNow(r.path);
  });
}

function applyRowH() {
  document.documentElement.style.setProperty('--row-h', state.rowH + 'px');
  relayoutAll();
}

function boot() {
  applyTheme();
  loadToken();
  try {
    state.kind = localStorage.getItem(LS_KIND) || 'all';
    state.sort = localStorage.getItem(LS_SORT) || 'date';
    var rh = Number(localStorage.getItem(LS_ROW));
    state.rowH = rh >= 120 && rh <= 480 ? rh : 200;
  } catch (e) { /* ignore */ }
  applyRowH();
  $('#sortSel').value = state.sort;
  $('#sizeSel').value = String(state.rowH);
  $$('#segKind button').forEach(function (b) {
    b.setAttribute('data-active', String(b.dataset.kind === state.kind));
  });

  bindUi();

  if (!location.hash) {
    // 首次进入默认落在「全部」，让用户马上看到东西；hashchange 会负责触发加载
    location.replace('#/all');
  } else {
    var p0 = parseHash();
    if (p0.view === 'all') openAllNow(); else openFolderNow(p0.path);
  }

  request('/public/settings', { method: 'GET' }).then(function (s) {
    state.settings = s || {};
    var title = (s && s.site_title) || '图库';
    document.title = title;
    var bt = $('#brandText');
    if (bt) bt.textContent = title;
    var b = document.querySelector('.boot-text');
    if (b) b.textContent = title;
    // logo 地址由后端把 index.html 里的占位 URL 换成站点设置，这里不再覆盖，
    // 只兜底：站点没配 logo 时不要把标题旁边留一个碎图标。
    var logoEl = $('#brandLogo');
    if (logoEl && (!logoEl.getAttribute('src') || logoEl.naturalWidth === 0)) {
      logoEl.addEventListener('error', function () { logoEl.style.display = 'none'; });
    }
  }).catch(function () { /* 站点信息拿不到不影响使用 */ });

  loadMeAndStorages();
  renderTree();

  setTimeout(function () {
    var boot = $('#boot');
    if (boot) { boot.classList.add('gone'); setTimeout(function () { boot.remove(); }, 300); }
    state.booted = true;
  }, 220);

  // 方便排查：地址栏加 ?diag=1 可直接打开诊断面板
  try {
    if (/(^|[?&])diag=1/.test(location.search)) setTimeout(showDiag, 400);
  } catch (e) { /* ignore */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
