# 夸克 → Gopeed

在夸克网盘分享页把文件解析成**直链**，一键交给 [Gopeed](https://gopeed.com/)（或任意下载器）下载。

**不转存、不占网盘空间**，支持提取码、文件夹逐层浏览。

> 一个 Tampermonkey 用户脚本，适配桌面（Edge / Chrome / Firefox）与 Firefox for Android。

---

## 特性

- **免转存** — 不调用 `sharepage/save`，直接走「分享上下文直链」，网盘空间为 0 也能下载
- **提取码自动复用** — 不在插件里向你索要提取码，直接复用网页里已经换到的 `stoken`
- **按目录懒加载** — 进哪层读哪层，点哪个文件才给哪个文件取链
- **递归全量** — 需要整个文件夹一次拿全时，手动触发递归收集 + 批量取链
- **文件夹支持** — 逐层进入，带面包屑与「上一级」
- **解除游客限制** — 伪装夸克 PC 客户端 UA，绕过 23018 单文件大小限制
- **一键复制 Cookie**（含 httpOnly），方便填进 Gopeed 的插件设置
- **发送方式** — Android 走系统分享面板（可直接选 Gopeed），桌面回退到剪贴板

---

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，把 `quark-to-gopeed.user.js` 的内容整段粘贴进去，保存
3. 打开任意 `pan.quark.cn/s/...` 分享页，右下角会出现绿色「夸克直链」按钮

---

## 使用

1. 打开夸克分享链接；**如果有提取码，先在网页上输入**（插件不会弹窗问你要）
2. 点右下角「夸克直链」
3. 面板会列出当前目录内容：
   - 文件夹 → 点「进入」逐层浏览
   - 文件 → 点「→」取该文件直链并发给 Gopeed
4. 需要整包时点「递归全量」，脚本会递归收集全部文件并批量取链，最后把直链一次性复制到剪贴板

### 两种模式怎么选

| | 懒加载（默认） | 递归全量（手动） |
| --- | --- | --- |
| 读取范围 | 仅当前目录层 | 当前目录 + 全部子文件夹 |
| 取链时机 | 点哪个文件才取哪个 | 收集全部后批量取 |
| 请求量 | 极少（通常 1–2 个） | 与文件数成正比 |
| 适用场景 | 只要其中一两个文件 | 整个游戏包 / 整个文件夹 |
| 输出 | 单条直链逐条发送 | 全部直链一次性复制 |

---

## 工作原理

夸克的分享下载链路是：

```text
POST pan.quark.cn/1/clouddrive/share/sharepage/token
     { pwd_id, passcode }                    → stoken

GET  pan.quark.cn/1/clouddrive/share/sharepage/detail
     ?pwd_id&stoken&pdir_fid&_page&_size     → 目录列表（含 fid / share_fid_token）

POST drive-pc.quark.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=ucpro
     { fids, fids_token, pwd_id, stoken }    → download_url（直链）
```

关键在第三步：带上 `pwd_id + stoken + fids_token` 时，接口会**直接返回分享文件的直链**，不需要先把文件转存到自己网盘。

常见的夸克下载器走的是另一条路（`sharepage/save` 转存 → 轮询任务 → 下载 → 删除），一旦网盘空间不足就会失败。本脚本不碰转存，所以不受空间限制。

### 两个必须处理的细节

**1. 客户端 UA**

取直链的请求必须伪装成夸克 PC 客户端：

```text
Mozilla/5.0 ... quark-cloud-drive/3.20.0 Chrome/112 ... Channel/pckk_other_ch
```

否则即使带着登录 Cookie，也会被判定为「游客」并返回 `23018`（超出游客可获取大小限制）。

**2. 提取码**

提取码只是换取 `stoken` 的凭证。你在网页里输过之后，页面已经持有 `stoken`，脚本直接复用它即可 —— 通过 React fiber 深扫页面状态拿到，拿不到再退到 `sessionStorage` / `localStorage`，最后才用 URL 里的 `?pwd=`。

---

## 已知限制

- **必须登录**：未登录也能解析，但会受游客单文件大小限制（`23018`）
- **直链会过期**：`auth_key` 里带有效期（通常 6 小时），过期需重新取链
- **风控**：短时间大量调用会被限流，递归全量时尤其明显，建议分批
- **接口依赖**：夸克改版可能导致失效，届时需要更新脚本
- **仅夸克**：目前只处理 `pan.quark.cn` / `drive.quark.cn` 的分享页

---

## 免责声明

本项目仅用于技术研究与个人便利，所有请求均使用使用者自己的账号 Cookie，不绕过任何付费内容。

使用本脚本可能违反夸克网盘的用户协议，存在账号被风控或限制的风险，请自行评估。因使用本脚本产生的一切后果由使用者自行承担。

---

## 可选：Gopeed 侧插件

`gopeed-extension/` 是一个 Gopeed 的 JS 扩展，作用是在 Gopeed 内部直接解析夸克分享链接（需要先在扩展设置里填 Cookie）。

如果你只用本脚本产出直链、再由 Gopeed 下载，**不需要**安装它。

---

## 致谢

- [LinkSwift](https://github.com/hmjz100/LinkSwift) 与 [网盘直链下载助手](https://github.com/syhyz1990/baiduyun)
  —— 本项目的接口用法（分享上下文取链、客户端 UA、`file/download` 参数组合）参考了这两个项目。
  本项目为独立实现，未复制其源码；若你在此基础上直接复用它们的代码，请遵循其原始许可证并保留署名。
- [Gopeed](https://gopeed.com/) —— 下载器。

---

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT
