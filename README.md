# Reelbench 本地创作工作台

基于 React、TypeScript 和 Vite 的创作工作台复刻。项目、原文、历史版本及已确认的 skill 原生 JSON 保存在浏览器 IndexedDB 中；真实生成的图片和视频保存在本机文件。内容生成由本机 Codex 调用 [shuohao-skills](https://github.com/eternityspring/shuohao-skills) 的五个 skill，媒体生成通过本机 ComfyUI。Skill 仓库固定在提交 `ca1c30be78bde70fa84d3817453c71e0ef25b751`（2.0.0），位于 `vendor/shuohao-skills-pinned`。

需要 Node.js 18+，以及本机已登录的 Codex CLI（`codex login status`）。默认模型为 `gpt-5.5`，可通过 `REELBENCH_CODEX_MODEL` 环境变量调整。本机服务仅监听 `127.0.0.1:8787`，浏览器经 Vite 代理访问。

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`。`npm run dev` 同时启动 Vite 和 Codex 服务；如果已有 Vite 进程，请先停止旧进程再启动。运行 `npm run build` 可生成前端构建。也可单独运行 `npm run server`。

在项目的大纲、角色、美术、剧本或分镜页面点击“重新生成”以启动对应 skill。大纲先产出供确认的骨架，确认后才生成完整结果。所有结果均先预览，点击“确认写入”后进入项目和变更历史。生成与校验结果写在本机 `.local-runs/`（已加入忽略列表）；清除浏览器站点数据会删除浏览器保存的项目。更改原生 skill 版本时须明确更新固定提交和适配代码。

页面右上角的「设置」入口可配置 Codex 参数，以及本机 ComfyUI 的 Qwen-Image-2.1 生图和 MiniMax H3 生视频工作流。两个工作流分别导入 ComfyUI 的 **API 格式 JSON**，填写提示词、参考图或首帧、时长等节点 ID 与输入字段；普通画布 JSON 不能直接提交给 `/prompt`。建议从 [Qwen-Image-2.1 文生图模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_t2i.json)、[参考图编辑模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_image_edit.json)和 [MiniMax H3 图生视频模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_i2v.json)开始，在本机 ComfyUI 配好模型后导出 API 格式。使用参考图时，生图工作流必须包含可映射的图片输入节点。视频时长节点须接受秒数，单镜为 1–15 秒。

设置保存在 `.local-runs/settings.json`，不会推送到 GitHub。旧版平铺的 ComfyUI 设置会自动迁移为生图设置。连接测试只读取 `/system_stats`。角色、美术和分镜可以生图，分镜在保存首帧图片后可用 MiniMax H3 生视频；生成结果先预览，确认后写入项目。媒体文件在 `.local-runs/media/`，浏览器项目只保存引用；本机服务关闭或媒体文件被删除后，项目仍可编辑但媒体无法加载。当前版本不安装或下载 ComfyUI 模型。

小说导入会尝试识别 UTF-8、GB18030，以及带 BOM 的 UTF-16。若旧项目中的占位内容已经出现乱码，请进入该项目的「概览」，使用「重新导入小说原文」选择原始文件。重新导入会重建各页面草稿，并在「变更」中保存原版本。

「测试 Codex 模型」会运行一次简短的本机 Codex 对话以确认账号与模型可用，并消耗少量 Codex 额度。

创意项目在大纲阶段还会形成一份可查看的扩写素材；确认大纲后，这份素材随项目保存，供后续 skill 使用。

原仓库的大纲质量门要求大爆点早于最终集；单集项目无法满足这一项。单集生成结果会显示该校验提示，由你审阅后决定是否写入。

浏览器数据只保存在当前站点的本地存储中。清除站点数据会删除项目内容；不同浏览器或设备之间不会自动同步。
