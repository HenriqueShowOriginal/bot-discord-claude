import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// Várias IAs com reserva automática (fallback).
//
// O histórico da conversa é guardado num formato neutro (o formato "chat completions"
// que quase todos os serviços aceitam). Para o Claude, é convertido para o formato da Anthropic.
// Em cada chamada tentamos os serviços pela ordem de AI_PROVIDERS; se um falhar
// (limite atingido, erro, sem chave), passamos ao seguinte.
//
// Mensagens neutras:
//   { role: "user", content: "texto" }
//   { role: "assistant", content: "texto" | null, tool_calls?: [{ id, type: "function", function: { name, arguments } }] }
//   { role: "tool", tool_call_id, content: "resultado", is_error?: true }

// Serviços compatíveis com a API da OpenAI. Os modelos podem ser trocados no .env.
const OPENAI_COMPATIBLE = {
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", key: "GEMINI_API_KEY", model: "gemini-3.8-flash" },
  cerebras: { baseURL: "https://api.cerebras.ai/v1", key: "CEREBRAS_API_KEY", model: "gpt-oss-120b" },
  groq: { baseURL: "https://api.groq.com/openai/v1", key: "GROQ_API_KEY", model: "openai/gpt-oss-120b" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", key: "OPENROUTER_API_KEY", model: null },
  ollama: { baseURL: process.env.OLLAMA_URL || "http://localhost:11434/v1", key: null, model: "qwen3:4b" },
};

const env = (name) => process.env[name]?.trim() || undefined;

function buildProviders() {
  const order = (env("AI_PROVIDERS") || "claude").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const providers = [];
  for (const name of order) {
    if (name === "claude") {
      if (!env("ANTHROPIC_API_KEY")) {
        console.warn("⚠️  claude em AI_PROVIDERS mas falta ANTHROPIC_API_KEY — ignorado");
        continue;
      }
      providers.push({ name, model: env("CLAUDE_MODEL") || "claude-opus-5-5", client: new Anthropic({ maxRetries: 1 }) });
      continue;
    }
    const cfg = OPENAI_COMPATIBLE[name];
    if (!cfg) {
      console.warn(`⚠️  Serviço desconhecido em AI_PROVIDERS: ${name}`);
      continue;
    }
    const apiKey = cfg.key ? env(cfg.key) : "ollama";
    const model = env(`${name.toUpperCase()}_MODEL`) || cfg.model;
    if (!apiKey || !model) {
      console.warn(`⚠️  ${name} em AI_PROVIDERS mas falta ${!apiKey ? cfg.key : `${name.toUpperCase()}_MODEL`} — ignorado`);
      continue;
    }
    // maxRetries 0: se der limite, passamos logo ao serviço seguinte em vez de esperar.
    providers.push({ name, model, client: new OpenAI({ apiKey, baseURL: cfg.baseURL, maxRetries: 0, timeout: 90_000 }) });
  }
  if (!providers.length) throw new Error("Nenhuma IA configurada. Define AI_PROVIDERS e as chaves no .env.");
  return providers;
}

export const providers = buildProviders();
console.log(`IAs (por ordem): ${providers.map((p) => `${p.name} [${p.model}]`).join(" → ")}`);

// Serviço em pausa até esta hora (depois de um erro de limite).
const cooldownUntil = new Map();
// Serviços cuja pausa atual é por limite diário.
const dailyHit = new Set();

export class RefusalError extends Error {}

// ---------- Conversões ----------

const safeId = (id) => (id && /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : `call_${Math.random().toString(36).slice(2, 12)}`);

function parseArgs(str) {
  try {
    const v = JSON.parse(str || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return null; // JSON inválido: tratado como erro de input mais à frente
  }
}

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls || []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) ?? {} });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "…" }] });
    } else if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content, ...(m.is_error && { is_error: true }) };
      const last = out.at(-1);
      // Vários resultados seguidos vão juntos numa só mensagem do utilizador.
      if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

function toOpenAIMessages(system, messages) {
  return [
    { role: "system", content: system },
    ...messages.map((m) => (m.role === "tool" ? { role: "tool", tool_call_id: m.tool_call_id, content: m.content } : m)),
  ];
}

const toAnthropicTools = (tools) => tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
const toOpenAITools = (tools) =>
  tools.map(({ name, description, input_schema }) => ({ type: "function", function: { name, description, parameters: input_schema } }));

// ---------- Chamadas ----------

async function callClaude(p, { system, messages, tools, noTools, effort }) {
  const params = {
    model: p.model,
    max_tokens: 16000,
    output_config: { effort },
    system,
    tools: toAnthropicTools(tools),
    messages: toAnthropicMessages(messages),
  };
  if (noTools) params.tool_choice = { type: "none" };
  // Reserva do próprio servidor da Anthropic (não existe no Haiku).
  if (!p.model.includes("haiku")) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const res = await p.client.beta.messages.create(params);
  if (res.stop_reason === "refusal") throw new RefusalError("Pedido recusado pelo Claude.");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const tool_calls = res.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  return { text, message: { role: "assistant", content: text || null, ...(tool_calls.length && { tool_calls }) } };
}

