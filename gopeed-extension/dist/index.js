/*!
 * Gopeed 夸克分享「免转存」直链扩展
 *
 * 与常见夸克扩展的关键差异：
 *   常见实现：sharepage/token → detail → sharepage/save(转存) → task 轮询 → file/download → delete
 *   本实现  ：sharepage/token → detail → file/download（带分享上下文参数）
 *
 * 取链请求体：
 *   { fids, fids_token, pwd_id, stoken }
 * 因为带了 pwd_id + stoken + fids_token，夸克会直接返回分享文件的 download_url，
 * 不需要先把文件转存到自己网盘，所以网盘空间为 0 也能下载。
 */
(function () {
  'use strict';

  var PAN_ORIGIN = 'https://pan.quark.cn';
  var DRIVE_BASE = 'https://drive-pc.quark.cn';

  // 接口调用用的 UA（与网页端一致）
  var API_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 ' +
    'Safari/537.36 Channel/pckk_other_ch';

  // 下载直链必须用这个 UA，否则 403
  var DOWNLOAD_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 ' +
    'Safari/537.36 Channel/pckk_other_ch';

  var PAGE_SIZE = 100;
  var LINK_BATCH = 15;
  var LINK_INTERVAL_MS = 1000;
  var STORE_JAR = 'quark_cookie_jar';
  var EXT_LABEL = 'markgeen@quark-nosave';

  function logs() {
    if (typeof gopeed !== 'undefined' && gopeed && gopeed.logger) return gopeed.logger;
    return console;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /** 用户可见错误：Gopeed 会弹提示而不是继续创建任务 */
  function fail(message) {
    if (typeof MessageError === 'function') throw new MessageError(message);
    throw new Error(message);
  }

  /* ------------------------------- Cookie ------------------------------- */

  function parseCookiePairs(text) {
    var map = {};
    String(text || '')
      .split(';')
      .forEach(function (part) {
        var p = part.trim();
        if (!p) return;
        var eq = p.indexOf('=');
        if (eq <= 0) return;
        map[p.slice(0, eq).trim()] = p.slice(eq + 1);
      });
    return map;
  }

  function buildCookie(base, jar) {
    var map = parseCookiePairs(base);
    var overlay = parseCookiePairs(jar);
    Object.keys(overlay).forEach(function (key) {
      map[key] = overlay[key];
    });
    return Object.keys(map)
      .map(function (key) {
        return key + '=' + map[key];
      })
      .join('; ');
  }

  function readJar() {
    try {
      return gopeed.storage.get(STORE_JAR) || '';
    } catch (e) {
      return '';
    }
  }

  function getCookie() {
    var base = String((gopeed.settings && gopeed.settings.cookie) || '').trim();
    var jar = readJar();
    if (!base && !jar) {
      fail('未配置 Cookie：请在扩展设置里填入夸克 Cookie（需包含 __puus）');
    }
    return buildCookie(base, jar);
  }

  /**
   * 夸克每次响应都会轮换 __puus 等 cookie。
   * 这里维护一个完整 cookie 罐：设置项只当种子，运行期所有 set-cookie 都合并进来，
   * 只要还在用，就不必重新粘贴。
   */
  function absorbCookies(headers) {
    if (!headers) return;
    var list = [];
    try {
      if (typeof headers.getSetCookie === 'function') {
        list = headers.getSetCookie() || [];
      } else if (typeof headers.get === 'function') {
        var raw = headers.get('set-cookie');
        if (raw) list = Array.isArray(raw) ? raw : [raw];
      }
    } catch (e) {
      return;
    }
    if (!list.length) return;

    var pairs = [];
    list.forEach(function (line) {
      var text = String(line || '');
      // 跳过删除型 cookie，避免把有效值清空
      if (/max-age=0/i.test(text) || /expires=thu, 01 jan 1970/i.test(text)) return;
      var first = text.split(';')[0].trim();
      if (first && first.indexOf('=') > 0) pairs.push(first);
    });
    if (!pairs.length) return;

    var merged = buildCookie(readJar(), pairs.join('; '));
    if (merged.length > 6000) return;
    try {
      gopeed.storage.set(STORE_JAR, merged);
    } catch (e) {
      /* 忽略存储失败 */
    }
  }

  /* -------------------------------- HTTP -------------------------------- */

  async function apiRequest(url, method, body) {
    var headers = {
      Cookie: getCookie(),
      'User-Agent': API_UA,
      Referer: PAN_ORIGIN + '/',
      Origin: PAN_ORIGIN,
      Accept: 'application/json, text/plain, */*',
    };
    if (body) headers['Content-Type'] = 'application/json;charset=UTF-8';

    var response = await fetch(url, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    absorbCookies(response.headers);

    var text = await response.text();
    var json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      fail('接口返回异常（HTTP ' + response.status + '）：' + String(text).slice(0, 120));
    }
    if (json && (json.code === 40001 || json.code === 10000)) {
      fail('Cookie 已失效或登录过期，请重新复制（代码 ' + json.code + '）');
    }
    return json;
  }

  /* ------------------------------ 夸克接口 ------------------------------ */

  async function apiGetToken(shareId, passcode) {
    var body = await apiRequest(
      PAN_ORIGIN + '/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
      'POST',
      { pwd_id: shareId, passcode: passcode || '' },
    );
    if (body.code === 31001) fail('该分享需要提取码：请在链接末尾加上 ?pwd=提取码');
    if (body.code === 31002) fail('分享链接已失效或被取消');
    if (body.code !== 0) fail('获取分享信息失败：' + (body.message || body.code));
    return body.data || {};
  }

  async function apiDetailPage(shareId, stoken, pdirFid, page) {
    var url =
      PAN_ORIGIN +
      '/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc' +
      '&pwd_id=' +
      encodeURIComponent(shareId) +
      '&stoken=' +
      encodeURIComponent(stoken) +
      '&pdir_fid=' +
      encodeURIComponent(pdirFid || '0') +
      '&_page=' +
      page +
      '&_size=' +
      PAGE_SIZE +
      '&_sort=file_type:asc,updated_at:desc';
    var body = await apiRequest(url, 'GET');
    if (body.code !== 0) fail('获取分享目录失败：' + (body.message || body.code));
    var data = body.data || {};
    return {
      list: data.list || [],
      total: (data.metadata && data.metadata._total) || 0,
    };
  }

  async function listAllPages(shareId, stoken, pdirFid) {
    var items = [];
    var page = 1;
    for (;;) {
      var result = await apiDetailPage(shareId, stoken, pdirFid, page);
      items = items.concat(result.list);
      if (result.list.length < PAGE_SIZE) break;
      page += 1;
      if (page > 200) break;
    }
    return items;
  }

  function joinPath(parent, name) {
    return parent ? parent + '/' + name : name;
  }

  /** 递归展开目录；根下只有一个文件夹时展开它，避免「标题/标题」双层同名 */
  async function collectShareFiles(shareId, stoken, maxCount) {
    var files = [];
    var suggestedName = '';

    var rootItems = await listAllPages(shareId, stoken, '0');
    var rootDirs = rootItems.filter(function (item) {
      return item.dir;
    });
    var rootFiles = rootItems.filter(function (item) {
      return !item.dir;
    });

    var seed = rootItems;
    if (rootFiles.length === 0 && rootDirs.length === 1) {
      suggestedName = rootDirs[0].file_name || '';
      seed = await listAllPages(shareId, stoken, rootDirs[0].fid);
    }

    async function walk(items, parentPath) {
      for (var i = 0; i < items.length; i += 1) {
        if (maxCount > 0 && files.length >= maxCount) return;
        var item = items[i];
        if (item.dir) {
          var children = await listAllPages(shareId, stoken, item.fid);
          await walk(children, joinPath(parentPath, item.file_name));
          if (maxCount > 0 && files.length >= maxCount) return;
        } else {
          files.push({
            fid: item.fid,
            share_fid_token: item.share_fid_token,
            file_name: item.file_name,
            size: Number(item.size || 0),
            path: parentPath,
          });
        }
      }
    }

    await walk(seed, '');
    return { files: files, suggestedName: suggestedName };
  }

  /**
   * 核心：分享上下文直链。
   * 带 pwd_id + stoken + fids_token 请求 file/download，无需先转存。
   */
  async function apiGetShareLinks(shareId, stoken, files) {
    var collected = [];
    for (var i = 0; i < files.length; i += LINK_BATCH) {
      var batch = files.slice(i, i + LINK_BATCH);
      var body = await apiRequest(
        DRIVE_BASE + '/1/clouddrive/file/download?entry=ft&fr=pc&pr=ucpro',
        'POST',
        {
          fids: batch.map(function (f) {
            return f.fid;
          }),
          fids_token: batch.map(function (f) {
            return f.share_fid_token;
          }),
          pwd_id: shareId,
          stoken: stoken,
        },
      );

      if (body.code === 23018) {
        fail('触发夸克限制（23018）：未登录或超出游客可获取大小，请填入已登录的 Cookie');
      }
      if (body.code !== 0) {
        fail('获取直链失败：' + (body.message || '未知错误') + '（代码 ' + body.code + '）');
      }

      var list = Array.isArray(body.data) ? body.data : (body.data && body.data.list) || [];
      collected = collected.concat(list);

      if (i + LINK_BATCH < files.length) await sleep(LINK_INTERVAL_MS);
    }
    return collected;
  }

  /* ------------------------------- 事件 -------------------------------- */

  function readMaxCount() {
    var value = parseInt(gopeed.settings && gopeed.settings.max_file_count, 10);
    return isFinite(value) && value > 0 ? value : 0;
  }

  function parseShareUrl(raw) {
    var url = String(raw || '')
      .trim()
      .replace(/\[.*?\]/g, '');
    var shareId = '';
    var byPath = url.match(/\/(?:s|share)\/([A-Za-z0-9]+)/);
    if (byPath) shareId = byPath[1];
    else if (/^[A-Za-z0-9]{8,}$/.test(url)) shareId = url;
    if (!shareId) fail('无法从链接中识别分享 ID');

    var passcode = '';
    var byQuery = url.match(/[?&](?:pwd|password|pw)=([A-Za-z0-9]{4})/i);
    if (byQuery) passcode = byQuery[1];

    return { shareId: shareId, passcode: passcode };
  }

  gopeed.events.onResolve(async function (ctx) {
    try {
      var raw = (ctx.req && (ctx.req.rawUrl || ctx.req.url)) || '';
      var parsed = parseShareUrl(raw);
      logs().info('夸克免转存解析：' + parsed.shareId);

      var token = await apiGetToken(parsed.shareId, parsed.passcode);
      var stoken = token.stoken;
      if (!stoken) fail('分享令牌缺失（stoken）');

      var walked = await collectShareFiles(parsed.shareId, stoken, readMaxCount());
      var files = walked.files;
      if (files.length === 0) fail('分享中没有可下载的文件');

      var links = await apiGetShareLinks(parsed.shareId, stoken, files);
      if (links.length === 0) fail('接口未返回任何直链');

      var byFid = {};
      links.forEach(function (link) {
        if (link && link.fid) byFid[link.fid] = link;
      });

      var cookie = getCookie();
      var out = [];
      for (var i = 0; i < files.length; i += 1) {
        var file = files[i];
        var hit = byFid[file.fid];
        if (!hit) {
          for (var j = 0; j < links.length; j += 1) {
            if (
              links[j].file_name === file.file_name &&
              Number(links[j].size || -1) === Number(file.size)
            ) {
              hit = links[j];
              break;
            }
          }
        }
        if (!hit || !hit.download_url) continue;

        var labels = {};
        labels[EXT_LABEL] = '1';
        labels.shareId = parsed.shareId;
        labels.stoken = stoken;
        labels.shareFid = file.fid;
        labels.shareFidToken = file.share_fid_token;

        out.push({
          name: file.file_name,
          size: Number(hit.size || file.size || 0),
          path: file.path || '',
          req: {
            url: hit.download_url,
            labels: labels,
            extra: {
              header: {
                'User-Agent': DOWNLOAD_UA,
                Referer: PAN_ORIGIN + '/',
                Cookie: cookie,
              },
            },
          },
        });
      }

      if (out.length === 0) fail('直链与文件列表未能对应，请重试');
      if (out.length < files.length) {
        logs().warn('有 ' + (files.length - out.length) + ' 个文件未取到直链，已跳过');
      }

      ctx.res = {
        name: walked.suggestedName || token.title || token.share_name || parsed.shareId,
        files: out,
      };
      logs().info('解析完成：' + out.length + '/' + files.length + ' 个文件（未转存）');
    } catch (error) {
      var message = (error && error.message) || String(error);
      logs().error('夸克解析失败：' + message);
      if (typeof MessageError === 'function' && error instanceof MessageError) throw error;
      fail(message);
    }
  });

  gopeed.events.onStart(async function (ctx) {
    try {
      var req = ctx && ctx.task && ctx.task.meta && ctx.task.meta.req;
      var labels = req && req.labels;
      if (!labels || !labels.shareId || !labels.stoken || !labels.shareFid) return;

      var links = await apiGetShareLinks(labels.shareId, labels.stoken, [
        { fid: labels.shareFid, share_fid_token: labels.shareFidToken },
      ]);
      if (links[0] && links[0].download_url) {
        req.url = links[0].download_url;
        logs().debug('直链已刷新');
      }
    } catch (error) {
      logs().warn('刷新直链失败：' + ((error && error.message) || error));
    }
  });
})();
