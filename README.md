# dsh-input-optimize

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

给 **DeepSeek Harness（DSH）** 的输入框加一个「一键优化提示词」按钮：点击后调用你**当前选中的模型**，把草稿改写成更清晰、更具体的提示词，再写回输入框。

- 保留 `@文件` / 图片附件引用 chip，只改纯文本部分
- 请求在途时直接发送 → 自动撤销优化请求，不打断对话
- 输入框为空（含只有附件）时按钮隐藏，不占位置
- 失败原因进按钮 tooltip，不会弹窗打断输入

## 使用

1. 在输入框里写草稿（可以带 `@文件`、图片附件）。
2. 点击工具行里的优化按钮（模型选择器左侧、发送按钮之前）。
3. 按钮进入 loading；完成后优化结果写回输入框，引用 chip 保持原样。
4. 如果优化期间你直接发送了这条草稿，优化请求会被立即撤销，不会覆盖已清空的输入框。

模型优先使用输入框当前选择（含 reasoning effort）；没有选择时回退到当前 Agent 的模型。

## 实现

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 浏览器半 | `client/client.js` | 单文件、无构建的客户端 bundle；占用 `conversation.input.right` 槽位（`order: -10`）。 |
| Host 半 | `lib/index.js` | 注册共享 `/api` Fetch 路由 `/api/input-optimize/optimize`，并保留 `/input-optimize` 前缀通道作为兼容回退。 |
| 提示词 | `lib/prompt.js` | 纯函数：构造 system/user 提示词、剥围栏、清洗模型输出。 |
| 测试 | `test/*.test.mjs` | `node --test`，零依赖、零构建。 |

请求链路：浏览器通过 `ctx.connection.rpc.call('/api', 'input-optimize/optimize', payload)` 调 Host；
Host 用 `ctx.llm.stream(...)` 调当前模型，聚合 `text-delta` 后返回 `{ optimized }`。

### 数据流

```
按钮点击
  → maskDraft(draft, occurrences)              引用 chip 换成 ⟦REF<n>⟧ 占位符
  → rpc.call('/api', 'input-optimize/optimize') 带上 maskedText、附件名、当前模型
  → Host：buildUserPrompt(附件清单置顶) → ctx.llm.stream(...) → stripFences
  → unmaskDraft(optimized, slots)              校验占位符齐全且有序，还原 chip
  → 确认 draftRev 未变 → inputActions.setDraft({ text, references })
```

```
请求在途时按发送（默认发送会乐观清空草稿；命令提交进入 adjudicating/submitting）
  → revoke：标记 request.revoked + abort RPC 的 AbortSignal + 退订发送回显监听
  → 浏览器 fetch 断开 → Host 侧 request.signal abort → ctx.llm.stream 立即取消
  → 迟到的结果一律丢弃，不写回、也不出现在 tooltip 里
```

任何一步失败都不会写回输入框，错误原因进 tooltip；主动撤销（内容已发出）则静默回到空闲态。

## 安装

> 需要 DSH 桌面端（desktop profile）。安装前请**完全退出 DSH 桌面应用**。

### 方式一：从 GitHub 安装（推荐）

1. 在 profile 的 `package.json` dependencies 里加一行（macOS 默认路径 `~/.dsh/profiles/desktop/package.json`）：

   ```json
   "dsh-input-optimize": "github:DaYePython/dsh-input-optimize"
   ```

2. 在 profile 目录安装依赖：

   ```sh
   cd ~/.dsh/profiles/desktop
   pnpm install
   ```

   没有本机 pnpm 时，可用桌面端内置运行时（路径随版本/安装位置变化）：

   ```sh
   NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
   PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
   "$NODE" "$PNPM" install
   ```

3. 在 profile 的 `cordis.patch.yml` 追加加载行：

   ```yaml
   - insert:
       - id: input-optimize
         name: dsh-input-optimize
   ```

4. 启动应用并**刷新页面**——客户端 bundle 由 `/plugins` 按文件 mtime 发版，不刷新不会加载新的客户端代码。

> 本仓库自带 `cordis.patch.yml`（`dsh.bundle.patch`）。如果把整个包作为 bundle 放进 profile 的 `dsh.profile.bundles`，插入行会自动生效，无需手写上面的 `insert`。

### 方式二：从本地源码安装

把依赖改成目录路径，其余步骤相同：

```json
"dsh-input-optimize": "file:/path/to/dsh-input-optimize"
```

## 开发

```sh
npm test        # 77 项单测（node --test，零依赖）
npm run check   # node --check 语法检查
```

无依赖、无构建步骤。desktop profile 使用 `nodeLinker: hoisted`，安装后的 `node_modules/dsh-input-optimize` 是**副本**而不是符号链接，因此改完源码还要同步一次（或重跑 `pnpm install`）：

```sh
cp client/client.js ~/.dsh/profiles/desktop/node_modules/dsh-input-optimize/client/client.js
```

`dsh-client-hmr` 每 500ms 按 mtime 轮询客户端 bundle，同步后会自动热加载；Host 半（`lib/*`）改动仍需重启应用。

## 兼容性与已知边界

- 需要 DSH 客户端提供 `conversation.input.right` 槽位、`useInput` / `inputActions` 标准 props 和会话发送回显（`pendingSubmissions`）；缺少发送回显时会退化为「草稿被清空 / phase 进入提交」两个信号。
- 在 DSH 0.2.1-rc.3 桌面端验证。
- 输入框只有附件、没有文本时按钮隐藏（没有可优化的提示词）。
- 优化请求在途时若只是**改字**（草稿仍非空、没有发生提交），结果会被丢弃（比较 `draftRev`），请求本身仍会跑完；只有「内容被发出去」才撤销请求。
- 清空输入框（例如全选删除）同样按「内容已发出」处理并撤销请求——此时结果本来也无法写回。
- 模型若丢失 / 重复 / 乱序 `⟦REF<n>⟧` 占位符，结果会被丢弃，输入框保持原样。
- 错误 tooltip 需要悬停才能看到；错误态同时用图标变色作为提示。

## 故障排查

| 现象 | 排查方向 |
| --- | --- |
| 输入框里看不到按钮 | 确认草稿非空；确认插件已加载（Host 日志里有 `input-optimize: host half ACTIVATED`）；刷新页面。 |
| 点击后提示「宿主未提供 RPC 通道」 | DSH 版本过旧或客户端没有暴露 `connection.rpc`，检查 DSH 版本。 |
| 改了代码页面没变化 | 客户端 bundle 是 profile 里的副本：先同步 `client/client.js`（或重跑 `pnpm install`），再刷新页面。 |
| 优化一直失败 | 检查当前选中模型是否可用、网络是否正常；具体原因在按钮 tooltip 里。 |

## License

[MIT](LICENSE) © 2026 DaYePython