async function callOpenAI(p, { system, messages, tools, noTools }) {
  const res = await p.client.chat.completions.create({
    model: p.model,
    messages: toOpenAIMessages(system, messages),
    tools: toOpenAITools(tools),
    tool_choice: noTools ? "none" : "auto",
  });
  const choice = res.choices?.[0];
  if (!choice) throw new Error("Resposta vazia");
  if (choice.finish_reason === "content_filter") throw new RefusalError(`Pedido bloqueado pelo filtro do ${p.name}.`);
  const msg = choice.message;
  const text = (msg.content || "").trim();
  const tool_calls = (noTools ? [] : msg.tool_calls || [])
    .filter((tc) => tc.type === "function")
    .map((tc) => ({ id: safeId(tc.id), type: "function", function: { name: tc.function.name, arguments: tc.function.arguments || "{}" } }));
  return { text, message: { role: "assistant", content: text || null, ...(tool_calls.length && { tool_calls }) } };
}

// ---------- Limites: por minuto vs. por dia ----------

const HOUR = 3_600_000;

// Milissegundos até à próxima meia-noite num fuso horário (ex.: "America/Los_Angeles", "UTC").
function msUntilMidnight(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date())
      .map((p) => [p.type, Number(p.value)]),
  );
  const elapsed = ((parts.hour % 24) * 3600 + parts.minute * 60 + parts.second) * 1000;
  return 24 * HOUR - elapsed + 60_000; // +1 min de margem
}

// Hora a que o limite diário renova em cada serviço (quando se sabe).
const DAILY_RESET = {
  gemini: () => msUntilMidnight("America/Los_Angeles"),
  openrouter: () => msUntilMidnight("UTC"),
};

// Converte durações do tipo "2m59.5s", "1h3m", "250ms" (cabeçalhos do Groq) em ms.
function parseDuration(str) {
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str) * 1000;
  let ms = 0;
  for (const [, n, unit] of str.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    ms += Number(n) * { ms: 1, s: 1000, m: 60_000, h: HOUR }[unit];
  }
  return ms || null;
}

function isDailyLimit(err) {
  const text = `${err?.message ?? ""} ${JSON.stringify(err?.error ?? "")}`;
  return /per[ _-]?day|perday|daily|\bRPD\b|\bTPD\b|free-models-per-day/i.test(text);
}

// Quanto tempo pôr um serviço em pausa depois de um erro 429.
function cooldownMs(name, err) {
  const header = (h) => err?.headers?.get?.(h);
  if (isDailyLimit(err)) {
    const reset = DAILY_RESET[name]?.() ?? parseDuration(header("x-ratelimit-reset-requests")) ?? parseDuration(header("x-ratelimit-reset-tokens"));
    return { ms: Math.max(reset ?? HOUR, 60_000), daily: true }; // hora desconhecida: tenta de hora a hora
  }
  const retryAfter = parseDuration(header("retry-after"));
  return { ms: retryAfter && retryAfter > 0 ? retryAfter : 60_000, daily: false };
}

// Estado de cada IA, para o comando "ias".
export function status() {
  const now = Date.now();
  return providers.map((p) => {
    const until = cooldownUntil.get(p.name);
    return { name: p.name, model: p.model, pausedUntil: until > now ? until : null, daily: dailyHit.has(p.name) && until > now };
  });
}

// Uma volta de conversa: tenta cada serviço por ordem até um responder.
// Devolve { text, message, toolCalls: [{ id, name, input }], provider }.
export async function chat({ system, messages, tools, noTools = false, effort = "medium" }) {
  const errors = [];
  const now = Date.now();
  // Os que estão em pausa vão para o fim da fila (ainda são tentados se todos falharem).
  const queue = [...providers].sort((a, b) => (cooldownUntil.get(a.name) > now) - (cooldownUntil.get(b.name) > now));

  for (const p of queue) {
    try {
      const out = p.name === "claude" ? await callClaude(p, { system, messages, tools, noTools, effort }) : await callOpenAI(p, { system, messages, tools, noTools });
      cooldownUntil.delete(p.name);
      dailyHit.delete(p.name);
      const toolCalls = (out.message.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) }));
      return { ...out, toolCalls, provider: `${p.name} (${p.model})` };
    } catch (err) {
      if (err instanceof RefusalError) errors.push(`${p.name}: recusou`);
      else {
        const status = err?.status;
        if (status === 429) {
          const { ms, daily } = cooldownMs(p.name, err);
          cooldownUntil.set(p.name, Date.now() + ms);
          daily ? dailyHit.add(p.name) : dailyHit.delete(p.name);
          if (daily) console.warn(`[IA] ${p.name}: limite DIÁRIO atingido, em pausa até ${new Date(Date.now() + ms).toLocaleString("pt-PT")}`);
        }
        errors.push(`${p.name}: ${status ? `HTTP ${status}` : err.message}`);
        console.warn(`[IA] ${p.name} falhou (${status ?? err.message}); a tentar o próximo…`);
      }
    }
  }
  const e = new Error(`Todas as IAs falharam — ${errors.join("; ")}`);
  e.allRefused = errors.every((x) => x.endsWith("recusou"));
  throw e;
}
