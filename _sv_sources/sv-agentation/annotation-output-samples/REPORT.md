# REPORT — annotation-output-samples(标注→上下文导出格式,官方样例)

## 用途一句话
sv-agentation 官方附带的四档导出样例(compact / standard / detailed / forensic),展示"UI 元素标注 → 给 AI 编码工具的结构化 Markdown 上下文"的完整输出形态。

## 结论(适用性判定)
**不是外壳 GUI 的 UI 组件**,不适用用户要找的三类素材;存档原因是其输出 schema(选择器路径、源码位置、组件链、边界框、反馈文本)与 Magic Pointer 的"交互编译→结构化上下文/RunEnvelope"设计相邻,可作格式参考。原文逐字节拷贝,未改写。

## 来源 URL
https://raw.githubusercontent.com/SikandarJODD/sv-agentation/master/packages/sv-agentation/demo-output/{compact,standard,detailed,forensic}.md
(仓库 https://github.com/SikandarJODD/sv-agentation,master 分支)

## 框架与依赖
纯 Markdown 文档,无框架、无依赖。

## 许可证
MIT — 随仓库分发(见 ../agentation-inspector/LICENSE 原文)。

## 文件清单
| 文件 | 说明 |
|---|---|
| compact.md | 最简档:每条标注一行级摘要 |
| standard.md | 标准档:选择器+源码位置+类名+组件链+坐标尺寸+反馈文本 |
| detailed.md | 详细档:在 standard 基础上追加更多元素上下文 |
| forensic.md | 取证档:再叠加计算样式快照等深度信息 |
