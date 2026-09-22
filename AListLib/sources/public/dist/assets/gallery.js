/* AListLite 图库前端
 * 只面向图片与视频：浏览、预览、在线播放、上传与下载
 *
 * CONFIG（base_path / cdn）由 index.html 里的占位符定义，
 * 后端 server/static/static.go 的 initIndex() 会在返回 index.html 前
 * 把它们替换成真实值，因此这里直接读 window.CONFIG 即可。
 */
const CONFIG = window.CONFIG || { base_path: '/' };

const BASE = (typeof CONFIG.base_path === 'string' ? CONFIG.base_path : '/').replace(/\/+$/, '');
const API = BASE + '/api';
const MEDIA = BASE + '/d';

const IMG_EXT = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif', 'tif', 'tiff', 'ico'];
const VID_EXT = ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp', 'rmvb', 'asf'];
// 浏览器普遍能直接播的容器；其余容器仍然尝试播放，失败后提示下载
const NATIVE_VID_EXT = ['mp4', 'm4v', 'webm', 'ogv', 'mov'];

const LS_TOKEN = 'alistlite.token';
const LS_PATH = 'alistlite.path';
const LS_DEPTH = 'alistlite.depth';
const LS_DENSE = 'alistlite.dense';

const state = {
  token: localStorage.getItem(LS_TOKEN) || '',
  siteTitle: '图库',
  path: localStorage.getItem(LS_PATH) || '/',
  allMode: false,
  depth: Number(localStorage.getItem(LS_DEPTH) || 3),
  kind: 'all', // all | image | video
  keyword: '',
  sort: 'name', // name | modified | size
  dense: localStorage.getItem(LS_DENSE) === '1',
  items: [],
  loading: false,
  crawling: false,
  cancelCrawl: false,
  viewerIndex: -1,
};

/* ------------------------------------------------------------------ 工具 */

const $ = (sel) => document.querySelector(sel);

