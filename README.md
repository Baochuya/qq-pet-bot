---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: bf1186c8b1314ece3581301f7a61d84d_fa6a6ebd9f5911f1a54f525400f8a581
    ReservedCode1: 4EF6bdwRWIWJssuyDUr1CMwbcmulOqY+ECFVWouyE+ayTIa0/z90jl6Il351LP6clFaOBQ22Pf1BZh/gBZNgPDsVWW8oOemkmPP23Y/yu6w1oSLn3cYxlqVPQEd27zrsi0t/QEI2ngeaYvRNprLTxzcFvGUem52uZ9K55ifiFD2mGhV6d81m3Y8MO/4=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: bf1186c8b1314ece3581301f7a61d84d_fa6a6ebd9f5911f1a54f525400f8a581
    ReservedCode2: 4EF6bdwRWIWJssuyDUr1CMwbcmulOqY+ECFVWouyE+ayTIa0/z90jl6Il351LP6clFaOBQ22Pf1BZh/gBZNgPDsVWW8oOemkmPP23Y/yu6w1oSLn3cYxlqVPQEd27zrsi0t/QEI2ngeaYvRNprLTxzcFvGUem52uZ9K55ifiFD2mGhV6d81m3Y8MO/4=
---

# QQ 宠物助手 · 萌卡 NT 插件

基于官方 **Mengka-NT**（萌卡NT）Node.js SDK 开发，参考
[qq-pet-interface-copilot](https://github.com/yikehuang/qq-pet-interface-copilot)
功能界面设计的 QQ 宠物托管插件。支持群聊/私聊前缀命令控制、自动托管调度与
插件自带 WebUI 管理后台（框架内嵌页）。

## 功能

- 宠物状态查询（金币 / 心情 / 体力 / 清洁 / 综合值 / 等级 / 当前任务）
- 喂食（饼干 / 虾仁）、洗澡（香皂片 / 沐浴球）、库存补货
- 学习（读取目录按最短时长选课）、打工（职业岗位）、冒险（实时天气/事件项目）
- PK：发起 / 结算 / 今日批次每日上限
- 好友照顾：列表 / 照顾 / feed / bathe（按缺口批量使用道具）
- 自动托管：定时巡检、体力/清洁阈值补货与照顾、金牌合每日 PK
- WebUI 管理面板：概览 / 操作 / 配置 / 日志

## 安装

1. 将本项目目录放入萌卡NT 插件目录，或通过框架管理端导入。
2. 安装依赖：`npm install`（仅依赖 `ws`）。
3. 直接在框架内启动插件；框架会注入 `connection_file` 与 WebUI 后台参数。

## 能力声明（发布页勾选）

安装包**不再包含** `mengka-plugin.json`。API 与事件权限以开发者在萌卡NT官网
发布页面勾选、审核并随安装冻结的权限快照为准，SDK 中存在某个方法不代表
插件已获得该权限。

WebUI 托管由框架在启动时通过以下环境变量注入（插件进程直接读取，无需任何
描述文件）：

- `MENGKA_PLUGIN_ADMIN_HOST` / `MENGKA_PLUGIN_ADMIN_PORT` → 后台监听地址
- `MENGKA_PLUGIN_ADMIN_BASE_PATH` → 反向代理挂载前缀
- `MENGKA_PLUGIN_ADMIN_TOKEN_FILE` / `MENGKA_PLUGIN_ADMIN_EMBEDDED=1` → 管理令牌与内嵌模式

插件 WebUI 鉴权使用 `X-Mengka-Admin-Token` 请求头（`auth_type=header`）。

## 命令

触发词支持两种方式：带前缀 `!宠物 ...`，或免前缀关键词（`宠物` / `pet`，可配置）。

| 命令 | 说明 |
| --- | --- |
| `宠物 状态` | 查看自己宠物状态 |
| `宠物 喂食 [xN]` | 喂食，默认 1 次，可指定次数 |
| `宠物 洗澡` | 洗澡 1 次 |
| `宠物 补货` | 按配置缺口补货（饼干/香皂片） |
| `宠物 学习` / `宠物 学习 开始 <名称>` | 学习目录 / 开课 |
| `宠物 打工` / `宠物 打工 开始 <职业> <岗位>` | 打工目录 / 开工 |
| `宠物 冒险` / `宠物 冒险 开始 <项目>` | 冒险目录 / 开始 |
| `宠物 结算 <storyId>` | 结算完成的任务 |
| `宠物 pk 开始 <QQ>` / `pk 结算 <storyId>` / `pk 今日` / `pk 每天` | PK 操作 |
| `宠物 好友 列表` / `好友 照顾 <QQ>` / `好友 feed <QQ>` / `好友 bathe <QQ>` | 好友宠物 |
| `宠物 好友 状态 <QQ>` | 好友宠物状态 |
| `宠物 托管 开` / `宠物 托管 关` | 开启/关闭自动托管 |
| `宠物 帮助` | 帮助菜单 |

## 配置

`config.json`（首次运行生成，参照 `config.schema.json`）：

- `command_prefix`：命令前缀，默认 `!`
- `command_keywords`：免前缀触发词，默认 `["宠物","pet","qpet","qq宠物"]`
- `pet`：自身宠物相关（self_id 等，由事件自动填充）
- `skill`：学习/打工/冒险路径与阈值选项
- `shop`：购买上限与道具选择
- `scheduler`：托管开关、巡检间隔、体力/清洁阈值、每日 PK 时间
- `web`：独立 WebUI 监听（host / port / base_path / token），托管模式由框架注入

## WebUI

框架内打开管理后台即可（登录态与令牌由框架注入）；也可独立访问
`http://127.0.0.1:<port>`（需配置 token）。

后端 API：`/api/status` `/api/config` `/api/manage` `/api/action` `/api/log` `/api/daily`
鉴权：`X-Mengka-Admin-Token` 请求头。

## 运行模式

- **forward（插件连框架）**：`node index.js --connection <connection_file> --token <token>`
- 也支持从命令行直接指定 `--ws-url` / `--mode reverse` 等参数（见 index.js 帮助）。

## 开发 / 自测

仓库 `temp/e2e` 提供 mock 萌卡NT 后台与全链路联调脚本：

```
node test-plugin.mjs
```

mock 服务端监听 `ws://127.0.0.1:3899/`，逐条推送群消息并校验回执，
覆盖状态/喂食/洗澡/补货/学习/PK/好友/托管/帮助等全部命令。

## 说明

自动化依赖未公开的 QQ 宠物接口，可能受服务端规则及账号风控影响，请仅用于
自己的 QQ 账号。SDK 与官方一致，另增 `post_type`/`type` 双口径事件兼容层。
*（内容由AI生成，仅供参考）*
