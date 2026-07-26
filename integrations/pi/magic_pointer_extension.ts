import { spawn } from "node:child_process";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type BridgeResult = { ok: boolean; [key: string]: unknown };

function callBridge(root: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    const script = path.join(root, "scripts", "fabric_bridge.py");
    const child = spawn(process.env.MAGIC_POINTER_PYTHON || "python", [script], {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const result = JSON.parse(lines.at(-1) || "{}") as BridgeResult;
        if (code !== 0 && result.ok !== false) reject(new Error(stderr || `bridge exit ${code}`));
        else resolve(result);
      } catch (error) {
        reject(new Error(`Invalid Magic Pointer bridge output: ${String(error)} ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function currentContext(value: BridgeResult): string {
  return [
    "[magic-pointer-attached]",
    "THIS/THAT/THESE/HERE are the frozen Magic Pointer objects in this episode.",
    "Use their exact local source path, geometry and content. Do not recapture the desktop.",
    JSON.stringify(value, null, 2),
  ].join("\n");
}

function referencesPointer(prompt: string): boolean {
  return /@(?:pointer|this)\b|\b(?:this|that|these|here|screen|selection)\b|这个|这段|这张|这块|这里|刚才那个|屏幕|选区|指针/i.test(prompt);
}

export default function magicPointerExtension(pi: ExtensionAPI) {
  const root = process.env.MAGIC_POINTER_ROOT || process.cwd();

  pi.registerTool({
    name: "magic_pointer_current",
    label: "Magic Pointer Current Object",
    description: "Return the already-frozen THIS/THAT/THESE/HERE episode without taking another screenshot.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const value = await callBridge(root, { operation: "current_object" }, signal);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });

  pi.registerTool({
    name: "magic_pointer_recipes",
    label: "Magic Pointer Recipes",
    description: "List Magic Pointer's grounded cross-application action recipes and capability contracts.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const value = await callBridge(root, { operation: "catalog" }, signal);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });

  pi.registerTool({
    name: "magic_pointer_plan",
    label: "Plan Magic Pointer Action",
    description: "Plan, but do not execute, an action against frozen Magic Pointer objects.",
    parameters: Type.Object({
      command: Type.String(),
      objects: Type.Array(Type.Object({}, { additionalProperties: true })),
    }),
    async execute(_id, params, signal) {
      const value = await callBridge(root, {
        operation: "plan",
        command: params.command,
        objects: params.objects,
      }, signal);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });

  pi.registerTool({
    name: "magic_pointer_execute",
    label: "Execute Magic Pointer Action",
    description: "Execute a signed Magic Pointer plan. Mutating plans require an explicit confirmed=true from the user.",
    parameters: Type.Object({
      command: Type.String(),
      objects: Type.Array(Type.Object({}, { additionalProperties: true })),
      confirmed: Type.Boolean(),
    }),
    async execute(_id, params, signal) {
      const value = await callBridge(root, {
        operation: "execute",
        command: params.command,
        objects: params.objects,
        confirmed: params.confirmed,
      }, signal);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });

  pi.registerCommand("pointer", {
    description: "Send the frozen Magic Pointer object to Pi with an optional instruction.",
    handler: async (args, ctx) => {
      const value = await callBridge(root, { operation: "current_object" });
      if (value.ok !== true) {
        ctx.ui.notify("Magic Pointer 没有可用的冻结对象，请先在目标上晃动鼠标。", "warning");
        return;
      }
      const instruction = args.trim() || "Inspect this grounded object and propose the most useful next action.";
      pi.sendUserMessage(`${instruction}\n\n${currentContext(value)}`);
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (event.prompt.includes("[magic-pointer-attached]") || !referencesPointer(event.prompt)) return;
    const value = await callBridge(root, { operation: "current_object" });
    if (value.ok !== true) return;
    return {
      message: {
        customType: "magic-pointer-context",
        content: currentContext(value),
        display: true,
      },
    };
  });
}