function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function ext(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function classify(name) {
  const e = ext(name);
  if (IMG_EXT.includes(e)) return 'image';
  if (VID_EXT.includes(e)) return 'video';
  return null;
}

function joinPath(parent, name) {
  if (parent === '/' || parent === '') return '/' + name;
  return parent.replace(/\/+$/, '') + '/' + name;
}

function encodePath(p) {
  return '/' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function mediaUrl(item) {
  // 后端 /d/*path 不校验登录态，也不需要 sign（存储未开启签名时）
  return MEDIA + encodePath(item.path);
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}

function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (isNaN(d)) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ 请求 */

async function api(path, body, method = 'POST') {
  const opt = { method, headers: {} };
  if (state.token) opt.headers['Authorization'] = state.token;
  if (body !== undefined && method !== 'GET') {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opt);
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (res.status === 401) {
    setToken('');
    showLogin();
    throw new Error((data && data.message) || '登录已失效，请重新登录');
  }
  if (!res.ok || (data && data.code && data.code !== 200)) {
    throw new Error((data && data.message) || `请求失败 (${res.status})`);
  }
  return data ? data.data : null;
}

function setToken(t) {
  state.token = t || '';
  if (t) localStorage.setItem(LS_TOKEN, t);
  else localStorage.removeItem(LS_TOKEN);
}

/* ------------------------------------------------------------------ 登录 */

function showLogin(msg) {
  $('#login').hidden = false;
  $('#loginMsg').textContent = msg || '';
  setTimeout(() => $('#loginUser').focus(), 60);
}

function hideLogin() { $('#login').hidden = true; }

async function doLogin() {
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  const btn = $('#loginBtn');
  if (!username) return;
  btn.disabled = true;
  $('#loginMsg').textContent = '正在登录…';
  try {
    const data = await api('/auth/login', { username, password });
    setToken(data.token);
    hideLogin();
    $('#loginPass').value = '';
    toast('登录成功');
    await boot();
  } catch (e) {
    $('#loginMsg').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ 侧边栏 */

async function renderRoots() {
  const box = $('#treeRoot');
  box.innerHTML = '';
  box.appendChild(treeItem('/', '根目录', 0));
}

function treeItem(path, label, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'side-item';
  if (!state.allMode && state.path === path) row.classList.add('active');

  const caret = document.createElement('span');
  caret.className = 'tree-caret';
  caret.textContent = '▸';
  const text = document.createElement('span');
  text.className = 'label';
  text.textContent = label;
  row.append(caret, text);

  const children = document.createElement('div');
  children.className = 'tree-children';
  children.hidden = true;

  let loaded = false;
  caret.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (children.hidden) {
      children.hidden = false;
      caret.textContent = '▾';
      if (!loaded) {
        loaded = true;
        children.innerHTML = '<div class="side-item" style="color:var(--text-3)">读取中…</div>';
        try {
          const data = await api('/fs/dirs', { path, password: '' });
          children.innerHTML = '';
          if (!data || !data.length) {
            children.innerHTML = '<div class="side-item" style="color:var(--text-3)">无子文件夹</div>';
            caret.classList.add('leaf');
            return;
          }
          for (const d of data) {
            children.appendChild(treeItem(joinPath(path, d.name), d.name, depth + 1));
          }
        } catch (e) {
          children.innerHTML = '';
          const err = document.createElement('div');
          err.className = 'side-item';
          err.style.color = 'var(--danger)';
          err.textContent = e.message;
          children.appendChild(err);
        }
      }
    } else {
      children.hidden = true;
      caret.textContent = '▸';
    }
  });

  row.addEventListener('click', () => {
    openFolder(path);
    if (window.innerWidth <= 760) $('#sidebar').classList.remove('open');
  });

  wrap.append(row, children);
  return wrap;
}

/* ------------------------------------------------------------------ 浏览 */

function setActiveSide() {
  document.querySelectorAll('#sidebar .side-item').forEach((el) => el.classList.remove('active'));
  $('#navAll').classList.toggle('active', state.allMode);
}

async function openFolder(path) {
  stopCrawl();
  state.allMode = false;
  state.path = path || '/';
  localStorage.setItem(LS_PATH, state.path);
  setActiveSide();
  await loadFolder(state.path);
}

async function loadFolder(path) {
  state.loading = true;
  state.items = [];
  renderCrumbs();
  renderProgress('正在读取目录…');
  try {
    const data = await api('/fs/list', { path, password: '', page: 1, per_page: 0, refresh: false });
    const items = [];
    for (const o of (data.content || [])) {
      const kind = o.is_dir ? null : classify(o.name);
      if (!kind) continue; // 只保留图片与视频
      items.push({
        name: o.name,
        path: joinPath(path, o.name),
        size: o.size,
        modified: o.modified,
        thumb: o.thumb || '',
        kind,
      });
    }
    state.items = items;
    render();
  } catch (e) {
    renderError(e.message);
  } finally {
    state.loading = false;
  }
}

/** 「全部」：沿目录树递归扫描，边扫边出图 */
async function crawlAll() {
  stopCrawl();
  state.allMode = true;
  state.items = [];
  state.crawling = true;
  state.cancelCrawl = false;
  setActiveSide();
  renderCrumbs();
  document.getElementById('grid').innerHTML = '';

  const root = '/';
  const limit = state.depth < 0 ? Infinity : state.depth;
  const queue = [{ path: root, depth: 0 }];
  let scanned = 0;

  try {
    while (queue.length) {
      if (state.cancelCrawl) break;
      const batch = queue.splice(0, 4);
      const results = await Promise.all(batch.map(async ({ path, depth }) => {
        try {
          const data = await api('/fs/list', { path, password: '', page: 1, per_page: 0 });
          const dirs = [];
          const media = [];
          for (const o of (data.content || [])) {
            const full = joinPath(path, o.name);
            if (o.is_dir) {
              if (depth < limit) dirs.push({ path: full, depth: depth + 1 });
            } else {
              const kind = classify(o.name);
              if (kind) media.push({ name: o.name, path: full, size: o.size, modified: o.modified, thumb: o.thumb || '', kind });
            }
          }
          return { dirs, media };
        } catch (e) {
          return { dirs: [], media: [] };
        }
      }));
      for (const r of results) {
        queue.push(...r.dirs);
        scanned++;
        if (r.media.length) {
          state.items.push(...r.media);
          render({ append: true });
        }
      }
      renderProgress(`已扫描 ${scanned} 个目录，找到 ${state.items.length} 个媒体文件`, queue.length);
    }
    if (state.cancelCrawl) renderProgress('已停止扫描');
    else renderProgress(`扫描完成，共 ${state.items.length} 个媒体文件`);
    if (!state.items.length) render();
  } catch (e) {
    renderError(e.message);
  } finally {
    state.crawling = false;
  }
}

function stopCrawl() {
  if (state.crawling) state.cancelCrawl = true;
  state.crawling = false;
}

/* ------------------------------------------------------------------ 渲染 */

function visibleItems() {
  let list = state.items;
  if (state.kind !== 'all') list = list.filter((i) => i.kind === state.kind);
  const kw = state.keyword.trim().toLowerCase();
  if (kw) list = list.filter((i) => i.name.toLowerCase().includes(kw));
  const sorted = list.slice();
  if (state.sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  if (state.sort === 'modified') sorted.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  if (state.sort === 'size') sorted.sort((a, b) => (b.size || 0) - (a.size || 0));
  return sorted;
}

function renderCrumbs() {
  const el = $('#crumbs');
  el.innerHTML = '';
  if (state.allMode) {
    el.textContent = '全部媒体';
    return;
  }
  const parts = state.path.split('/').filter(Boolean);
  const root = document.createElement('a');
  root.textContent = '根目录';
  root.onclick = () => openFolder('/');
  el.appendChild(root);
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    el.appendChild(sep);
    const a = document.createElement('a');
    a.textContent = p;
    const target = acc;
    a.onclick = () => openFolder(target);
    el.appendChild(a);
  }
}

function renderProgress(text, pending) {
  let bar = document.getElementById('crawlProgress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'crawlProgress';
    bar.innerHTML = '<span class="txt"></span><span class="bar"><i></i></span>' +
      '<button class="btn ghost" id="crawlStop">停止</button>';
    document.getElementById('grid').prepend(bar);
    bar.querySelector('#crawlStop').onclick = () => { stopCrawl(); bar.remove(); };
  }
  if (text === null) { bar.remove(); return; }
  bar.querySelector('.txt').textContent = text;
  if (typeof pending === 'number') {
    bar.querySelector('.bar').style.display = '';
    const w = Math.max(4, Math.min(96, 100 / (1 + pending / 6)));
    bar.querySelector('.bar i').style.width = w + '%';
  } else {
    bar.querySelector('.bar').style.display = 'none';
  }
}

function renderError(msg) {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = '读取失败：' + msg;
  grid.appendChild(div);
}

const lazyObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target;
    const src = el.getAttribute('data-src');
    if (src) { el.setAttribute('src', src); el.removeAttribute('data-src'); }
    lazyObserver.unobserve(el);
  }
}, { rootMargin: '400px 0px' });

