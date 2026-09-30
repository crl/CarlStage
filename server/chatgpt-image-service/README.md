# 内置 ChatGPT 图片服务

浏览器生成逻辑与人工登录工具由本机 `ChatGPT-Image-Svc` 项目适配而来。CarlStage 使用 `service.py` 提供带内部令牌的本机接口，Node 后端负责启动、端口选择和退出清理。登录直接启动普通系统 Edge，由用户人工完成并关闭窗口；生图再通过 Playwright 复用同一登录目录，不添加隐藏自动化标识的启动参数。

运行数据目录由后端指定；源码目录不保存账号、配置或生成图片。原项目的虚拟环境和账号数据不参与合入。

Windows x64 开发环境运行 `npm run chatgpt:prepare`，准备 Python 3.13.7 和 `requirements.txt` 中固定版本的依赖。桌面准备脚本自动包含该运行环境。无需下载 Playwright 自带浏览器。

模拟测试：`.local-runs/chatgpt-python/python.exe server/chatgpt-image-service/test_service.py`。
