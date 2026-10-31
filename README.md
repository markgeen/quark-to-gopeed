# 夸克 → Gopeed

把夸克网盘分享链接解析成**直链**，交给 [Gopeed](https://gopeed.com/) 或任意下载器下载。

**不转存、不占你网盘空间**，支持提取码、文件夹逐层浏览。

---

## 下载

| 我想… | 下这个 | 难度 |
| --- | --- | --- |
| 在浏览器里把夸克分享变成直链 | **[quark-to-gopeed.user.js](https://github.com/markgeen/quark-to-gopeed/raw/main/quark-to-gopeed.user.js)** | ⭐ 装个 Tampermonkey 就行 |
| 让 Gopeed 自己解析分享链接 | **[gopeed-extension.zip](https://github.com/markgeen/quark-to-gopeed/releases/latest)** | ⭐⭐⭐ 需要 root |

> **只想把文件下下来，第一个就够了。** 第二个是给「把分享链接直接丢进 Gopeed」这种用法准备的，不是必需品。

---

## 30 秒上手

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 点上面的 **[quark-to-gopeed.user.js](https://github.com/markgeen/quark-to-gopeed/raw/main/quark-to-gopeed.user.js)** → Tampermonkey 会弹出安装页 → 点「安装」
3. 打开任意 `pan.quark.cn/s/...` 分享页
4. 右下角点绿色「**夸克直链**」→ 点文件后面的「**→**」

**有提取码的分享**：先在网页上输入提取码，等文件列表出来，再点「夸克直链」。插件不会弹窗问你要提取码，它直接复用页面已经换到的令牌。

**手机上**：Firefox for Android 装 Tampermonkey，步骤完全一样。点「→」后会弹系统分享面板，选 Gopeed 就能开始下载。

---

## 两种取链模式

| | 懒加载（默认） | 递归全量（手动点） |
| --- | --- | --- |
| 读取范围 | 只读当前这一层目录 | 当前目录 + 全部子文件夹 |
| 取链时机 | 点哪个文件才取哪个 | 收集全部后批量取 |
| 请求量 | 通常 1–2 个 | 与文件数成正比 |
| 适合 | 只要其中一两个文件 | 整个游戏包 / 整个文件夹 |

---

## Gopeed 扩展（可选，进阶）

### 它解决什么问题

让 **Gopeed 自己**解析夸克分享链接：把 `pan.quark.cn/s/...` 直接粘贴进 Gopeed，扩展在内部取直链并建任务。

如果你已经用浏览器脚本取到直链，**不需要装它**。

### 前提

需要在扩展设置里填一次夸克 Cookie：

1. 浏览器打开 `pan.quark.cn` 并登录
2. 点页面右下角「Cookie」按钮（复制完整 Cookie，含 httpOnly 项）
3. Gopeed → 扩展 → 本扩展 → 设置 → 夸克 Cookie → 粘贴

之后 Cookie 会存在 Gopeed 里，运行时自动轮换续期，不用再填。

### 安装方式（需要 root 或 adb）

Gopeed 的 Android 版没有「从文件安装扩展」的入口，扩展目录在应用私有存储里。实测可用的做法：

1. 从 [Releases](https://github.com/markgeen/quark-to-gopeed/releases/latest) 下载 `gopeed-extension.zip`，解压得到 `manifest.json`、`icon.png`、`dist/index.js`
2. 拷到手机：

```bash
adb push manifest.json icon.png dist /sdcard/gopeed-ext/
adb shell su -c "mkdir -p /data/data/com.gopeed.gopeed/files/extensions/markgeen@quark-nosave/dist"
adb shell su -c "cp /sdcard/gopeed-ext/manifest.json /sdcard/gopeed-ext/icon.png /data/data/com.gopeed.gopeed/files/extensions/markgeen@quark-nosave/"
adb shell su -c "cp /sdcard/gopeed-ext/dist/index.js /data/data/com.gopeed.gopeed/files/extensions/markgeen@quark-nosave/dist/"
adb shell su -c "chown -R u0_a546:u0_a546 /data/data/com.gopeed.gopeed/files/extensions/markgeen@quark-nosave"
```

3. 重启 Gopeed，扩展页出现「夸克分享·免转存直链」

> `u0_a546` 是 Gopeed 在这台机器上的 uid，换机器请用 `adb shell su -c "stat -c %U /data/data/com.gopeed.gopeed/files"` 查一下。

---

## 工作原理

夸克的分享下载链路：

```text
POST pan.quark.cn/1/clouddrive/share/sharepage/token
     { pwd_id, passcode }                    → stoken

GET  pan.quark.cn/1/clouddrive/share/sharepage/detail
     ?pwd_id&stoken&pdir_fid&_page&_size     → 目录列表（fid / share_fid_token）

POST drive-pc.quark.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=ucpro
     { fids, fids_token, pwd_id, stoken }    → download_url（直链）
```

关键在第三步：带上 `pwd_id + stoken + fids_token` 时，接口**直接返回分享文件的直链**，不需要先把文件转存到自己网盘。

常见的夸克下载器走的是另一条路（`sharepage/save` 转存 → 轮询任务 → 下载 → 删除），网盘空间不足就会失败。本项目不碰转存，所以不受空间限制。

### 两个必须处理的细节

**客户端 UA** — 取直链必须伪装成夸克 PC 客户端：

```text
Mozilla/5.0 ... quark-cloud-drive/3.20.0 Chrome/112 ... Channel/pckk_other_ch
```

否则即使带着登录 Cookie，也会被判成「游客」并返回 `23018`（超出游客可获取大小限制）。

**提取码** — 提取码只是换取 `stoken` 的凭证。你在网页输过之后，页面已持有 `stoken`，脚本直接复用：先深扫 React fiber 树，再退到 `sessionStorage` / `localStorage`，最后才看 URL 里的 `?pwd=`。

---

## 已知限制

- **必须登录**：未登录也能解析，但受游客单文件大小限制（`23018`）
- **直链会过期**：`auth_key` 带有效期（通常 6 小时），过期需重新取链
- **风控**：短时间大量调用会被限流，递归全量时尤其明显
- **接口依赖**：夸克改版可能导致失效
- **仅夸克**：只处理 `pan.quark.cn` / `drive.quark.cn` 的分享页

---

## 致谢

本项目的思路与接口用法来自以下社区项目：

| 项目 | 作者 | 参考了什么 |
| --- | --- | --- |
| [LinkSwift](https://github.com/hmjz100/LinkSwift) | hmjz100 | 夸克分享页取链路径：`token` → `detail` → `file/download`，以及 `pwd_id + stoken + fids_token` 的分享上下文直链、伪装客户端 UA 的做法 |
| [网盘直链下载助手](https://github.com/syhyz1990/baiduyun) | 油小猴 | LinkSwift 的上游，多网盘直链提取的原始实现 |
| [gopeed-extension-quark](https://github.com/iGwkang/gopeed-extension-quark) | iGwkang | Gopeed 插件的工程结构与 `onResolve` / `onStart` 用法 |
| [gopeed-extension-quark](https://github.com/muyan556/gopeed-extension-quark) | muyan556 | 转存式流程（save → 轮询 → download → 删除）的参考实现 |
| [Gopeed](https://gopeed.com/) | Gopeed | 下载器本体与扩展运行时 |

本项目代码为独立实现，未直接复制上述项目源码。若继续复用它们代码，请遵循其原始许可证并保留署名。

---

## 免责声明

本项目仅用于技术研究与个人便利，所有请求均使用使用者自己的账号 Cookie，不绕过任何付费内容。

使用本脚本可能违反夸克网盘的用户协议，存在账号被风控或限制的风险，请自行评估。

---

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

[MIT](LICENSE)