function render({ append = false } = {}) {
  const grid = document.getElementById('grid');
  const list = visibleItems();
  const keepProgress = document.getElementById('crawlProgress');

  if (!append) grid.innerHTML = '';
  else grid.querySelectorAll('.tile').forEach((el) => el.remove());

  if (keepProgress && !append) grid.appendChild(keepProgress);

  $('#stat').textContent = list.length
    ? `共 ${list.length} 项${state.items.length !== list.length ? ` / 全部 ${state.items.length}` : ''}`
    : '';

  if (!list.length) {
    if (!append) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.innerHTML = state.loading ? '正在加载…'
        : '这个位置没有图片或视频<br><span style="font-size:12px">文件夹里的其他类型文件会被自动忽略</span>';
      grid.appendChild(div);
    }
    return;
  }

  const frag = document.createDocumentFragment();
  list.forEach((item, idx) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.index = String(state.items.indexOf(item));
    tile.dataset.visible = String(idx);

    const media = document.createElement('div');
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = item.name;
      img.setAttribute('data-src', item.thumb || mediaUrl(item));
      lazyObserver.observe(img);
      img.addEventListener('error', () => { img.style.opacity = '.25'; });
      media.appendChild(img);
    } else {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'metadata';
      v.playsInline = true;
      if (item.thumb) v.poster = item.thumb;
      v.setAttribute('data-src', mediaUrl(item));
      lazyObserver.observe(v);
      v.addEventListener('error', () => {
        tile.classList.add('novideo');
        v.remove();
        const ph = document.createElement('div');
        ph.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:11px';
        ph.textContent = '无预览';
        tile.appendChild(ph);
      });
      media.appendChild(v);
    }
    tile.appendChild(media);

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = item.kind === 'video' ? '▶ ' + (ext(item.name) || 'video') : '🖼';
    if (item.kind === 'image') badge.style.display = 'none';
    tile.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = item.name;
    tile.appendChild(meta);

    tile.title = `${item.name}\n${fmtSize(item.size)}\n${fmtTime(item.modified)}`;
    tile.addEventListener('click', () => {
      if (Date.now() < suppressClickUntil) return; // 长按菜单刚弹出，忽略这次点击
      openViewer(state.items.indexOf(item));
    });
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openItemMenu(item, e.clientX, e.clientY);
    });
    attachLongPress(tile, () => item);
    frag.appendChild(tile);
  });
  grid.appendChild(frag);
}

