# dot 本人私聊版开发计划 v2

> 已被 [v3 dot 网页桥接方案](dot-development-plan-v3.zh-CN.md) 替代。本文仅保留历史，不再执行 companion 路线。

2026-10-20。依据最新要求：自己编写 dot 接入，不复用 dot-qq-bridge 或其 core 代码。本文件替代 v1 的复用方案；v1 仅为开发顺序的历史记录。

## 范围与基础

保留现有 aichat-bridge 扩展的网页和群聊功能。优先复用本仓库已有的 QQ 客户端、消息解析、状态队列等基础；在适用性审阅后，仅将浏览器无关部分用于新 companion。dot 本轮只支持主人本人 C2C 纯文字，不开放群聊/附件/其他收件人。

## 自编模块与服务边界

1. 独立可选 Node companion，DotProvider 仅表示 MCP Events 服务，不是虚构的 dot 模型 API，也不走 DOM。
2. 按官方 MCP Events 文档自行实现 server/discover、events/list/subscribe/unsubscribe、受限读取/回复工具和事件投递。签名使用 npm 的 Standard Webhooks 官方库，不自行发明签名协议。
3. 身份、订阅、owner 过滤、消息 ID→原会话映射、队列/去重/过期/重启恢复、发送结果不明不自动重发、阶段耗时由本版代码实现并离线测试。
4. Secure MCP Tunnel 的正式部署采用官方支持的客户端/边界；先核实官方文档及组件。若无法确认安全认证边界，明确阻止 live 启动并说明缺失条件，不能以任意自造 header 当成已验证 dot 身份，也不能用假实现宣称可以使用。
5. 扩展不持有 tunnel 密钥，不新增广域/localhost 权限。dot 使用专用 QQ App ID，和网页/群聊机器人分开；同机服务锁加操作者唯一消费者确认，不假称可检测其他主机连接。

## 顺序与验收

- 先提交本修订计划，接受审阅后再实现。
- 检查本仓库 QQ 代码可复用范围和官方协议；实现最小闭环服务与合成端点。
- 执行原扩展全套回归、新 companion 合约/安全/持久恢复测试；只使用合成身份、本机 mock，不访问真实账户、不创建凭据/隧道/订阅、不部署。
- MCP callback 验证签名 challenge、HTTPS allowlist、公网地址/TLS/禁止重定向；过期/撤销立即停止。事件 ACK≠dot 处理完成，消息可能被异步批处理，不保证更快。续订与被动回复窗口须单独验收。
- 交付源码、中文运行条件、测试结果、未验证清单。只有实际 QQ→原 dot→QQ 端到端验收后才可称真实接通；此轮不具备真实账户授权，不能据离线 mock 宣称完成 live 集成。

## 来源与许可

aichat-bridge 现有 MIT 版权保留。dot-qq-bridge 仅作思路和风险参考，本版不复制、不导入、不打包、不执行它或 @dot-bridge/core。新依赖只从知名 npm registry 的标准/官方包选取，固定版本、禁用安装脚本并保留许可。官方协议：<https://developers.openai.com/plugins/build/mcp-events>；官方 tunnel 指南：<https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>。
