# dsh-input-optimize

给 DeepSeek-Harness Web 输入框加一个「一键优化提示词」的图标按钮。

点击后调用**当前选中的模型**，把输入框里的草稿改写成更清晰、更具体的提示词，然后写回输入框；
输入框里的附件（图片、文件）以清单形式置于送给模型的提示词最前面。

## 功能

- 图标按钮位于输入框右下角的工具行，在模型选择器左侧、发送按钮之前；图标用 DSH 聊天里的通用「工具调用」图标（primitives 的 `IconSparkleRegular`），primitives 不可用时用同款内联 SVG 兜底。
- 输入框为空（纯空白、只有附件）时按钮**隐藏**，不占控制行位置；输入内容后自动出现。
- 请求期间按钮进入 loading（图标变成旋转指示器），完成后恢复。
- **请求在途时如果草稿被发送出去，立即撤销这次请求**：abort 传输、静默回到空闲态，
  不报错、不写回；发送后清空的输入框不会被迟到的结果覆盖。
- 优化后的文本写回输入框，**保留 `@文件` 等引用 chip**（只替换纯文本部分）。
- 请求失败时，**错误原因显示在按钮的 tooltip 里**，按钮同时进入错误态。
- 优先使用当前选中的模型（含 reasoning effort）；取不到时回退到当前 Agent 的模型。

## 实现要点

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 浏览器半 | `client/client.js` | 单文件，无构建。占用 `conversation.input.right` 槽位（`order: -10`）。 |
| Host 半 | `lib/index.js` | 注册 RPC 通道 `/input-optimize`，端点 `optimize`。 |
| 提示词 | `lib/prompt.js` | 纯函数：构造 system/user 提示词、清洗模型输出。 |
| 测试 | `test/*.test.mjs` | `node --test`，零依赖。 |

浏览器通过 `ctx.connection.rpc.call('/api', 'input-optimize/optimize', payload)` 调用 Host（共享 `/api` 通道，
Host 侧注册为精确 Fetch 路由 `/api/input-optimize/optimize`，不依赖 `webServer`）；
Host 用 `ctx.llm.stream(...)` 调当前模型，聚合 `text-delta` 后返回 `{ optimized }`。

## 数据流

```
按钮点击
  → maskDraft(draft, occurrences)        引用 chip 换成 ⟦REF<n>⟧ 占位符
  → rpc.call('/api','input-optimize/optimize')  带上 maskedText + 附件名 + 当前模型
  → Host: buildUserPrompt(附件清单在最前) → ctx.llm.stream(...) → stripFences
  → unmaskDraft(optimized, slots)        校验占位符齐全且有序，还原 chip
  → 确认 draftRev 未变 → inputActions.setDraft({ text, references })
```

```
请求在途时按发送（默认发送会乐观清空草稿；命令提交进入 adjudicating/submitting）
  → revoke：标记 request.revoked + abort RPC 的 AbortSignal + 退订发送回显监听
  → 浏览器 fetch 断开 → Host 侧 request.signal abort → ctx.llm.stream 立即取消
  → 迟到的结果一律丢弃（revoked），不写回、也不出现在 tooltip 里
```

任何一步失败都不会写回输入框，错误原因进 tooltip；主动撤销（内容已发出）则静默回到空闲态。

## 安装

```sh
# 装进 desktop profile（需要先完全退出 DSH 桌面应用）
# CLI 拒绝 desktop profile（由 Electron 独占管理），改为直接写依赖 + pnpm：
#   1) 在 profile 的 package.json dependencies 里加
#      "dsh-input-optimize": "file:/Users/daye/dsh-plugins-input-optimize"
#   2) 在 profile 目录执行：<bundled-node> <bundled-pnpm> install
#   3) 在 profile 的 cordis.patch.yml 追加下面的 insert 行
```

然后在 profile 的 `cordis.patch.yml` 追加加载行（本仓库的 `dsh.bundle.patch`
会在作为 bundle 引用时自动生效；手动装进已有 profile 时需显式写这行）：

```yaml
- insert:
    - id: input-optimize
      name: dsh-input-optimize
```

改完重启应用（或让 `dsh-hmr` 热加载），并**刷新网页**——客户端 bundle 由
`/plugins` 按文件 mtime 发版，不刷新页面不会加载新的客户端代码。

## 开发

```sh
node --test test/*.test.mjs       # 跑测试（77 项）
node --check lib/index.js         # 语法检查
node --check client/client.js
```

无依赖、无构建步骤。desktop profile 用 `node-linker: hoisted` 安装 `file:` 依赖，
`node_modules/dsh-input-optimize` 里是**副本**而不是符号链接，所以改完源码还要同步
（或重跑 `pnpm install`）：

```sh
cp client/client.js ~/.dsh/profiles/desktop/node_modules/dsh-input-optimize/client/client.js
```

`dsh-client-hmr` 每 500ms 按 mtime 轮询这个文件，改完会自动热加载客户端 bundle；
Host 半（`lib/*`）改动仍需重启应用。

## 已知边界

- 输入框只有附件、没有文本时按钮隐藏（没有可优化的提示词）。
- 优化请求在途时若用户只是改字（草稿仍非空、没有发生提交），结果会被丢弃（比较 `draftRev`），请求本身仍会跑完；只有「内容被发出去」才撤销请求。
- 清空输入框（例如全选删除）同样按「内容已发出」处理并撤销请求——此时结果本来也无法写回。
- 发送期间又键入的后缀由会话发送回显（`pendingSubmissions`）兜底识别；取不到该服务时退化为「草稿被清空 / phase 进入提交」两个信号。
- 模型若丢失/重复/乱序 `⟦REF<n>⟧` 占位符，结果会被丢弃，输入框保持原样。
- 错误 tooltip 需要悬停才能看到；错误态同时用图标变色作为提示。

## License

MIT