/* ------------------------------------------------------------------ 查看器 */

function openViewer(index, direction) {
  if (index < 0) return;
  state.viewerIndex = index;
  const item = state.items[index];
  if (!item) return;
  const viewer = $('#viewer');
  viewer.hidden = false;
  $('#vTitle').textContent = `${item.name}  ·  ${fmtSize(item.size)}`;

  const stage = $('#vStage');
  stage.innerHTML = '';
  if (item.kind === 'image') {
    const img = document.createElement('img');
    img.src = item.thumb || mediaUrl(item);
    img.alt = item.name;
    stage.appendChild(img);
  } else {
    const v = document.createElement('video');
    v.src = mediaUrl(item);
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    if (!NATIVE_VID_EXT.includes(ext(item.name))) {
      const tip = document.createElement('div');
      tip.style.cssText = 'position:absolute;bottom:6px;left:12px;color:#c9ced6;font-size:12px';
      tip.textContent = '该容器可能需要转码，若无法播放请直接下载';
      stage.appendChild(v);
      stage.appendChild(tip);
    } else {
      stage.appendChild(v);
    }
  }

  $('#vPrev').disabled = prevMediaIndex(index) < 0;
  $('#vNext').disabled = nextMediaIndex(index) < 0;
  $('#vDownload').href = mediaUrl(item);
  $('#vDownload').setAttribute('download', item.name);
  if (direction !== undefined) $('#vOpen').href = mediaUrl(item);
}

function prevMediaIndex(from) {
  for (let i = from - 1; i >= 0; i--) if (state.items[i]) return i;
  return -1;
}
function nextMediaIndex(from) {
  for (let i = from + 1; i < state.items.length; i++) if (state.items[i]) return i;
  return -1;
}

function moveViewer(step) {
  const idx = step < 0 ? prevMediaIndex(state.viewerIndex) : nextMediaIndex(state.viewerIndex);
  if (idx >= 0) openViewer(idx);
}

function closeViewer() {
  const v = $('#vStage video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  $('#vStage').innerHTML = '';
  $('#viewer').hidden = true;
  state.viewerIndex = -1;
}

/* ------------------------------------------------------------------ 复制 / 右键菜单 */

// 长按弹出菜单后，短时间内屏蔽随之而来的 click，避免误触打开查看器
let suppressClickUntil = 0;

function absUrl(item) {
  // 用当前页面地址把相对路径补成完整 URL，兼容自定义 base_path 与局域网访问
  return new URL(mediaUrl(item), location.href).href;
}

async function copyText(text, okMsg) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast(okMsg || '已复制');
      return true;
    }
  } catch (e) { /* 继续走兜底方案 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) { toast(okMsg || '已复制'); return true; }
  } catch (e) { /* 继续走兜底方案 */ }
  // 通过 http://局域网IP 访问时不是安全上下文，剪贴板 API 不可用，退化为手动复制
  window.prompt('自动复制失败，请长按选中后复制：', text);
  return false;
}

function hideCtxMenu() {
  const m = document.getElementById('ctxMenu');
  if (m) m.hidden = true;
}

function showCtxMenu(x, y, items, headText) {
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;
  menu.innerHTML = '';
  if (headText) {
    const h = document.createElement('div');
    h.className = 'ctx-head';
    h.textContent = headText;
    menu.appendChild(h);
  }
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement('div');
      d.className = 'ctx-sep';
      menu.appendChild(d);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.onclick = () => { hideCtxMenu(); it.onClick(); };
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 10)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 10)) + 'px';
}

function downloadItem(item, url) {
  const a = document.createElement('a');
  a.href = url || absUrl(item);
  a.download = item.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openItemMenu(item, x, y) {
  if (!item) return;
  const abs = absUrl(item);
  showCtxMenu(x, y, [
    { label: '复制下载链接', onClick: () => copyText(abs, '下载链接已复制') },
    { label: '复制文件名', onClick: () => copyText(item.name, '文件名已复制') },
    { label: '复制 Markdown', onClick: () => copyText(`[${item.name}](${abs})`, 'Markdown 已复制') },
    { sep: true },
    { label: '在新标签页打开', onClick: () => window.open(abs, '_blank', 'noopener') },
    { label: '下载', onClick: () => downloadItem(item, abs) },
  ], item.name);
}

/** 触屏长按（约 0.5 秒）弹出同一套菜单；getItem 为惰性取值，便于查看器复用 */
function attachLongPress(el, getItem) {
  let timer = null;
  let sx = 0, sy = 0;
  let fired = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    fired = false;
    cancel();
    timer = setTimeout(() => {
      fired = true;
      suppressClickUntil = Date.now() + 800;
      const item = getItem();
      if (item) openItemMenu(item, sx, sy);
    }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!e.touches.length) return;
    if (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10) cancel();
  }, { passive: true });
  el.addEventListener('touchend', () => cancel(), { passive: true });
  el.addEventListener('touchcancel', () => cancel(), { passive: true });
}

/* ------------------------------------------------------------------ 上传 */

function uploadTarget() {
  return state.allMode ? null : (state.path || '/');
}

function pickAndUpload() {
  const dir = uploadTarget();
  if (dir === null) {
    toast('「全部媒体」视图下无法上传，请先进入某个文件夹');
    return;
  }
  $('#filePicker').click();
}

