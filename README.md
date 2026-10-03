# dsh-whale-bank · 鲸元银行

> 仓库：<https://github.com/yudangjiade/dsh-whale-bank> · 维护者：[@yudangjiade](https://github.com/yudangjiade)
> 票面素材与版面设计来自上游 dsh-web（Apache-2.0，署名见 [NOTICE](NOTICE)）

把 [dsh-web 全家桶](https://github.com/zhu1090093659/dsh-web) 里「使用统计 → Token 银行」的那个**鲸元券**剥离出来的独立 DSH 插件：不需要装整套 dsh-web，也不用装它的用量统计面板，单独一个包就能把 DeepSeek 官方通道的 token 台账铸成一张可保存 / 分享的票券。

![鲸元券票面（示例面额，由 scripts/preview.mjs 按客户端同一套版面比例合成）](docs/voucher-preview.png)

## 它做什么

- **铸券**：DeepSeek 官方通道（`deepseek` / `deepseek-official` 等路由）每消耗 N 个 token 铸 1 鲸元，N 默认 `1,000,000`，可配置。
- **票面**：把面额、`whale yuan` 币名、盖章式流水号与统计窗口盖在票券底图上，全部在浏览器本地 canvas 绘制。
- **保存 / 分享**：`保存图片` 导出 PNG；浏览器支持 `navigator.share` 时给出 `分享` 按钮。
- **台账**：从插件启用那一刻起折叠 `session/event` 流（请求归属 + 用量），落在 `$DSH_HOME/dsh-whale-bank/ledger.json`。
- **导入历史**：如果本机已经装了 `@linxin666/dsh-usage`，点一下「导入 dsh-usage 台账」就能把它已有的历史用量并进来（格式同构，只读它的文件），历史不会从零开始。插件首次启用且自身台账为空时也会自动导入一次。
- **口径可选**：默认只算 DeepSeek 官方通道；把 `includeAllProviders` 打开就算全部供应商。
- **费用估算**：DeepSeek 官方路由按官方峰谷价目表（北京时间工作日 09:00-12:00、14:00-18:00 为峰段，其余半价）估算 CNY 花费。

## 安装

### A. 本机 DSH（官方桌面客户端 / `dsh web`）

包本身零依赖（只用 Node 内置模块 + 宿主提供的 `@deepseek-ai/schemastery`），所以手动装最省事：

1. 从本包 tgz 解压到 profile 的 `node_modules`（**别直接拷源码目录**：源码里的
   `node_modules/@deepseek-ai/schemastery` 只是跑测试用的桩，会遮住宿主提供的真包）：
   ```bash
   mkdir -p "<DSH_HOME>/profiles/web/node_modules/dsh-whale-bank"
   tar -xzf dsh-whale-bank-0.1.0.tgz -C "<DSH_HOME>/profiles/web/node_modules/dsh-whale-bank" --strip-components=1
   ```
2. 在同一个 profile 的 `package.json` 里登记（两处都要）：
   ```json
   "dependencies": { "dsh-whale-bank": "file:<DSH_HOME>/bundled-plugins/dsh-whale-bank-0.1.0.tgz" },
   "dsh": { "profile": { "bundles": [ "...", "dsh-whale-bank" ] } }
   ```
3. 重启 DSH（桌面端重启客户端，CLI 端重启 `dsh web`），然后进 **设置 → 鲸元银行**。

> 卸载回滚：把 `bundles` 里那一项和 `dependencies` 里的条目删掉、删除 `node_modules/dsh-whale-bank`，重启即可；插件数据留在 `$DSH_HOME/dsh-whale-bank/`，想彻底清掉就连它一起删。

### B. 用 DSH 插件命令 / npm

```bash
dsh plugin --profile web add <本包 tgz 的绝对路径>
# 或从 GitHub 直接装（推荐，DSH 会自己拉取并解析依赖）
dsh plugin --profile web add github:yudangjiade/dsh-whale-bank
```
装完重启 `dsh web`。插件行 id 是 `whale-bank`（见 `cordis.patch.yml`）。

## 换票面贴图

底图就是 \`assets/jingyuan-note.jpg\`（当前 **1756x896**，随包分发）：

- 直接覆盖同名文件即可，**不用改代码**：文字位置全按图片宽高的比例计算，同宽高比的新图自动对齐。
- 想用无损图，把同尺寸的 \`jingyuan-note.png\` 放进去（候选列表第二位）；想换回 jpg 就删掉 png。
- 宿主按文件 mtime 失效缓存，并给 \`/api/whale-bank/art\` 带 ETag：**换图后刷新浏览器即可**，不必重启 DSH。

三行文字（面额 / \`whale yuan\` / 盖章流水号）的基线分别在票面高度的 71% / 75.5% / 80% 处，
字号上限 11.5% 高度并受 28% 宽度约束自动收缩 —— 换成比例差异较大的底图时，这几组数字是要重调的地方。

## 配置

配置走本插件自己的 `Config` schema，宿主会为这一行生成设置页（字段都是 `volatile()`，保存即生效、无需重挂）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉则不订阅事件、不注册路由 |
| `tokensPerYuan` | `1000000` | 多少 token 铸 1 鲸元。想复刻早期「1,081,639 鲸元」那种面额，设成 `1000` |
| `retainDays` | `180` | 台账保留天数（7–730），超期日期会在剪枝时丢弃 |
| `includeAllProviders` | `false` | 是否把非 DeepSeek 路由也算进票面（它们不估价） |
| `importDshUsageLedger` | `true` | 自身台账为空时，是否自动从 `$DSH_HOME/dsh-usage/usage-ledger.json` 导入一次 |

也可以在 profile 的 `cordis.patch.yml` 里直接写死：

```yaml
- insert:
    - id: whale-bank
      name: dsh-whale-bank
      config:
        tokensPerYuan: 1000
        includeAllProviders: false
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/whale-bank/state` | 票券状态：tokens / calls / cost / face / serial / 窗口 / 口径 |
| `POST` | `/api/whale-bank/import` | 从上游 `dsh-usage` 台账导入历史并返回新状态 |
| `GET` | `/api/whale-bank/art` | 票券底图 JPEG（随包分发） |

三条路由都只接受**回环请求**（回环 socket + 回环 Host + 浏览器同源标记；装了 `remote-web-ui` 时，已配对的局域网设备也放行），非回环一律 403，非 GET/POST 一律 405，响应 `cache-control: no-store`。

## 隐私

- 台账只保存**聚合 token 与费用**（按天 / provider / model），不含提示词、回复、文件路径、密钥。
- 不读取 `.credentials.yaml`，不查询任何余额接口，不发任何出网请求。
- 票券图片完全在浏览器本地生成，不上传。

## 与上游 dsh-usage 的关系

| | `@linxin666/dsh-usage` | 本插件 |
| --- | --- | --- |
| 体积 | 全家桶子包（余额、套餐、趋势图、侧栏卡片…） | 单包，只做鲸元券 |
| 依赖 | 需要 `dsh-web-settings` 家族桥接才能拿到设置表单 | 不依赖任何家族插件 |
| 数据 | 自己的台账 | 自己的台账 + 可选导入上游台账 |
| 美术 | 同一张票券底图（Apache-2.0，见 NOTICE） | 同左 |

票券的**版面与美术资产**来自 dsh-web（Apache-2.0），台账折叠思路、峰谷价目表与回环围栏的实现也参考了它；本仓库是按「独立包」重写的实现，附 NOTICE 与许可证。

## 已知限制

- 统计自插件首次启用起计，历史只有「导入上游台账」这一条补录途径（不解析会话日志）。
- 非 DeepSeek 路由不估价（`cost` 记 0），除非你自己扩展价目表。
- 面额上限为 9 位流水号；鲸元券只覆盖台账保留窗口内的用量，剪掉的日期会同步从票面消失。
- 面额是四舍五入到整数鲸元，最小面额 1。

## 开发与自测

```bash
npm run check   # node --check 两个文件
npm test        # 10 个冒烟用例：折叠 / 口径 / 汇率 / 落盘 / 导入 / 剪枝 / 路由围栏 / 客户端注册
```

`test/smoke.mjs` 不需要运行中的 DSH：Host 半用假 ctx 驱动，客户端半用假 `__ModuleLoader__` + 假 `react` 评估。
`node_modules/@deepseek-ai/schemastery/` 是**仅测试用的桩**（真包由宿主在运行时提供），不会随 `npm pack` 分发。

## 许可

Apache-2.0，见 `LICENSE` 与 `NOTICE`。
