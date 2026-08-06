# Magic Pointer 原生 Route 动作设计

日期：2026-07-12

## 用户体验

用户先后选中两个明确地点，使 Interaction Episode 中形成 THAT/THIS 或 THESE 两个对象，然后输入“规划路线”“这两个地方怎么走”或严格等价英文命令。Magic Pointer 不返回一段路线建议，也不在没有地理证据时编造距离和时间。selection bridge 只从当前 episode 的冻结对象中取出两个地点文本，按来源顺序形成 `RouteDraft`，打开 Dashboard 的路线卡。卡片清楚展示起点、终点、交通方式和来源，可一键交换，也可人工修正。用户点击“在 Google Maps 中查看路线”后，Electron 主进程从字段重新构造并校验官方 Maps URL，再通过系统默认浏览器打开。

首版不调用公共 Nominatim 自动补全，也不调用公共 OSRM 演示服务器计算时长。原因是 OSMF 公共 Nominatim 有严格流量、User-Agent、缓存、隐私和可切换 provider 要求，不能作为商业产品的默认通用地理编码后端；OSRM 公共路由实例也不构成产品 SLA。Dashboard 因此明确标注“路线详情将在 Google Maps 打开”，不显示伪造的本地耗时。后续 provider 可以接用户授权的 Google Routes API、自托管 Nominatim/OSRM 或其他商业服务，并在同一卡片内返回可验证的距离、时长和 geometry。

## 安全边界

RouteDraft 只接受当前 Interaction Episode 已绑定的两个对象，不从全局聊天历史猜地点。THESE 有两个对象时保持数组顺序；否则使用 THAT 作为起点、THIS 作为终点。每个地点折叠空白后必须为 1—240 字符，包含控制字符或超长文本则 fail closed。未知代词、只有一个对象、三个以上对象均打开可补字段的草稿或明确失败，不自动提交。

renderer 永远不传完整 URL。它只传 origin、destination 和 allowlist travel mode。主进程内纯函数使用 `URL`/`URLSearchParams` 构造 `https://www.google.com/maps/dir/?api=1`，travel mode 仅允许 driving、walking、bicycling、transit；总 URL 超过 2048 字符拒绝。打开前再次解析 URL，核验协议、hostname、pathname、api=1、起终点和参数白名单。IPC 只接受当前 Dashboard webContents，其他 renderer 即使拥有 preload 方法也不能触发外部导航。

## 验收

测试覆盖 THAT/THIS 顺序、THESE 顺序、缺对象、超长地点、严格中英文命令、URL 编码、参数注入、非法 host、非法 mode、交换起终点和 Dashboard 静态安全契约。端到端 fixture 从两个 episode 对象生成草稿，再由 Node URL builder 生成官方 Maps URL。真实验收由用户选择两个地点后触发路线卡，核对交换与交通方式，再点击打开；外部浏览器是否能访问 Google Maps 属于网络环境，不冒充本地成功的路线计算。
