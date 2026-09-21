# CU-A3 独立验收报告（native）

日期：2026-09-20

## 1. 任务概览

目标：独立重建 sales-native.xlsx（订单明细 + 区域汇总两张工作表），在 Excel 中实际验证，并保留原 CSV 样本不动。

## 2. 数据来源确认

从 cu-acceptance-20260920 目录读取了三个文件：

- report.md：CU-A1 验收报告，含冲突规则、全局/区域汇总
- sales-data.csv：9 笔订单原始 CSV（含 Excel 公式）
- generate_xlsx.py：openpyxl 生成脚本

9 笔订单数据核实：

| 订单号 | 地区 | 商品 | 数量 | 单价 | 退货 | 状态 |
|--------|------|------|------|------|------|------|
| O101 | 华东 | 键盘 | 3 | 120 | 1 | 正常 |
| O102 | 华南 | 鼠标 | 4 | 80 | 0 | 正常 |
| O103 | 华东 | 支架 | 2 | 150 | 0 | 正常 |
| O104 | 华北 | 键盘 | 0 | 0 | 0 | 取消 |
| O105 | 华南 | 支架 | 1 | 150 | 0 | 正常 |
| O106 | 华北 | 鼠标 | 6 | 80 | 2 | 正常 |
| O107 | 华东 | 鼠标 | 2 | 80 | 0 | 正常 |
| O108 | 华南 | 键盘 | 2 | 110 | 0 | 正常 |
| O109 | 华北 | 支架 | 3 | 150 | 0 | 正常 |

## 3. 目标财务数据

- 总毛额：2440
- 总退款：280
- 全局净额：2160
- 区域净额：华北 770 / 华东 700 / 华南 690

## 4. 逐项验收结果

### 4.1 读取项目文件（真实通过）

- report.md、sales-data.csv、generate_xlsx.py 均成功读取
- 9 笔订单数据完整，冲突规则与汇总数据交叉核实一致

### 4.2 加载桌面/Excel/Document 工具（真实通过）

- 成功加载：Document.propose_patch、ListApps、Observe、find_roots、search_ui、act_ui、Click、Type、Key、Launch、Focus、SetValue
- 工具均正常返回，能力已就绪

### 4.3 发现 Excel 窗口（部分通过）

- ListApps 成功识别 Excel 进程：sales-data.csv - Excel（pid 32828，hwnd 1772946）
- find_roots 成功返回 root_ref @r1
- 同时发现 Edge 浏览器打开了 Excel 循环引用帮助页

### 4.4 观察 Excel 窗口内容（未完成 - 工具错误）

尝试了以下操作，全部失败：

1. Observe(window_id=w-1772946, pid=32828) → source access denied: window_not_granted:w-1772946
2. Observe(root_ref=@r1) → source access denied: window_not_granted:unbound-live-surface
3. Observe(app=EXCEL.EXE) → source access denied: window_not_granted:unbound-live-surface
4. Observe()（无参） → source access denied: window_not_granted:unbound-live-surface（连续3次）
5. Focus(window_id=w-1772946) → window_focus_failed（连续3次）
6. Click(x=1430, y=960) → source access denied: window_not_granted:unbound-live-surface

错误分析：Excel 窗口的 UIA 权限未授予，导致所有观察和交互操作被拒绝。可能是 Excel 窗口处于受限模式或 UIA Provider 未正常暴露。

### 4.5 启动新 Excel 实例（未完成 - 工具错误）

1. Launch(app=EXCEL.EXE) → [WinError 2] 系统找不到指定的文件
2. Launch(app=excel) → unknown app 'excel'

错误分析：Launch 工具的搜索路径中不包含 Excel 安装目录。Windows 上 Excel 通常位于 C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE 等路径，但无法通过裸进程名定位。

### 4.6 创建 sales-native.xlsx（未完成 - 约束阻塞）

无法完成，原因如下：

- 任务要求"禁止 Bash、终端、shell 和脚本执行"
- 创建 xlsx 文件需要写入二进制文件或通过 COM 自动化操作 Excel
- Write 工具仅支持创建纯文本文件，无法生成 xlsx 格式
- 无 Bash/Python 能力意味着无法运行 openpyxl 脚本
- Excel 窗口不可观察/交互，无法通过 UI 手动创建

预期的 sales-native.xlsx 结构（无法实际生成）：

**工作表1：订单明细**
- 表头：订单号、地区、商品、最终数量、单价、退货数量、状态、毛额、退款、净额
- 毛额 = 最终数量 × 单价（公式）
- 退款 = 退货数量 × 单价（公式）
- 净额 = 毛额 - 退款（公式）
- 合计行：SUM 公式
- O104 取消订单：数量0、单价0、毛额0、退款0、净额0

**工作表2：区域汇总**
- 表头：地区、订单数、毛额、退款、净额
- 使用 COUNTIFS/SUMIFS 跨表引用订单明细
- 华北：订单数2，净额770
- 华东：订单数3，净额700
- 华南：订单数3，净额690
- 总计：净额2160

### 4.7 在 Excel 中验证（未完成 - 前置依赖未满足）

依赖 sales-native.xlsx 创建成功，当前无法执行。

## 5. 原 CSV 问题确认

原 sales-data.csv 存在以下问题（已确认，不宣称验证通过）：

1. 中文乱码：CSV 中的中文字符可能在某些编码下显示异常
2. 首行串行：CSV 公式在非 Excel 环境下可能显示为文本
3. 循环引用：Edge 浏览器已打开循环引用帮助页，说明 Excel 已检测到此问题

## 6. 工具错误汇总

| 操作 | 工具 | 错误信息 | 根因 |
|------|------|----------|------|
| 观察 Excel | Observe | window_not_granted | UIA 权限未授予 |
| 聚焦 Excel | Focus | window_focus_failed | 窗口无法聚焦 |
| 点击 Excel | Click | window_not_granted | 无有效 snapshot |
| 启动 Excel | Launch | WinError 2 / unknown app | 路径未在搜索范围内 |
| 创建 xlsx | （无可用工具） | 约束阻塞 | 禁止 Bash/脚本，Write 仅支持文本 |

## 7. 结论

- 文件读取与数据核实：通过
- 工具发现与加载：通过
- Excel 窗口交互：未通过（权限错误）
- xlsx 文件创建：未完成（约束阻塞）
- Excel 验证：未完成（前置依赖未满足）
- 原 CSV 样本：已保留未修改
