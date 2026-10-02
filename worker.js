// ===========================================================================
// 超级工具箱 · 云端服务(自带管理界面)
// ===========================================================================
//
// 一个 Worker 干两件事:
//
//   1. 给设备提供数据接口   GET /api/pull/<名字>
//   2. 给你提供一个手机能用的管理网页   GET /
//
// 用手机浏览器打开 Worker 网址,就能直接编辑作业、出行、纪念日、设置,
// 点保存立刻生效,不用碰代码。
//
// ---------------------------------------------------------------------------
// 存储策略(关键设计)
// ---------------------------------------------------------------------------
//
// 优先用 KV,没有 KV 也能跑:
//
//   有 KV 绑定 → 读写都走 KV。你在网页上改的东西会存下来,改完立刻生效。
//   没有 KV    → 退回下面的 DEFAULTS 内置数据。网页能看、能改,
//                但**改完不会保存**(刷新就没了),并且页面顶部会提示。
//
// 为什么这么设计:你不用为了"先跑通"去折腾绑定配置。
// 上传这一个文件就能看到界面,以后想让它真正能存,再补一个 KV 绑定即可 ——
// 设备端和固件一个字都不用改。
// ===========================================================================

// ===========================================================================
// ↓↓↓ 内置默认数据。没有 KV 绑定时会用这份 ↓↓↓
// ===========================================================================
//
// 有 KV 之后这份只在"KV 里还没写过这个键"的时候生效一次,之后以 KV 为准。

const DEFAULTS = {
  todo: [
    { title: '语文:背诵课文第三段', note: '明天上课抽查', done: false, priority: 1 },
    { title: '数学:练习册 P32-P35', note: '', done: false, priority: 0 },
    { title: '英语:听写第 5 单元单词', note: '错词抄三遍', done: false, priority: 0 },
    { title: '准备明天的手工材料', note: '卡纸、胶棒、剪刀', done: false, priority: 2 },
  ],
  travel: [
    { title: '订往返车票', note: '提前 3 天订能便宜一些', done: false, priority: 2 },
    { title: '查天气决定带什么衣服', note: '', done: false, priority: 1 },
    { title: '下载离线地图', note: '山区信号不好', done: false, priority: 1 },
    { title: '列一份行李清单', note: '证件、充电器、常用药', done: false, priority: 0 },
  ],
  anniv: [
    { month: 10, day: 1, since_year: 1949, name: '国庆' },
    { month: 1, day: 1, since_year: 1949, name: '元旦' },
    { month: 5, day: 1, since_year: 0, name: '劳动节' },
  ],
  settings: {
    bright: 100, vol: 60, sleepmin: 5,
    sound: true, clicksnd: true, wifiauto: true, bleen: false,
  },
  // 空数组 = 这一项不下发。设备会保留它自己存的密码,不会被清空。
  vault: [],
};

// 允许访问的名字。
const ALLOWED = ['todo', 'travel', 'anniv', 'settings', 'vault'];

// 每个名字的中文标签(界面上显示用)。
const LABELS = {
  todo: '作业清单',
  travel: '出行规划',
  anniv: '纪念日',
  settings: '设备设置',
  vault: 'Wi-Fi 密码库',
};

// ===========================================================================
// 存储层:有 KV 用 KV,没有就退回内置数据
// ===========================================================================

function hasKV(env) {
  return env !== undefined && env !== null && env.TOOLBOX_KV !== undefined;
}

async function readSet(env, name) {
  if (hasKV(env)) {
    const raw = await env.TOOLBOX_KV.get(name + '.json', 'text');
    if (raw !== null) {
      try {
        return JSON.parse(raw);
      } catch (e) {
        // KV 里的内容坏了 —— 不让它把整个页面搞崩,退回内置数据。
        return DEFAULTS[name];
      }
    }
  }
  return DEFAULTS[name];
}

async function writeSet(env, name, value) {
  if (!hasKV(env)) {
    return { ok: false, reason: '没有配置 KV 绑定,改动无法保存' };
  }
  await env.TOOLBOX_KV.put(name + '.json', JSON.stringify(value));
  return { ok: true };
}

