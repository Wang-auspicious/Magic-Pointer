'use strict';

// 一次回答有两种形态，分界线只有一条：**这段产物要不要送出去。**
//
//   deliver（要送出去）  回微信、回邮件、把改好的话填回你原来那个输入框。
//     - 纯文本。收件人看到的是字，不是 `**粗体**` 和 `- 列表`——所以这一路
//       的系统提示词禁 markdown，渲染层也不解析 markdown。
//     - 可以反复追问打磨，也可以直接在框里自己改。
//     - 定稿之后不是「填入」一个按钮就写出去：那段话先回到你提问的那个框里，
//       在**那儿**出现「拒绝 / 同意」。写别人的窗口是一件要点头的事，点头的
//       位置必须是你的视线已经在的地方。
//
//   inspect（自己看）    生图、MCP 出来的地图和播放器、论文翻译、解释一段话。
//     - 支持 markdown、图片、工具自己渲染的那块界面。
//     - 没有「拒绝 / 同意」——它不往任何地方写，没有什么需要点头。
//
// 拿不准时一律判 inspect。判错成 inspect，用户少一个按钮；判错成 deliver，
// 我们会把一段带格式的字准备着往别人的聊天框里塞，还把 markdown 剥了。
// 两个方向的代价不对等，所以默认必须偏向不写。
//
// 纯函数：一个结果对象和一句命令进去，一个形态出来。没有 DOM，没有状态。

// 会写到用户自己文档/输入框里的动作。它们的存在本身就说明这次是要送出去的。
const WRITE_BACK_ACTIONS = Object.freeze([
  'office_replace_selection',
  'capsule_delivery',
  'draft_delivery',
  'text_replace',
]);

// 卡的形态本身就说明它是给人看的：一张图、一块工具界面、一张日程、一个对比表
// 没有「把它发给对方」这回事。注意不含 proposal——提案是「同意后执行动作」，
// 默认必须能确认，不能当成纯查看。
const INSPECT_KINDS = Object.freeze([
  'image', 'slot', 'table', 'calendar', 'metric', 'steps', 'prompt',
]);

// 「替我说一句话」类的动词。命中就是 deliver——这些词的宾语是别人要读到的东西。
const DELIVER_VERBS = Object.freeze([
  '回复', '回他', '回她', '回它', '回个', '答复', '回信', '回邮件', '回消息',
  '润色', '改写', '重写', '改得', '改成', '帮我写', '写一段', '写一句', '写个',
  '客气点', '委婉', '正式点', '口语化', '别太硬', '语气',
  '扩写', '压缩', '精简', '缩短',
]);

// 「讲给我听」类的动词。它们和上面撞车时优先——「解释一下这段怎么润色」问的是
// 解释，不是要一段能直接发出去的话。
const INSPECT_VERBS = Object.freeze([
  '解释', '什么意思', '啥意思', '是啥', '是什么', '为什么', '为啥', '怎么理解',
  '讲讲', '说说', '分析', '总结一下这', '看看', '画', '生成图', '出图', '地图',
  '这是', '这个是',
]);

function hasAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function proposalTypes(result) {
  const list = Array.isArray(result?.actionProposals) ? result.actionProposals : [];
  return list.map((proposal) => String(proposal?.action_type || proposal?.actionType || ''));
}

/**
 * 这次回答该长成哪一种。
 *
 * @param {object} input
 * @param {object} [input.result]   桥回来的结果（或舞台事件里的 result）
 * @param {string} [input.command]  用户说的那句话
 * @returns {{shape: 'deliver'|'inspect', reason: string, allowMarkdown: boolean, needsConsent: boolean}}
 */
function answerShape(input = {}) {
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  const command = String(input.command || '').trim();

  const kind = String(result.kind || '');
  if (INSPECT_KINDS.includes(kind)) return shape('inspect', `kind=${kind}`);
  // 提案是要点头才做的事：需要确认，按 deliver 处理（哪怕它不写进窗口，
  // needsConsent 让同意按钮出现）。
  if (kind === 'proposal') return shape('deliver', 'kind=proposal');

  // 桥说了算：它知道自己走的是哪条 recipe，比我们猜命令准。
  const explicit = String(result.answerShape || result.deliverKind || '');
  if (explicit === 'deliver' || explicit === 'inspect') return shape(explicit, 'bridge');

  const types = proposalTypes(result);
  if (types.some((type) => WRITE_BACK_ACTIONS.includes(type))) return shape('deliver', 'write-back proposal');

  if (String(result.intentKind || '') === 'length_target') return shape('deliver', 'length_target');

  if (hasAny(command, INSPECT_VERBS)) return shape('inspect', 'inspect verb');
  if (hasAny(command, DELIVER_VERBS)) return shape('deliver', 'deliver verb');

  return shape('inspect', 'default');
}

function shape(name, reason) {
  const deliver = name === 'deliver';
  return {
    shape: name,
    reason,
    // 要发出去的东西不许带格式：对面看到的是字面量的星号和减号。
    allowMarkdown: !deliver,
    // 往别人的窗口里写，永远要一次点头。自己看的东西没有什么需要点头。
    needsConsent: deliver,
  };
}

const AnswerShapePolicy = {
  DELIVER_VERBS,
  INSPECT_KINDS,
  INSPECT_VERBS,
  WRITE_BACK_ACTIONS,
  answerShape,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AnswerShapePolicy;
}
if (typeof globalThis !== 'undefined') {
  globalThis.AnswerShapePolicy = AnswerShapePolicy;
}