function uploadFiles(files) {
  const dir = uploadTarget();
  if (!dir || !files.length) return;
  const total = files.length;
  let done = 0;
  let failed = 0;
  toast(`开始上传 ${total} 个文件…`, 3000);
  for (const f of files) {
    const dest = joinPath(dir, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', API + '/fs/put', true);
    xhr.setRequestHeader('Authorization', state.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('File-Path', encodeURIComponent(dest));
    const settle = (ok) => {
      done++;
      if (!ok) failed++;
      if (done === total) {
        toast(failed ? `上传结束：成功 ${total - failed} 个，失败 ${failed} 个` : `已上传 ${total} 个文件`, 4000);
        if (state.allMode) crawlAll();
        else loadFolder(state.path);
      }
    };
    xhr.onload = () => settle(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => settle(false);
    xhr.onabort = () => settle(false);
    xhr.send(f);
  }
}

/* ------------------------------------------------------------------ 挂载管理 */

const DRIVER_TEMPLATE = {
  Local: { root_folder_path: '/storage/emulated/0', thumbnail: false, thumb_cache_folder: '', show_hidden: true, mkdir_perm: '777', recycle_bin_path: 'delete permanently' },
  SMB: { host: '', username: '', password: '', root_folder_path: '/', share_name: '' },
  SFTP: { host: '', username: '', password: '', private_key: '', root_folder_path: '/', passphrase: '' },
  WebDAV: { url: '', username: '', password: '', root_folder_path: '/', vendor: 'other' },
};

async function openAdmin() {
  $('#admin').hidden = false;
  await refreshStorages();
}

async function refreshStorages() {
  const box = $('#storageList');
  box.innerHTML = '<div style="color:var(--text-3);font-size:13px">读取中…</div>';
  try {
    const data = await api('/admin/storage/list', undefined, 'GET');
    const list = (data && data.content) || [];
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div style="color:var(--text-3);font-size:13px">还没有挂载任何存储</div>';
      return;
    }
    list.sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const s of list) {
      const el = document.createElement('div');
      el.className = 'storage-item';
      const status = s.disabled ? '' : '<span class="pill on">已启用</span>';
      el.innerHTML = `
        <div class="top">
          <span class="nm"></span>
          <span class="pill">${s.driver || ''}</span>
          ${status}
          <span class="acts">
            <button class="btn ghost" data-act="edit">编辑</button>
            <button class="btn ghost" data-act="toggle">${s.disabled ? '启用' : '停用'}</button>
            <button class="btn ghost" data-act="del">删除</button>
          </span>
        </div>
        <div class="sub">挂载路径：${s.mount_path || '/'} · 顺序：${s.order ?? 0}</div>`;
      el.querySelector('.nm').textContent = s.name || '(未命名)';
      el.querySelector('[data-act=edit]').onclick = () => editStorage(s.id);
      el.querySelector('[data-act=toggle]').onclick = async () => {
        try {
          await api(`/admin/storage/${s.disabled ? 'enable' : 'disable'}?id=${s.id}`);
          toast(s.disabled ? '已启用' : '已停用');
          refreshStorages();
        } catch (e) { toast(e.message); }
      };
      el.querySelector('[data-act=del]').onclick = async () => {
        if (!confirm(`确认删除挂载「${s.name}」？不会删除源文件。`)) return;
        try {
          await api(`/admin/storage/delete?id=${s.id}`);
          toast('已删除');
          refreshStorages();
        } catch (e) { toast(e.message); }
      };
      box.appendChild(el);
    }
  } catch (e) {
    box.innerHTML = '';
    const d = document.createElement('div');
    d.style.color = 'var(--danger)';
    d.style.fontSize = '13px';
    d.textContent = e.message;
    box.appendChild(d);
  }
}

function syncDriverTemplate() {
  const drv = $('#stDriver').value;
  const tpl = DRIVER_TEMPLATE[drv];
  if (tpl && !$('#stAddition').dataset.touched) {
    $('#stAddition').value = JSON.stringify(tpl, null, 2);
  }
  $('#stDriverHint').textContent = '提示：不确定字段名时，可点「查看字段说明」看该驱动的完整字段与默认值。';
}

async function editStorage(id) {
  try {
    const s = await api(`/admin/storage/get?id=${id}`, undefined, 'GET');
    $('#stId').value = s.id;
    $('#stName').value = s.name || '';
    $('#stMount').value = s.mount_path || '/';
    $('#stOrder').value = s.order ?? 0;
    $('#stDriver').value = s.driver || 'Local';
    $('#stSign').checked = !!s.enable_sign;
    $('#stProxy').checked = !!s.web_proxy;
    $('#stAddition').value = s.addition || '{}';
    $('#stAddition').dataset.touched = '1';
    $('#stFormTitle').textContent = '编辑挂载';
    $('#stCancel').hidden = false;
    $('#adminList').hidden = true;
    $('#stForm').hidden = false;
  } catch (e) { toast(e.message); }
}

function newStorage() {
  $('#stId').value = '';
  $('#stName').value = '';
  $('#stMount').value = '/';
  $('#stOrder').value = 0;
  $('#stDriver').value = 'Local';
  $('#stSign').checked = false;
  $('#stProxy').checked = false;
  delete $('#stAddition').dataset.touched;
  syncDriverTemplate();
  $('#stFormTitle').textContent = '新增挂载';
  $('#stCancel').hidden = false;
  $('#adminList').hidden = true;
  $('#stForm').hidden = false;
}

async function saveStorage() {
  const id = $('#stId').value;
  let addition;
  try { addition = JSON.parse($('#stAddition').value || '{}'); }
  catch (e) { toast('配置 JSON 格式错误：' + e.message); return; }
  const payload = {
    id: id ? Number(id) : 0,
    name: $('#stName').value.trim() || $('#stDriver').value + ' 存储',
    mount_path: $('#stMount').value.trim() || '/',
    order: Number($('#stOrder').value) || 0,
    driver: $('#stDriver').value,
    enable_sign: $('#stSign').checked,
    web_proxy: $('#stProxy').checked,
    disabled: false,
    addition: JSON.stringify(addition),
  };
  try {
    if (id) await api('/admin/storage/update', payload);
    else await api('/admin/storage/create', payload);
    toast(id ? '已保存' : '已添加');
    backToList();
  } catch (e) { toast(e.message); }
}

function backToList() {
  $('#stForm').hidden = true;
  $('#adminList').hidden = false;
  refreshStorages();
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  try {
    const me = await api('/me', undefined, 'GET');
    $('#whoami').textContent = me && me.username ? me.username : '';
  } catch (e) {
    return; // api() 已在 401 时弹出登录
  }
  try {
    const pub = await api('/public/settings', undefined, 'GET');
    if (pub && pub.site_title) {
      state.siteTitle = pub.site_title;
      document.title = pub.site_title;
    }
  } catch (e) { /* 忽略 */ }

  if (state.depth === undefined || Number.isNaN(state.depth)) state.depth = 3;
  $('#depthSel').value = String(state.depth);
  $('#grid').classList.toggle('dense', state.dense);
  await renderRoots();
  await openFolder(state.path);
}

function bindUI() {
  $('#btnSidebar').onclick = () => {
    const sb = $('#sidebar');
    if (window.innerWidth <= 760) sb.classList.toggle('open');
    else sb.classList.toggle('collapsed');
  };

  $('#navAll').onclick = () => { crawlAll(); if (window.innerWidth <= 760) $('#sidebar').classList.remove('open'); };

  $('#searchInput').addEventListener('input', (e) => {
    state.keyword = e.target.value;
    render();
  });

  $('#btnRefresh').onclick = () => { state.allMode ? crawlAll() : loadFolder(state.path); };

  $('#btnUpload').onclick = pickAndUpload;
  $('#filePicker').onchange = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    uploadFiles(files);
  };

  $('#btnDense').onclick = () => {
    state.dense = !state.dense;
    localStorage.setItem(LS_DENSE, state.dense ? '1' : '0');
    $('#grid').classList.toggle('dense', state.dense);
    $('#btnDense').classList.toggle('active', state.dense);
  };
  $('#btnDense').classList.toggle('active', state.dense);

  $('#depthSel').onchange = (e) => {
    state.depth = Number(e.target.value);
    localStorage.setItem(LS_DEPTH, String(state.depth));
    if (state.allMode) crawlAll();
  };

  document.querySelectorAll('#toolbar .chip[data-kind]').forEach((el) => {
    el.onclick = () => {
      state.kind = el.dataset.kind;
      document.querySelectorAll('#toolbar .chip[data-kind]').forEach((x) => x.classList.toggle('active', x === el));
      render();
    };
  });

  $('#sortSel').onchange = (e) => { state.sort = e.target.value; render(); };

  // 查看器
  $('#vClose').onclick = closeViewer;
  $('#vPrev').onclick = () => moveViewer(-1);
  $('#vNext').onclick = () => moveViewer(1);
  $('#vCopy').onclick = () => {
    const item = state.items[state.viewerIndex];
    if (item) copyText(absUrl(item), '下载链接已复制');
  };
  $('#viewer').addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) return;
    if (e.target === $('#viewer') || e.target === $('#vStage')) closeViewer();
  });
  $('#vStage').addEventListener('contextmenu', (e) => {
    const item = state.items[state.viewerIndex];
    if (!item) return;
    e.preventDefault();
    openItemMenu(item, e.clientX, e.clientY);
  });
  attachLongPress($('#vStage'), () => state.items[state.viewerIndex]);

  // 右键 / 长按菜单：点别处、滚动、缩放、失焦都收起
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('#ctxMenu')) hideCtxMenu();
  });
  document.addEventListener('scroll', hideCtxMenu, true);
  window.addEventListener('resize', hideCtxMenu);
  window.addEventListener('blur', hideCtxMenu);

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#ctxMenu').hidden) { hideCtxMenu(); return; }
    if ($('#viewer').hidden) {
      if (e.key === '/' && e.target.tagName !== 'INPUT') { e.preventDefault(); $('#searchInput').focus(); }
      return;
    }
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') moveViewer(-1);
    if (e.key === 'ArrowRight') moveViewer(1);
  });

  // 触摸滑动切换
  let sx = 0, sy = 0;
  $('#viewer').addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  $('#viewer').addEventListener('touchend', (e) => {
    if (!e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) moveViewer(dx < 0 ? 1 : -1);
  }, { passive: true });

  // 登录
  $('#loginBtn').onclick = doLogin;
  $('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginPass').focus(); });
  $('#logoutBtn').onclick = async () => {
    try { await api('/auth/logout', undefined, 'GET'); } catch (e) { /* 忽略 */ }
    setToken('');
    location.reload();
  };

  // 挂载管理
  $('#btnAdmin').onclick = openAdmin;
  $('#adminClose').onclick = () => { $('#admin').hidden = true; };
  $('#admin').addEventListener('click', (e) => { if (e.target === $('#admin')) $('#admin').hidden = true; });
  $('#stNew').onclick = newStorage;
  $('#stCancel').onclick = backToList;
  $('#stSave').onclick = saveStorage;
  $('#stDriver').onchange = () => { delete $('#stAddition').dataset.touched; syncDriverTemplate(); };
  $('#stAddition').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  $('#stSchema').onclick = async () => {
    try {
      const info = await api(`/admin/driver/info?driver=${encodeURIComponent($('#stDriver').value)}`, undefined, 'GET');
      $('#stDriverHint').textContent = JSON.stringify(info, null, 2);
      $('#stDriverHint').style.whiteSpace = 'pre-wrap';
      $('#stDriverHint').style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
    } catch (e) { $('#stDriverHint').textContent = e.message; }
  };
}

async function main() {
  bindUI();
  syncDriverTemplate();
  if (state.token) {
    // 先静默校验 token，失败时 api() 会自动弹登录
    try { await api('/me', undefined, 'GET'); } catch (e) { showLogin(e.message); return; }
    await boot();
  } else {
    showLogin('');
  }
}

main();
