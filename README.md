# dsh-ask-router — ask-user 多端路由

> dsh 插件：把 ask-user 的应答入口变成多路分发器（`ctx.askSurfaces`）。
> 一次提问同时弹给**所有**认领该会话的交互面（TUI 面板 / 飞书卡片 / …），
> **先答先得**，落选端自动收起。

**Requires dsh >= 0.1.2-alpha.3** —— 本插件只面向 0.1.2-alpha 宿主线；rc 时代的 provider 槽位路径（含 DUPLICATE_PROVIDER 让位与加载顺序要求）已删除。

## 为什么要做

dsh 的 `ask_user_question`（AI 中途停下向用户提问）需要一个 UI 来渲染问题、收集答案。
rc 时代的 dsh（≤ v0.1.1）曾规定**每进程只允许一个应答入口**（provider）——同一个 profile
里装两个 UI（如 dsh-tui-pi + dsh-feishu），只有一个能收到提问，另一个永远沉默
（0.1.2-alpha 起官方改为 `'user-questions/request'` waterfall，多应答者共存，槽位已成历史）。

而真实场景恰恰是：人在工位想在 TUI 里答，人离开座位想在手机飞书卡片上答。
一个入口逼着二选一，意味着你一起身，AI 的提问就挂在那里等人。

本插件把那个唯一的入口变成**多路分发器**：UI 不再抢入口，而是注册成
「surface」，提问路由给该答的人——

- `claim(request)` 认领「我正在驱动这个会话」（按 `agent.session.id` 过滤）；
- 无人认领时问所有 surface——**宁可多弹，不可漏问**；
- 所有认领的 surface **同时弹出**，**先答先得**；
- 落选的 surface 收到 `settled(request, 胜者名)` 自动收起；
- turn 中止 → 全部撤销。

```
agent 调 ask_user_question
  → dsh-ask-router（waterfall 应答者）
      → claim(request) 过滤：只问「当前驱动该会话」的 surface
        （无人认领时问全部——宁可多弹不可漏问）
      → fan-out → 第一个答案胜出
      → 其余 surface 收到 settled(request, 胜者名) 自动收起
      → abort（turn 中止）全部撤销
```

## v0.1.2-alpha 之后呢？—— 仍然需要，而且定位更清晰了

alpha 时代的 dsh 移除了单入口：应答者可以共存于 `'user-questions/request'`
cordis waterfall 上（返回即应答、调 `next()` 即让位），**官方解决了「共存」**——
只装单个 UI 的用户不再需要本插件，「绝不装进 web profile」的旧禁令也随之作废。

但官方机制是**排队，不是抢答**：提问按注册顺序逐个传递，前面的应答者答了，
后面的连问题都看不到；它表达不了「电脑和手机同时弹、人在哪边就在哪边答、
另一边自动收起」。

所以 alpha 时代本插件从「必需品」变成「增强件」：作为一层**多端竞答协议**
叠在 waterfall 之上——

```
alpha 宿主 waterfall 队列
  └─ dsh-ask-router（占一个队列位，唯一的应答者）
       └─ 广播抢答：claim 过滤 → 全员同弹 → 先答先得 → settled 收摊
```

rc 宿主要多端必须装它；alpha 宿主想要多端同时竞答也装它。单 UI 用户可以不装。

ask 请求带 `agent`（上游 `AskUserQuestionRequest`），surface 用
`agent.session.id` 判定会话归属。

## 🎬 Demo

AI 发起 `ask_user_question` 时，问题同时弹到手机飞书，点选项即答
（视频来自 dsh-feishu，另含交互式 /resume；竞答的另一端是桌面 TUI 面板）：

https://github.com/user-attachments/assets/c0d7092f-deda-4443-b75a-2bc93bd30d86

## 安装

```bash
npm install -D @aiwayds/dsh-ask-router   # 或作为 dsh-tui-pi 的依赖自动带上
```

本地开发用 link（tui / headless profile）：

dependencies 用 `link:` 指向本仓库；bundles 里放在 `dsh-base` 之后即可
（alpha waterfall 上多应答者共存，无加载顺序要求）：

```jsonc
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@aiwayds/dsh-ask-router",      // ← dsh-base 之后、UI 之前
    "@aiwayds/dsh-tui-pi",
    "@aiwayds/dsh-feishu"
  ]}}
}
```

装进 web profile 也是安全的（waterfall 多应答者共存；rc 时代「绝不装进
web profile」的禁令随槽位一起成为历史）：没有 surface 的请求会自动让位给
web UI 应答。

## Surface 协议（UI 插件实现）

```ts
ctx.get('askSurfaces').register({
  name: 'my-ui',
  claim: request => 我当前驱动的会话 === String(request.agent?.session?.id),
  ask: request => 渲染问题并返回答案 Promise,
  settled: (request, by) => 另一端先答，收起我的 UI,
})
```

- UI 检测不到本插件时应当独立可用：自行注册 `'user-questions/request'` waterfall 应答者（零回归）
- `claim` 抛错按不认领处理；`settled` 抛错被吞（胜者不受影响）
- 所有 surface 失败才 reject（取第一个错误）；无人认领时全体弹

## 测试

```bash
npm test   # 10 个纯逻辑单测（先答先得/认领路由/abort/失败聚合/注册表
           #  + apply() waterfall 应答者注册与释放）
```

License: MIT. 作者 fan56. 设计背景见
`~/github/docs/dsh-feishu-interactive-cards-research.md`。
