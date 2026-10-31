// ==UserScript==
// @name         夸克 → Gopeed
// @namespace    markgeen.quark.gopeed
// @version      1.5.1
// @description  在夸克分享页把文件解析成直链，直接交给 Gopeed；按目录懒加载，只给要下的文件取链
// @author       markgeen
// @match        *://pan.quark.cn/*
// @match        *://drive.quark.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_cookie
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------ 夸克接口 ------------------------------ */

  var API_TOKEN = 'https://pan.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc';
  var API_DETAIL = 'https://pan.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc';
  var API_DOWNLOAD = 'https://drive-pc.quark.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=ucpro';

  // 取直链必须伪装成夸克 PC 客户端，否则会被判成「游客」并受大小限制（23018）
  var DOWNLOAD_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 ' +
    'Safari/537.36 Channel/pckk_other_ch';

  var PAGE_SIZE = 100;
  var LINK_BATCH = 15;
  var BULK_LIMIT = 500;

  function gmRequest(options) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url: options.url,
        data: options.data,
        headers: options.headers || {},
        withCredentials: true,
        timeout: 30000,
        onload: function (res) {
          resolve(res);
        },
        onerror: function () {
          reject(new Error('网络请求失败'));
        },
        ontimeout: function () {
          reject(new Error('请求超时'));
        },
      });
    });
  }

  async function api(url, method, body, extraHeaders) {
    var headers = extraHeaders ? Object.assign({}, extraHeaders) : {};
    if (body) headers['Content-Type'] = 'application/json;charset=UTF-8';
    var res = await gmRequest({
      url: url,
      method: method,
      data: body ? JSON.stringify(body) : undefined,
      headers: headers,
    });
    var json;
    try {
      json = JSON.parse(res.responseText);
    } catch (e) {
      throw new Error('接口返回异常（HTTP ' + res.status + '）');
    }
    if (json && (json.code === 40001 || json.code === 10000)) {
      throw new Error('未登录或 Cookie 失效，请先登录夸克');
    }
    return json;
  }

  /* ------------------------------ 提取码/令牌 ------------------------------ */

  function parseShareFromUrl() {
    var m = location.pathname.match(/\/(?:s|share)\/([A-Za-z0-9]+)/);
    if (!m) return null;

    var pwd = '';
    var q = location.href.match(/[?&#](?:pwd|password|pw|passcode)=([A-Za-z0-9]{4})/i);
    if (q) pwd = q[1];

    // 页面进到子目录时，hash 里会带当前目录 fid，直接从这里起步
    var dirFid = '';
    var d = location.href.match(/#\/list\/share\/([A-Za-z0-9]+)/);
    if (d) dirFid = d[1];

    return { shareId: m[1], passcode: pwd, dirFid: dirFid };
  }

  function rawObject(obj) {
    try {
      return obj.wrappedJSObject || obj;
    } catch (e) {
      return obj;
    }
  }

  function fibersOf(node) {
    var raw = rawObject(node);
    var keys = [];
    try {
      keys = Object.keys(raw);
    } catch (e) {
      keys = [];
    }
    var out = [];
    for (var i = 0; i < keys.length; i += 1) {
      if (
        keys[i].indexOf('__reactFiber$') !== 0 &&
        keys[i].indexOf('__reactInternalInstance$') !== 0
      ) {
        continue;
      }
      try {
        out.push(raw[keys[i]]);
      } catch (e) {
        /* 忽略 */
      }
    }
    return out;
  }

  /** 深扫 React fiber 树找 stoken / passcode，不依赖 class 选择器 */
  function deepScanFiber(out) {
    var seeds = [];
    var sels = ['#root', '#app', '#main', 'body'];
    for (var s = 0; s < sels.length; s += 1) {
      var el = null;
      try {
        el = document.querySelector(sels[s]);
      } catch (e) {
        el = null;
      }
      if (!el) continue;
      seeds = seeds.concat(fibersOf(el));
    }

    var seen = 0;
    var stack = seeds.slice();
    while (stack.length && seen < 30000 && !out.stoken) {
      var fiber = stack.pop();
      seen += 1;
      if (!fiber) continue;

      var props = null;
      try {
        props = fiber.memoizedProps;
      } catch (e) {
        props = null;
      }
      if (props && typeof props === 'object') {
        try {
          if (!out.stoken && typeof props.stoken === 'string' && props.stoken) {
            out.stoken = props.stoken;
          }
          if (
            !out.passcode &&
            typeof props.passcode === 'string' &&
            /^[A-Za-z0-9]{4}$/.test(props.passcode)
          ) {
            out.passcode = props.passcode;
          }
        } catch (e) {
          /* 忽略 */
        }
      }

      try {
        if (fiber.child) stack.push(fiber.child);
      } catch (e) {}
      try {
        if (fiber.sibling) stack.push(fiber.sibling);
      } catch (e) {}
    }

    try {
      var win = pageWindow();
      var stat = win.factStat;
      if (stat) {
        var dump = JSON.stringify(stat) || '';
        if (!out.stoken) {
          var st = dump.match(/"stoken"\s*:\s*"([^"]+)"/);
          if (st && st[1]) out.stoken = st[1];
        }
        if (!out.passcode) {
          var pc = dump.match(/"(?:passcode|pwd)"\s*:\s*"([A-Za-z0-9]{4})"/i);
          if (pc) out.passcode = pc[1];
        }
      }
    } catch (e) {
      /* factStat 可能不可序列化 */
    }

    return seen;
  }

  /**
   * 复用页面已经换到的令牌：你在网页里输过提取码，页面就有 stoken，
   * 拿它就不必再向你要提取码。
   */
  function readFromPageState(shareId) {
    var out = { stoken: '', passcode: '', source: '', diag: '' };
    var scanned = deepScanFiber(out);
    if (out.stoken) out.source = '复用页面令牌';

    var storageHits = 0;
    if (!out.stoken || !out.passcode) {
      var win = pageWindow();
      var stores = [];
      try {
        stores.push(win.sessionStorage);
      } catch (e) {}
      try {
        stores.push(win.localStorage);
      } catch (e) {}

      stores.forEach(function (store) {
        if (!store) return;
        var len = 0;
        try {
          len = store.length;
        } catch (e) {
          return;
        }
        for (var i = 0; i < len; i += 1) {
          var key = '';
          var value = '';
          try {
            key = store.key(i) || '';
          } catch (e) {
            continue;
          }
          try {
            value = store.getItem(key) || '';
          } catch (e) {
            continue;
          }
          if (value.indexOf(shareId) < 0) continue;
          storageHits += 1;

          if (!out.stoken) {
            var st = value.match(/"stoken"\s*:\s*"([^"]+)"/);
            if (st && st[1]) {
              out.stoken = st[1];
              out.source = 'storage';
            }
          }
          if (!out.passcode) {
            var pc = value.match(/"(?:passcode|pwd|password)"\s*:\s*"([A-Za-z0-9]{4})"/i);
            if (pc) out.passcode = pc[1];
          }
        }
      });
    }

    out.diag = 'fiber ' + scanned + ' 节点，storage 命中 ' + storageHits + ' 项';
    return out;
  }

  async function getToken(shareId, passcode) {
    var body = await api(API_TOKEN, 'POST', { pwd_id: shareId, passcode: passcode || '' });
    if (body.code === 31001 || /提取码/.test(String(body.message || ''))) {
      throw new Error(
        '这个分享需要提取码。请先在网页上输入提取码（不要在本插件里输），' +
          '页面接受后直接再点一次「夸克直链」，插件会复用页面已经换到的令牌。',
      );
    }
    if (body.code === 31002) throw new Error('分享已失效或被取消');
    if (body.code !== 0) throw new Error('获取分享信息失败：' + (body.message || body.code));
    return body.data || {};
  }

  /* ------------------------------ 目录读取 ------------------------------ */

  async function listPage(shareId, stoken, pdirFid, page) {
    var url =
      API_DETAIL +
      '&pwd_id=' + encodeURIComponent(shareId) +
      '&stoken=' + encodeURIComponent(stoken) +
      '&pdir_fid=' + encodeURIComponent(pdirFid || '0') +
      '&_page=' + page +
      '&_size=' + PAGE_SIZE +
      '&_sort=file_type:asc,updated_at:desc';
    var body = await api(url, 'GET');
    if (body.code !== 0) throw new Error('获取目录失败：' + (body.message || body.code));
    var data = body.data || {};
    return data.list || [];
  }

  /** 只读当前这一层，不递归 */
  async function loadDir(shareId, stoken, dirFid) {
    var items = [];
    for (var page = 1; page <= 50; page += 1) {
      var list = await listPage(shareId, stoken, dirFid, page);
      items = items.concat(list);
      if (list.length < PAGE_SIZE) break;
    }
    return items.map(function (item) {
      return {
        fid: item.fid,
        fidToken: item.share_fid_token,
        name: item.file_name,
        size: Number(item.size || 0),
        dir: !!item.dir,
      };
    });
  }

  /* ------------------------------ 取直链 ------------------------------ */

  /** 返回 { links: {fid: url}, errors: {fid: message} }；单批失败不影响其它批 */
  async function getDirectLinks(shareId, stoken, files) {
    var links = {};
    var errors = {};
    for (var i = 0; i < files.length; i += LINK_BATCH) {
      var batch = files.slice(i, i + LINK_BATCH);
      try {
        var body = await api(
          API_DOWNLOAD,
          'POST',
          {
            fids: batch.map(function (f) {
              return f.fid;
            }),
            fids_token: batch.map(function (f) {
              return f.fidToken;
            }),
            pwd_id: shareId,
            stoken: stoken,
          },
          { 'User-Agent': DOWNLOAD_UA },
        );

        if (body.code === 23018) {
          batch.forEach(function (f) {
            errors[f.fid] = '游客大小限制(23018)';
          });
        } else if (body.code !== 0) {
          var msg = '接口错误 ' + body.code + (body.message ? '：' + body.message : '');
          batch.forEach(function (f) {
            errors[f.fid] = msg;
          });
        } else {
          var data = Array.isArray(body.data) ? body.data : (body.data && body.data.list) || [];
          for (var j = 0; j < batch.length; j += 1) {
            var hit = null;
            for (var k = 0; k < data.length; k += 1) {
              if (data[k] && data[k].fid === batch[j].fid) {
                hit = data[k];
                break;
              }
            }
            if (!hit && data[j]) hit = data[j];
            if (hit && hit.download_url) links[batch[j].fid] = hit.download_url;
            else errors[batch[j].fid] = '本条未返回直链';
          }
        }
      } catch (err) {
        var reason = (err && err.message) || '请求失败';
        batch.forEach(function (f) {
          errors[f.fid] = reason;
        });
      }
      if (i + LINK_BATCH < files.length) {
        await new Promise(function (r) {
          setTimeout(r, 700);
        });
      }
    }
    return { links: links, errors: errors };
  }

  /* -------------------------------- 工具 -------------------------------- */

  function humanSize(n) {
    if (!n) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return v.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  }

  function toast(text, ms) {
    var el = document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'position:fixed;left:50%;bottom:120px;transform:translateX(-50%);' +
      'background:rgba(20,20,20,.94);color:#fff;padding:10px 16px;border-radius:10px;' +
      'font-size:14px;z-index:2147483647;max-width:86vw;line-height:1.5;white-space:pre-wrap;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35)';
    document.body.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, ms || 2400);
  }

  function pageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  async function sendToGopeed(url, label) {
    var win = pageWindow();
    if (win.navigator && typeof win.navigator.share === 'function') {
      try {
        await win.navigator.share({ title: label || '发送到 Gopeed', text: url });
        return;
      } catch (e) {
        /* 用户取消或不支持 */
      }
    }
    GM_setClipboard(url, 'text');
    toast('直链已复制，去 Gopeed 粘贴即可');
  }

  async function copyFullCookie() {
    var text = '';
    if (typeof GM_cookie !== 'undefined' && GM_cookie.list) {
      try {
        var list = await new Promise(function (resolve, reject) {
          GM_cookie.list({ domain: 'quark.cn' }, function (cookies, error) {
            if (error) reject(error);
            else resolve(cookies || []);
          });
        });
        text = list
          .map(function (c) {
            return c.name + '=' + c.value;
          })
          .join('; ');
      } catch (e) {
        text = '';
      }
    }
    if (!text) text = document.cookie;
    if (!text) {
      toast('没拿到 Cookie，请确认已登录');
      return;
    }
    GM_setClipboard(text, 'text');
    toast(
      'Cookie 已复制（' + (/(^|;\s*)__puus=/.test(text) ? '含 __puus ✓' : '缺少 __puus ⚠') + '）',
      3200,
    );
  }

  /* --------------------------------- UI --------------------------------- */

  var state = {
    open: false,
    busy: false,
    shareId: '',
    stoken: '',
    dirFid: '0',
    stack: [],
    entries: [],
    links: {},
    errors: {},
    source: '',
    diag: '',
    status: '',
  };

  function closePanel() {
    var m = document.getElementById('qk-modal');
    if (m) m.remove();
    state.open = false;
  }

  function openPanel() {
    if (state.open) {
      closePanel();
      return;
    }
    state.open = true;

    var mask = document.createElement('div');
    mask.id = 'qk-modal';
    mask.style.cssText =
      'position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.55);' +
      'display:flex;align-items:flex-end;justify-content:center;';

    var sheet = document.createElement('div');
    sheet.style.cssText =
      'width:100%;max-height:80vh;background:#1c1c1e;border-radius:16px 16px 0 0;' +
      'display:flex;flex-direction:column;overflow:hidden;';

    var head = document.createElement('div');
    head.style.cssText =
      'padding:14px 16px;display:flex;align-items:center;justify-content:space-between;' +
      'border-bottom:1px solid #2c2c2e;flex:0 0 auto;';
    head.innerHTML = '<span style="color:#fff;font-size:15px;font-weight:600">解析直链</span>';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText =
      'background:none;border:none;color:#8e8e93;font-size:14px;cursor:pointer';
    closeBtn.onclick = closePanel;
    head.appendChild(closeBtn);

    var body = document.createElement('div');
    body.id = 'qk-body';
    body.style.cssText =
      'overflow-y:auto;padding:8px 12px 24px;color:#e5e5e7;font-size:13px;';
    body.textContent = '正在解析…';

    sheet.appendChild(head);
    sheet.appendChild(body);
    mask.appendChild(sheet);
    mask.addEventListener('click', function (e) {
      if (e.target === mask) closePanel();
    });
    document.body.appendChild(mask);

    runResolve();
  }

  function makeRow(text, color) {
    var btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText =
      'padding:9px 12px;border:none;border-radius:9px;background:' + color +
      ';color:#fff;font-size:13px;font-weight:600;flex:0 0 auto';
    return btn;
  }

  function renderDir() {
    var body = document.getElementById('qk-body');
    if (!body) return;

    body.innerHTML = '';

    // 面包屑 + 返回
    var crumb = document.createElement('div');
    crumb.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 2px 8px;';
    var pathText = document.createElement('div');
    pathText.style.cssText =
      'flex:1;min-width:0;color:#8e8e93;font-size:11px;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap';
    var names = ['全部文件'].concat(
      state.stack.map(function (s) {
        return s.name;
      }),
    );
    pathText.textContent = names.join(' / ') + ' · ' + state.entries.length + ' 项';
    crumb.appendChild(pathText);

    if (state.stack.length) {
      var up = makeRow('↑ 上一级', '#3a3a3c');
      up.onclick = async function () {
        var parent = state.stack.pop();
        if (parent) await openDir(parent.fid);
      };
      crumb.appendChild(up);
    }
    body.appendChild(crumb);

    if (state.source) {
      var cap = document.createElement('div');
      cap.textContent = '令牌来源：' + state.source;
      cap.style.cssText = 'color:#636366;font-size:11px;padding:0 2px 6px';
      body.appendChild(cap);
    }

    if (state.status) {
      var st = document.createElement('div');
      st.textContent = state.status;
      st.style.cssText = 'color:#8e8e93;font-size:12px;padding:4px 2px';
      body.appendChild(st);
    }

    // 本目录批量（只针对当前层，不递归）
    var filesHere = state.entries.filter(function (e) {
      return !e.dir;
    });

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin:4px 0 10px;';

    if (filesHere.length > 1) {
      var bulk = makeRow('本目录直链 ' + filesHere.length, '#2b6cb0');
      bulk.style.flex = '1';
      bulk.onclick = function () {
        bulkResolve(filesHere);
      };
      actions.appendChild(bulk);
    }

    // 旧版「全量递归」保留为显式操作，不再作为默认行为
    var deep = makeRow('递归全量', '#8e44ad');
    deep.style.flex = '1';
    deep.onclick = runFullScan;
    actions.appendChild(deep);

    body.appendChild(actions);

    if (!state.entries.length) {
      var empty = document.createElement('div');
      empty.textContent = '这个目录是空的';
      empty.style.cssText = 'color:#8e8e93;padding:12px 2px';
      body.appendChild(empty);
      return;
    }

    state.entries.forEach(function (entry) {
      var row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:9px 4px;border-bottom:1px solid #2a2a2c;';

      var info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      var name = document.createElement('div');
      name.textContent = entry.name;
      name.style.cssText =
        'color:#fff;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      var meta = document.createElement('div');
      var statusText = entry.dir
        ? '文件夹'
        : state.links[entry.fid]
          ? '已取链'
          : state.errors[entry.fid]
            ? '✗ ' + state.errors[entry.fid]
            : humanSize(entry.size);
      meta.textContent = statusText;
      meta.style.cssText =
        'color:' + (!entry.dir && state.errors[entry.fid] && !state.links[entry.fid] ? '#ff6961' : '#8e8e93') +
        ';font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      info.appendChild(name);
      info.appendChild(meta);

      var btn = makeRow(entry.dir ? '进入' : '→', entry.dir ? '#3a3a3c' : '#22a06b');
      btn.onclick = async function () {
        if (entry.dir) {
          state.stack.push({ fid: state.dirFid, name: entry.name });
          await openDir(entry.fid);
          return;
        }

        var url = state.links[entry.fid];
        if (!url) {
          btn.textContent = '…';
          try {
            var got = await getDirectLinks(state.shareId, state.stoken, [entry]);
            url = got.links[entry.fid];
            if (url) {
              state.links[entry.fid] = url;
              delete state.errors[entry.fid];
              meta.textContent = '已取链';
              meta.style.color = '#8e8e93';
            } else {
              var why = got.errors[entry.fid] || '未返回直链';
              state.errors[entry.fid] = why;
              meta.textContent = '✗ ' + why;
              meta.style.color = '#ff6961';
              toast('该文件取链失败：' + why, 3200);
            }
          } catch (e) {
            toast('取链失败：' + e.message);
          }
          btn.textContent = '→';
        }
        if (url) sendToGopeed(url, entry.name);
      };

      row.appendChild(info);
      row.appendChild(btn);
      body.appendChild(row);
    });
  }

  /** 递归整个目录树（旧版「全量扫描」行为），带进度回调 */
  async function walkAll(dirFid, onProgress, limit) {
    var max = limit || BULK_LIMIT;
    var queue = [dirFid || '0'];
    var seen = {};
    var files = [];
    while (queue.length && files.length < max) {
      var dir = queue.shift();
      if (seen[dir]) continue;
      seen[dir] = 1;

      var items = await loadDir(state.shareId, state.stoken, dir);
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].dir) queue.push(items[i].fid);
        else files.push(items[i]);
        if (files.length >= max) break;
      }
      if (onProgress) onProgress(files.length);
    }
    return files;
  }

  /** 显式全量：递归当前目录及子文件夹，取全部直链并复制 */
  async function runFullScan() {
    var body = document.getElementById('qk-body');
    if (body) body.textContent = '递归扫描中…';
    try {
      var files = await walkAll(state.dirFid, function (n) {
        if (body) body.textContent = '递归扫描中…已发现 ' + n + ' 个文件';
      });
      if (!files.length) throw new Error('当前目录及其子目录里没有文件');
      state.status = '递归完成：' + files.length + ' 个文件';
      renderDir();
      await bulkResolve(files);
    } catch (e) {
      state.status = '递归扫描失败：' + e.message;
      renderDir();
    }
  }

  async function bulkResolve(files) {    var body = document.getElementById('qk-body');
    var list = files.slice(0, BULK_LIMIT);
    if (body) body.textContent = '正在取 ' + list.length + ' 个文件的直链…';

    try {
      var got = await getDirectLinks(state.shareId, state.stoken, list);
      Object.keys(got.links).forEach(function (fid) {
        state.links[fid] = got.links[fid];
      });
      Object.keys(got.errors).forEach(function (fid) {
        if (!state.links[fid]) state.errors[fid] = got.errors[fid];
      });

      var urls = list
        .map(function (f) {
          return state.links[f.fid];
        })
        .filter(Boolean);

      state.status = '已取 ' + urls.length + '/' + list.length + ' 条直链';
      renderDir();

      if (urls.length) {
        GM_setClipboard(urls.join('\n'), 'text');
        toast('已复制 ' + urls.length + ' 条直链到剪贴板', 3200);
      }
    } catch (e) {
      state.status = '批量取链失败：' + e.message;
      renderDir();
    }
  }

  async function openDir(fid) {
    var body = document.getElementById('qk-body');
    state.dirFid = fid || '0';
    state.status = '';
    if (body) body.textContent = '读取目录…';
    state.entries = await loadDir(state.shareId, state.stoken, state.dirFid);
    renderDir();
  }

  async function runResolve() {
    var body = document.getElementById('qk-body');
    if (state.busy) return;
    state.busy = true;

    try {
      var parsed = parseShareFromUrl();
      if (!parsed) throw new Error('当前页面不是分享页（/s/…）');

      var fromPage = readFromPageState(parsed.shareId);
      state.diag = fromPage.diag || '';
      var passcode = parsed.passcode || fromPage.passcode || '';
      var stoken = fromPage.stoken || '';
      var source = stoken ? '复用页面令牌' : '';

      if (!stoken) {
        var token = await getToken(parsed.shareId, passcode);
        stoken = token.stoken || '';
        if (!stoken) throw new Error('未取到 stoken');
        source = passcode ? '用提取码换令牌' : '免密分享';
      }

      state.shareId = parsed.shareId;
      state.stoken = stoken;
      state.source = source;
      state.stack = [];
      state.links = {};
      state.errors = {};

      // 只读当前层：页面在子目录里就从子目录起步
      await openDir(parsed.dirFid || '0');
    } catch (err) {
      if (body) {
        body.innerHTML = '';
        var p = document.createElement('div');
        var msg = err && err.message ? err.message : String(err);
        if (state.diag) msg += '\n（诊断：' + state.diag + '）';
        p.textContent = '解析失败：' + msg;
        p.style.cssText =
          'color:#ff6961;padding:12px 4px;line-height:1.6;white-space:pre-wrap';
        body.appendChild(p);
      }
    } finally {
      state.busy = false;
    }
  }

  /* ------------------------------- 挂载 -------------------------------- */

  function mount() {
    if (document.getElementById('qk-fab')) return;

    var fab = document.createElement('button');
    fab.id = 'qk-fab';
    fab.textContent = '夸克直链';
    fab.style.cssText =
      'position:fixed;right:12px;bottom:96px;z-index:2147483644;' +
      'padding:11px 15px;border:none;border-radius:22px;background:#22a06b;color:#fff;' +
      'font-size:13px;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.4)';
    fab.onclick = function () {
      if (!/^\/(s|share)\//.test(location.pathname)) {
        toast('请先打开一个夸克分享链接');
        return;
      }
      openPanel();
    };
    document.body.appendChild(fab);

    var cookieBtn = document.createElement('button');
    cookieBtn.id = 'qk-fab-cookie';
    cookieBtn.textContent = 'Cookie';
    cookieBtn.style.cssText =
      'position:fixed;right:12px;bottom:150px;z-index:2147483644;' +
      'padding:7px 12px;border:none;border-radius:16px;background:#2b6cb0;color:#fff;' +
      'font-size:11px;opacity:.9';
    cookieBtn.onclick = copyFullCookie;
    document.body.appendChild(cookieBtn);
  }

  var lastPath = '';
  setInterval(function () {
    if (!document.body) return;
    if (location.pathname === lastPath && document.getElementById('qk-fab')) return;
    lastPath = location.pathname;
    var old = document.getElementById('qk-fab');
    if (old) old.remove();
    var oldC = document.getElementById('qk-fab-cookie');
    if (oldC) oldC.remove();
    mount();
  }, 1200);
})();
