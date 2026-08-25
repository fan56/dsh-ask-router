# dsh-ask-router — ask-user 多端路由

> dsh 插件：把 `ctx.userQuestions` 的单 provider 槽位变成多路分发器。
> 一次提问同时弹给**所有**认领该会话的交互面（TUI 面板 / 飞书卡片 / …），
> **先答先得**，落选端自动收起。

## 为什么存在

dsh 的 userQuestions 每进程只允许一个 provider（`DUPLICATE_PROVIDER`），
同进程装两个 UI（如 dsh-tui-pi + dsh-feishu）只能二选一答题。本插件
占住唯一槽位并提供 `ctx.askSurfaces` 注册表：

```
agent 调 ask_user_question
  → dsh-ask-router（唯一 provider）
      → claim(request) 过滤：只问「当前驱动该会话」的 surface
        （无人认领时问全部——宁可多弹不可漏问）
      → fan-out → 第一个答案胜出
      → 其余 surface 收到 settled(request, 胜者名) 自动收起
      → abort（turn 中止）全部撤销
```

ask 请求带 `agent`（上游 `AskUserQuestionRequest`），surface 用
`agent.session.id` 判定会话归属。

## 安装（tui / headless profile）

bundles 里放在**所有 UI 之前**（必须先占槽）；dependencies 用 `link:` 指向本仓库：

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

⚠️ **绝不装进 web profile**：上游 web apiproxy 自注册 provider 且不容忍
重复注册，装了会挂掉 web UI。web 会话的问询永远弹浏览器，本插件与其无涉。

## Surface 协议（UI 插件实现）

```ts
ctx.get('askSurfaces').register({
  name: 'my-ui',
  claim: request => 我当前驱动的会话 === String(request.agent?.session?.id),
  ask: request => 渲染问题并返回答案 Promise,
  settled: (request, by) => 另一端先答，收起我的 UI,
})
```

- UI 检测不到本插件时应当自占 provider（独立可用，零回归）
- `claim` 抛错按不认领处理；`settled` 抛错被吞（胜者不受影响）
- 所有 surface 失败才 reject（取第一个错误）；无人认领时全体弹

## 测试

```bash
npm test   # 8 个纯逻辑单测（先答先得/认领路由/abort/失败聚合/注册表）
```

License: MIT. 作者 fan56. 设计背景见
`~/github/docs/dsh-feishu-interactive-cards-research.md`。