// ===========================================================================
// 接口部分
// ===========================================================================

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // 设备要的永远是最新那份,不让中间层缓存。
  'cache-control': 'no-store',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: JSON_HEADERS,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ——— 设备拉数据 ———
    if (path.startsWith('/api/pull/')) {
      const name = path.slice('/api/pull/'.length);
      if (!ALLOWED.includes(name)) {
        return json({ error: '未提供此项' }, 404);
      }

      const value = await readSet(env, name);

      // 空的(数组没内容 / 对象没字段 / 压根没有)→ 返回 404。
      // 设备把 404 当成"跳过",会保留自己那份数据。
      // 如果这里返回一个空数组,设备会理解成"云端说这项是空的"而清光本地 ——
      // 那是会丢东西的,所以必须挡住。
      if (value === undefined || value === null || isEmpty(value)) {
        return json({ error: 'not found' }, 404);
      }
      return json(value);
    }

    // ——— 概览(调试用) ———
    if (path === '/api/manifest') {
      const items = [];
      for (const name of ALLOWED) {
        const value = await readSet(env, name);
        if (value !== undefined && value !== null && !isEmpty(value)) {
          items.push({
            name: name,
            label: LABELS[name],
            size: JSON.stringify(value).length,
          });
        }
      }
      return json({ storage: hasKV(env) ? 'kv' : 'builtin', items: items });
    }

    // ——— 管理界面读数据 ———
    if (path === '/api/admin/load') {
      const out = { storage: hasKV(env) ? 'kv' : 'builtin', data: {} };
      for (const name of ALLOWED) {
        const value = await readSet(env, name);
        out.data[name] = value === undefined || value === null ? emptyOf(name) : value;
      }
      return json(out);
    }

    // ——— 管理界面存数据 ———
    if (path === '/api/admin/save' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ ok: false, reason: '内容不是合法 JSON' }, 400);
      }

      if (!body || typeof body.name !== 'string' || !ALLOWED.includes(body.name)) {
        return json({ ok: false, reason: '名字不对' }, 400);
      }
      if (body.value === undefined) {
        return json({ ok: false, reason: '没有内容' }, 400);
      }

      const r = await writeSet(env, body.name, body.value);
      return json(r, r.ok ? 200 : 409);
    }

    // ——— 管理网页 ———
    if (path === '/' || path === '/admin') {
      return new Response(ADMIN_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('未找到', { status: 404 });
  },
};

// 判断"这一项算是空的吗"。
// 数组看长度,对象看字段数,其它类型(数字/字符串)一律算非空。
function isEmpty(value) {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).length === 0;
  }
  return false;
}

// 取某一项的"空壳",管理页面初始化用。
function emptyOf(name) {
  return name === 'settings' ? {} : [];
}

