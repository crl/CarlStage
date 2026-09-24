# Reelbench 本地创作工作台

基于 React、TypeScript 和 Vite 的创作工作台复刻。项目、原文、图片、历史版本及已确认的 skill 原生 JSON 保存在浏览器 IndexedDB 中。内容生成由本机 Codex 调用 [shuohao-skills](https://github.com/eternityspring/shuohao-skills) 的五个 skill；图片和出片仍为模拟。仓库固定在提交 `ca1c30be78bde70fa84d3817453c71e0ef25b751`（2.0.0），位于 `vendor/shuohao-skills-pinned`。

需要 Node.js 18+，以及本机已登录的 Codex CLI（`codex login status`）。默认模型为 `gpt-5.5`，可通过 `REELBENCH_CODEX_MODEL` 环境变量调整。本机服务仅监听 `127.0.0.1:8787`，浏览器经 Vite 代理访问。

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`。`npm run dev` 同时启动 Vite 和 Codex 服务；如果已有 Vite 进程，请先停止旧进程再启动。运行 `npm run build` 可生成前端构建。也可单独运行 `npm run server`。

在项目的大纲、角色、美术、剧本或分镜页面点击“重新生成”以启动对应 skill。大纲先产出供确认的骨架，确认后才生成完整结果。所有结果均先预览，点击“确认写入”后进入项目和变更历史。生成与校验结果写在本机 `.local-runs/`（已加入忽略列表）；清除浏览器站点数据会删除浏览器保存的项目。更改原生 skill 版本时须明确更新固定提交和适配代码。

页面右上角的「设置」入口可配置 Codex 模型、推理强度、任务超时，以及本机 ComfyUI 地址、API 格式工作流、节点映射和默认生成参数。设置保存在 `.local-runs/settings.json`，不会推送到 GitHub；保存后新任务立即使用新配置。ComfyUI「测试连接」读取其 `/system_stats`，不会提交出图任务。当前图片按钮仍使用模拟图，设置页会明确标示这一点。

小说导入会尝试识别 UTF-8、GB18030，以及带 BOM 的 UTF-16。若旧项目中的占位内容已经出现乱码，请进入该项目的「概览」，使用「重新导入小说原文」选择原始文件。重新导入会重建各页面草稿，并在「变更」中保存原版本。

「测试 Codex 模型」会运行一次简短的本机 Codex 对话以确认账号与模型可用，并消耗少量 Codex 额度。

创意项目在大纲阶段还会形成一份可查看的扩写素材；确认大纲后，这份素材随项目保存，供后续 skill 使用。

原仓库的大纲质量门要求大爆点早于最终集；单集项目无法满足这一项。单集生成结果会显示该校验提示，由你审阅后决定是否写入。

浏览器数据只保存在当前站点的本地存储中。清除站点数据会删除项目内容；不同浏览器或设备之间不会自动同步。
