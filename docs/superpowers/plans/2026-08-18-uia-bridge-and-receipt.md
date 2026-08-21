# UIA 树接入 + Receipt 停止条件（接桌面动作面）

> 上一刀 13 工具有契约、无生产树。本批把 UFO² 的「原生语义」接到真 UIA，并把蓝图 §8.3 的 Receipt 变成 loop 收尾的一等事件。不升版本、不 sync。

## 做

1. `app/desktop_actions/uia.py`：把原始 UIA 节点规范成 Kimi 元素（1-based index、role、name、rect、patterns）。容器无名字且无 pattern 的丢掉。预算 400 个节点。
2. `UiaBridge.list_elements` / `act`：walker/actor 可注入；生产 walker 走 COM，失败返回空树 / `{ok:false}`，不假装 click。
3. `default_session` 用这座桥，不再写死空树和 `uia_action_not_wired`。
4. `app/receipts/`：Receipt 值对象 + session `receipt/issued`。loop 在 COMPLETED（以及其它终态）必须发票，不能只靠模型说 done。
5. 写入类工具结果里 `verification.matched=true` 算验证证据（13 工具的 type_text/set_value 才能真正消掉验证门）。

## 不做

不升版本；不改 C# 常驻宿主协议（COM 失败就诚实空，不新开一轮编译税）；不 fork UFO；不把像素 CU 当第一选择。
