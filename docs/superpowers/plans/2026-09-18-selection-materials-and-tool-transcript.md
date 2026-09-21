# 9·18 实际失败回合与 Claude 工具记录修复

用户已指定五张截图为视觉金标准并授权本机交付。此批保留接手时的未提交修改。

## 已取证

- `agent-78796693-886b-4ecb-b18c-e4b9edfeb70e`：三笔选区错误共享微信 source；桌面 PDF 未注册为文档。Look 不接受 InputArtifact 暴露的 reference ID，前三次均 invalid_anchor_format。
- 会话 JSON 仍有 12 次工具调用和 33 条轨迹；实时 renderer 单独渲染裸工具行且不保留逐轮正文/推理，完成 renderer 只显示最后一次 thinking。
- 完成星芒、账户星芒使用 clip-path 近似图；运行星芒 rotate。Claude 本机共享组件使用原 SVG sprite、逐帧动画。
- 安装版启动失败：profile 校验把 defaultMaxTokens 中的 token 子串误判为凭据；当前可见应用是开发版，历史与 Runtime 分别位于 Roaming 和开发目录。

## 实施与验收

1. 测试先行修复合法模型参数保存/安装启动，保留敏感字段拒绝。
2. 测试先行重建按时间交错的工作记录：运行时方框、完成后聚合折叠、重新展开查看所有调用/错误/正文/推理；原始 Spark 资源用于运行、完成和账户。
3. 测试先行修复每笔材料来源、已授权文件读取、reference 到冻结帧位置解析；空读取不得标成成功。
4. 以用户实际日志、冻结图和本地原件做只读回放；以真实 Chromium 点击验证折叠、切任务重开、动画和工具输出滚动，区分确定性模型 fixture 与真实模型结果。
5. fresh 全量 lint/typecheck/Node/Python；补丁版本递增、npm run sync、核对安装版启动与历史，更新 STATUS 和母文档账本。

每次检查针对已知断点；检查失败则修复对应消费链，不能以协议测试冒充真实文件汇总或像素一致。