// ===========================================================================
// 管理界面(单页,手机优先)
// ===========================================================================
//
// 为什么内嵌成字符串而不是单独的文件:Worker 的网页上传入口对多文件支持
// 不稳定,内嵌成一个文件最保险 —— 传上去必定能用。
//
// 界面设计:手机竖屏优先,大按钮,不用下拉菜单,五个数据一项一栏。

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>超级工具箱 · 云端管理</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; padding: 0 12px 100px;   /* 底部留白:别让固定的操作条盖住内容 */
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: #101418; color: #E8EEF2; font-size: 15px; line-height: 1.6;
  }
  header {
    position: sticky; top: 0; z-index: 10;
    background: #101418; padding: 14px 0 10px;
    border-bottom: 1px solid #1B2228;
  }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .sub { font-size: 12px; color: #8C9BA6; }
  /* 提示条压缩成一行高,不占地方 —— 手机屏幕上纵向空间很宝贵 */
  .banner {
    margin: 8px 0; padding: 8px 10px; border-radius: 8px;
    background: #3A2E1A; color: #FFB74D; font-size: 12px; line-height: 1.4;
  }
  .banner.ok { background: #1A2E1F; color: #66BB6A; }
  /* 五个标签平分一整行,不用滑动就能全看到 —— 手机上更容易发现 */
  nav { display: flex; gap: 4px; padding: 10px 0; }
  nav button {
    flex: 1 1 0; min-width: 0; padding: 8px 2px; border-radius: 14px;
    border: 1px solid #27313A; background: #1B2228; color: #8C9BA6;
    font-size: 12px; font-family: inherit; cursor: pointer; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  nav button.on { background: #4FC3F7; border-color: #4FC3F7; color: #101418; font-weight: 600; }
  section { display: none; }
  section.on { display: block; }
  .row {
    background: #1B2228; border-radius: 10px; padding: 12px;
    margin-bottom: 10px; border-left: 3px solid #27313A;
  }
  .row.p1 { border-left-color: #FFB74D; }
  .row.p2 { border-left-color: #E57373; }
  .row.done { opacity: .5; }
  input[type=text], textarea, select {
    width: 100%; min-width: 0;        /* min-width:0 是让它在 flex 里能被压缩的关键 */
    padding: 10px; margin-top: 6px; border-radius: 8px;
    border: 1px solid #27313A; background: #101418; color: #E8EEF2;
    font-size: 15px; font-family: inherit;
  }
  textarea { resize: vertical; min-height: 56px; }
  label { font-size: 12px; color: #8C9BA6; display: block; margin-top: 8px; }
  .line { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  /* 下拉框占满剩余宽度,按钮按内容宽度;两者都不许撑出屏幕 */
  .line select { flex: 1 1 auto; min-width: 0; margin-top: 0; }
  .line input { flex: 1 1 auto; min-width: 0; margin-top: 0; }
  button.act {
    flex: 0 0 auto; padding: 10px 12px; border-radius: 8px; border: 1px solid #27313A;
    background: #27313A; color: #E8EEF2; font-size: 14px;
    font-family: inherit; cursor: pointer; white-space: nowrap;
  }
  button.act.danger { background: #3A1F1F; border-color: #5A2A2A; color: #E57373; }
  button.act.primary { background: #4FC3F7; border-color: #4FC3F7; color: #101418; font-weight: 600; }
  .bar {
    position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 12px;
    padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    background: #101418; border-top: 1px solid #1B2228;
    display: flex; gap: 10px;
  }
  .bar button {
    flex: 1 1 0; min-width: 0;
    padding: 14px 8px; border-radius: 10px; border: 0;
    font-size: 16px; font-family: inherit; font-weight: 600; cursor: pointer;
    white-space: nowrap;
  }
  .bar .save { background: #4FC3F7; color: #101418; }
  .bar .add { background: #27313A; color: #E8EEF2; }
  .tip { font-size: 12px; color: #8C9BA6; margin: 10px 0; }
  .switch { display: flex; align-items: center; justify-content: space-between;
    padding: 12px; background: #1B2228; border-radius: 10px; margin-bottom: 10px; }
  .switch input { width: 22px; height: 22px; }
</style>
</head>
<body>
<header>
  <h1>超级工具箱 · 云端</h1>
  <div class="sub" id="sub">加载中…</div>
</header>
<div id="banner"></div>
<nav id="nav"></nav>

<section id="s-todo"></section>
<section id="s-travel"></section>
<section id="s-anniv"></section>
<section id="s-settings"></section>
<section id="s-vault"></section>

<div class="bar">
  <button class="add" onclick="addItem()">＋ 新增</button>
  <button class="save" id="savebtn" onclick="save()">保存</button>
</div>

<script>
const NAMES = ['todo','travel','anniv','settings','vault'];
const LABELS = {todo:'作业清单',travel:'出行规划',anniv:'纪念日',settings:'设备设置',vault:'Wi-Fi 密码库'};
let DATA = {};
let CUR = 'todo';
let STORAGE = 'builtin';

const $ = s => document.querySelector(s);

async function boot() {
  try {
    const r = await fetch('/api/admin/load');
    const j = await r.json();
    DATA = j.data;
    STORAGE = j.storage;
    $('#sub').textContent = '云端地址已连通';
    if (STORAGE === 'kv') {
      banner('已连接存储,改动会保存下来。', true);
    } else {
      banner('只读模式:没配 KV 绑定,改动存不下来。详见「部署步骤」第 6 步。', false);
    }
  } catch (e) {
    $('#sub').textContent = '读取失败';
    banner('读不到云端数据: ' + e.message, false);
  }
  renderNav();
  renderAll();
}

function banner(text, ok) {
  $('#banner').innerHTML = '<div class="banner' + (ok ? ' ok' : '') + '">' + esc(text) + '</div>';
}

function renderNav() {
  $('#nav').innerHTML = NAMES.map(n =>
    '<button class="' + (n === CUR ? 'on' : '') + '" onclick="switchTo(\\'' + n + '\\')">'
    + LABELS[n] + '</button>'
  ).join('');
  // 保存按钮上带出当前栏目名,免得改了半天不知道存的是哪一栏
  $('#savebtn').textContent = '保存' + LABELS[CUR];
}

function switchTo(n) { CUR = n; renderNav(); renderAll(); }

function renderAll() {
  renderTodo('todo', '#s-todo');
  renderTodo('travel', '#s-travel');
  renderAnniv();
  renderSettings();
  renderVault();
  for (const n of NAMES) {
    $('#s-' + n).classList.toggle('on', n === CUR);
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// —— 清单(作业 / 出行)—— 结构一样,共用一套渲染
function renderTodo(name, sel) {
  const list = DATA[name] || [];
  if (list.length === 0) {
    $(sel).innerHTML = '<p class="tip">还没有内容。点下面的「＋ 新增」加一条。</p>';
    return;
  }
  $(sel).innerHTML = list.map((it, i) =>
    '<div class="row p' + (it.priority || 0) + (it.done ? ' done' : '') + '">'
    + '<input type="text" value="' + esc(it.title) + '" placeholder="任务标题"'
    + ' oninput="upd(\\'' + name + '\\',' + i + ',\\'title\\',this.value)">'
    + '<textarea placeholder="备注(可留空)"'
    + ' oninput="upd(\\'' + name + '\\',' + i + ',\\'note\\',this.value)">' + esc(it.note) + '</textarea>'
    + '<div class="line">'
    + '<select onchange="upd(\\'' + name + '\\',' + i + ',\\'priority\\',+this.value)">'
    + opt(it.priority || 0, 0, '普通') + opt(it.priority || 0, 1, '重要')
    + opt(it.priority || 0, 2, '紧急') + '</select>'
    + '<button class="act ' + (it.done ? '' : 'primary') + '"'
    + ' onclick="toggleDone(\\'' + name + '\\',' + i + ')">'
    + (it.done ? '已完成' : '未完成') + '</button>'
    + '<button class="act danger" onclick="delItem(\\'' + name + '\\',' + i + ')">删除</button>'
    + '</div></div>'
  ).join('');
}

function opt(cur, val, text) {
  return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + text + '</option>';
}

function renderAnniv() {
  const list = DATA.anniv || [];
  if (list.length === 0) {
    $('#s-anniv').innerHTML = '<p class="tip">还没有纪念日。</p>';
    return;
  }
  $('#s-anniv').innerHTML = list.map((it, i) =>
    '<div class="row">'
    + '<input type="text" value="' + esc(it.name) + '" placeholder="名称,例如 生日"'
    + ' oninput="upd(\\'anniv\\',' + i + ',\\'name\\',this.value)">'
    + '<div class="line">'
    + '<select onchange="upd(\\'anniv\\',' + i + ',\\'month\\',+this.value)">'
    + Array.from({length:12}, (_, k) => opt(it.month, k+1, (k+1)+' 月')).join('')
    + '</select>'
    + '<select onchange="upd(\\'anniv\\',' + i + ',\\'day\\',+this.value)">'
    + Array.from({length:31}, (_, k) => opt(it.day, k+1, (k+1)+' 日')).join('')
    + '</select>'
    + '</div>'
    + '<label>起始年(用来算"第几周年",填 0 表示不算)</label>'
    + '<div class="line">'
    + '<input type="text" inputmode="numeric" value="' + (it.since_year || 0) + '"'
    + ' oninput="upd(\\'anniv\\',' + i + ',\\'since_year\\',+this.value||0)">'
    + '<button class="act danger" onclick="delItem(\\'anniv\\',' + i + ')">删除</button>'
    + '</div></div>'
  ).join('');
}

function renderSettings() {
  const s = DATA.settings || {};
  const sw = (key, label) =>
    '<div class="switch"><span>' + label + '</span>'
    + '<input type="checkbox"' + (s[key] ? ' checked' : '')
    + ' onchange="upd(\\'settings\\',0,\\'' + key + '\\',this.checked)"></div>';

  $('#s-settings').innerHTML =
    '<label>屏幕亮度(10 的倍数,10-100)</label>'
    + '<input type="text" inputmode="numeric" value="' + (s.bright != null ? s.bright : 100) + '"'
    + ' oninput="upd(\\'settings\\',0,\\'bright\\',+this.value||0)">'
    + '<label>音量(10 的倍数,0-100)</label>'
    + '<input type="text" inputmode="numeric" value="' + (s.vol != null ? s.vol : 60) + '"'
    + ' oninput="upd(\\'settings\\',0,\\'vol\\',+this.value||0)">'
    + '<label>几分钟后自动熄屏(0 = 不自动)</label>'
    + '<input type="text" inputmode="numeric" value="' + (s.sleepmin != null ? s.sleepmin : 5) + '"'
    + ' oninput="upd(\\'settings\\',0,\\'sleepmin\\',+this.value||0)">'
    + '<div style="height:12px"></div>'
    + sw('sound', '总声音开关')
    + sw('clicksnd', '按键提示音')
    + sw('wifiauto', '开机自动连 Wi-Fi')
    + sw('bleen', '蓝牙开关');
}

function renderVault() {
  const list = DATA.vault || [];
  if (list.length === 0) {
    $('#s-vault').innerHTML =
      '<p class="tip">保持空白是最安全的做法：这里是明文密码，'
      + '任何知道本网址的人都能看到。设备会保留它自己存的密码。</p>';
    return;
  }
  $('#s-vault').innerHTML = list.map((it, i) =>
    '<div class="row">'
    + '<input type="text" value="' + esc(it.ssid) + '" placeholder="Wi-Fi 名称"'
    + ' oninput="upd(\\'vault\\',' + i + ',\\'ssid\\',this.value)">'
    + '<input type="text" value="' + esc(it.password) + '" placeholder="密码"'
    + ' oninput="upd(\\'vault\\',' + i + ',\\'password\\',this.value)">'
    + '<input type="text" value="' + esc(it.label) + '" placeholder="备注名(可留空)"'
    + ' oninput="upd(\\'vault\\',' + i + ',\\'label\\',this.value)">'
    + '<div class="line">'
    + '<select onchange="upd(\\'vault\\',' + i + ',\\'auth\\',+this.value)">'
    + opt(it.auth || 1, 0, '开放') + opt(it.auth || 1, 1, 'WPA2') + opt(it.auth || 1, 2, 'WPA3')
    + '</select>'
    + '<button class="act danger" onclick="delItem(\\'vault\\',' + i + ')">删除</button>'
    + '</div></div>'
  ).join('') + '<p class="tip">注意：这里是明文密码，请谨慎填写。</p>';
}

// —— 数据修改 ——
function upd(name, idx, key, val) {
  const d = DATA[name];
  if (key === 'bright') { val = snap(val); }
  if (key === 'vol') { val = snap(val); }
  if (name === 'settings') { d[key] = val; } else { d[idx][key] = val; }
  // 优先级变了重画一下(左边那条颜色跟着变)
  if (key === 'priority') { renderAll(); }
}

function snap(v) {
  v = Math.round(v / 10) * 10;
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  return v;
}

function toggleDone(name, i) {
  DATA[name][i].done = !DATA[name][i].done;
  renderAll();
}

function delItem(name, i) {
  if (!confirm('确定删除这一条?')) return;
  DATA[name].splice(i, 1);
  renderAll();
}

function addItem() {
  if (CUR === 'settings') { alert('设置项不能新增,直接改上面的值就行。'); return; }
  if (CUR === 'anniv') {
    DATA.anniv.push({ month: 1, day: 1, since_year: 0, name: '新纪念日' });
  } else if (CUR === 'vault') {
    DATA.vault.push({ ssid: '', password: '', label: '', auth: 1, favorite: false });
  } else {
    DATA[CUR].push({ title: '新任务', note: '', done: false, priority: 0 });
  }
  renderAll();
}

async function save() {
  try {
    const r = await fetch('/api/admin/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: CUR, value: DATA[CUR] }),
    });
    const j = await r.json();
    if (j.ok) {
      banner('已保存「' + LABELS[CUR] + '」。设备下次刷新就会拿到新内容。', true);
    } else {
      banner('没保存成:' + (j.reason || '未知原因'), false);
    }
  } catch (e) {
    banner('保存失败: ' + e.message, false);
  }
}

boot();
</script>
</body>
</html>`;
