import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// 让 fetch 走 HTTP(S)_PROXY / NO_PROXY 环境变量（与 curl 行为一致）。
// 项目常部署在需要代理访问外网的环境（如 WSL + Clash）。
try {
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch {
  // 无代理或旧版 undici，忽略
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function apiKey(): string | undefined {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.LLM_API_KEY ||
    process.env.API_KEY
  );
}

function baseUrl(): string {
  return (
    process.env.OPENAI_BASE_URL ||
    process.env.BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
}

function model(): string {
  return process.env.OPENAI_MODEL || process.env.MODEL || "gpt-4o-mini";
}

export function isMock(): boolean {
  return process.env.MOCK_LLM === "1";
}

export function llmConfigError(): string | null {
  if (isMock()) return null;
  if (!apiKey()) {
    return "未配置 OPENAI_API_KEY：请在根目录 .env 中填写 API Key，或设置 MOCK_LLM=1 使用模拟模式。";
  }
  return null;
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

/** 带自动重试（503/429/网络波动）与连接超时的请求封装 */
async function postCompletion(body: object, outerSignal?: AbortSignal): Promise<Response> {
  const url = `${baseUrl()}/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey()}`,
  };
  const payload = JSON.stringify(body);
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (outerSignal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (attempt > 0) {
      await sleep(attempt * 1500, outerSignal);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("请求模型超时")), 45000);
    const onOuterAbort = () => ac.abort();
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const res = await fetch(url, { method: "POST", headers, body: payload, signal: ac.signal });
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
      if (res.ok) return res;
      const t = await res.text().catch(() => "");
      lastErr = new Error(`模型服务返回 ${res.status}: ${t.slice(0, 200)}`);
      if (!RETRY_STATUS.has(res.status)) throw lastErr;
    } catch (e) {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
      if (outerSignal?.aborted || (e as Error).name === "AbortError") throw e;
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("请求模型失败");
}

/** 非流式调用，返回完整文本 */
export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  const res = await postCompletion({ model: model(), messages, temperature: 0.3 });
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/** 流式调用，把 delta 文本逐块回调 */
export async function chatCompletionStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await postCompletion(
    { model: model(), messages, temperature: 0.3, stream: true },
    signal
  );
  if (!res.body) {
    throw new Error("模型服务返回空响应体");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const j = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const c = j.choices?.[0]?.delta?.content;
          if (c) onDelta(c);
        } catch {
          // 忽略不完整的 JSON 片段
        }
      }
    }
  }
}

/** mock 模式：逐块流式输出固定文本 */
export function mockStream(text: string, onDelta: (t: string) => void): Promise<void> {
  const chunks = text.match(/[\s\S]{1,24}/g) ?? [];
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      if (i >= chunks.length) return resolve();
      onDelta(chunks[i++]);
      setTimeout(tick, 40);
    };
    tick();
  });
}
