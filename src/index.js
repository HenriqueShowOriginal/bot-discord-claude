import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} from "discord.js";
import { apiTools, toolMap, validateInput } from "./tools.js";
import { COLORS, log, registerLogEvents } from "./logs.js";
import { ensureChannels, isChatChannel, isLogsChannel } from "./setup.js";
import { buildSnapshot, SCAN_PROMPT } from "./scan.js";
import { chat } from "./ai.js";

const MAX_HISTORY = 60; // mensagens por canal antes de recomeçar a conversa
const MAX_STEPS = 25; // máximo de rondas de ferramentas por pedido

// Quem pode dar ordens ao bot: IDs em ALLOWED_USERS, o dono do servidor, ou quem tem Administrador.
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});
registerLogEvents(discord);

// Histórico de conversa por canal, no formato neutro de ai.js (serve para qualquer IA).
const histories = new Map();

function systemPrompt(guild, author) {
  return `És um assistente de administração do servidor de Discord "${guild.name}" (id ${guild.id}).
Tens ferramentas para gerir canais, cargos, membros, mensagens e definições do servidor.
Quem está a falar contigo: ${author.tag} (id ${author.id}), que tem permissão para te dar ordens.

- Responde em português, de forma curta e direta (é um chat de Discord, máx. ~1500 caracteres).
- Antes de alterar algo, consulta o estado atual (listar canais/cargos/membros) para usar os IDs certos.
- Para pedidos grandes (ex.: "organiza o servidor"), faz as alterações e no fim resume o que mudaste.
- Ações destrutivas (apagar, expulsar, banir, limpar mensagens) pedem confirmação ao utilizador automaticamente; se ele recusar, não insistas.
- Se uma ferramenta der erro (ex.: falta de permissão), explica o motivo e sugere a solução.
- Menciona canais como <#id>, cargos como <@&id> e membros como <@id>.
- Existe uma sala privada #claude-chat (onde o dono fala contigo) e #claude-logs (registos automáticos). Não as apagues nem mexas nas permissões delas.
- Cada alteração que fazes fica registada automaticamente nos logs. Usa "enviar_aviso" para publicar lá resumos de mudanças grandes, alertas (ex.: algo suspeito que notaste) ou lembretes que o dono te pedir.`;
}

function isAllowed(member) {
  if (ALLOWED_USERS.includes(member.id)) return true;
  if (member.id === member.guild.ownerId) return true;
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

async function confirm(message, text) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sim").setLabel("Confirmar").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("nao").setLabel("Cancelar").setStyle(ButtonStyle.Secondary),
  );
  const prompt = await message.reply({ content: `⚠️ ${text}?`, components: [row] });
  try {
    const click = await prompt.awaitMessageComponent({
      filter: (i) => i.user.id === message.author.id,
      time: 60_000,
    });
    const ok = click.customId === "sim";
    await click.update({ content: `${ok ? "✅" : "❌"} ${text}`, components: [] });
    return ok;
  } catch {
    await prompt.edit({ content: `⌛ ${text} (sem resposta, cancelado)`, components: [] });
    return false;
  }
}

async function runTool(block, ctx) {
  const tool = toolMap.get(block.name);
  if (!tool) return { content: `Ferramenta desconhecida: ${block.name}`, is_error: true };
  const problem = validateInput(tool, block.input);
  if (problem) return { content: `Input inválido: ${problem}`, is_error: true };
  try {
    if (tool.destructive) {
      const text = await tool.describe(ctx, block.input);
      if (!(await confirm(ctx.message, text))) return { content: "O utilizador cancelou esta ação." };
    }
    const result = await tool.run(ctx, block.input);
    if (!tool.readOnly && block.name !== "enviar_aviso") {
      log(ctx.guild, {
        title: `🤖 Bot: ${block.name}`,
        description: `Pedido por <@${ctx.message.author.id}>\n\`\`\`json\n${JSON.stringify(block.input, null, 1).slice(0, 900)}\n\`\`\``,
        color: tool.destructive ? COLORS.perigo : COLORS.claude,
      });
    }
    return { content: typeof result === "string" ? result : JSON.stringify(result) };
  } catch (err) {
    if (!tool.readOnly) {
      log(ctx.guild, { title: `❌ Bot falhou: ${block.name}`, description: err.message, color: COLORS.perigo });
    }
    return { content: `Erro: ${err.message}`, is_error: true };
  }
}

// Divide texto longo em blocos de <2000 caracteres, cortando de preferência em quebras de linha.
function chunk(text) {
  const out = [];
  let rest = text || "(sem resposta)";
  while (rest.length > 1900) {
    let cut = rest.lastIndexOf("\n", 1900);
    if (cut < 1000) cut = 1900;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  out.push(rest);
  return out;
}

async function sendLong(message, text) {
  for (const [i, part] of chunk(text).entries()) {
    i === 0 ? await message.reply(part) : await message.channel.send(part);
  }
}

// Mostra discretamente que IA respondeu (útil quando há várias configuradas).
const signed = (out) => `${out.text || "(sem resposta)"}\n-# 🤖 ${out.provider}`;

// Faz o scan do servidor e publica a análise na #claude-chat.
// A análise fica no histórico da sala, para o dono poder responder às perguntas a seguir.
async function analyzeServer(guild, room) {
  const owner = await guild.fetchOwner();
  await room.send(`🔎 <@${owner.id}>, estou a analisar o servidor… dá-me um minuto.`);
  const typing = setInterval(() => room.sendTyping().catch(() => {}), 8000);
  try {
    const snapshot = await buildSnapshot(guild);
    const history = [
      { role: "user", content: `${SCAN_PROMPT}\n\n\`\`\`json\n${JSON.stringify(snapshot).slice(0, 80_000)}\n\`\`\`` },
    ];
    // noTools: nesta fase só analisa, não mexe em nada.
    const out = await chat({ system: systemPrompt(guild, owner.user), messages: history, tools: apiTools, noTools: true, effort: "high" });
    history.push(out.message);
    histories.set(room.id, history);
    for (const part of chunk(signed(out))) await room.send(part);
    await log(guild, { title: "🔎 Scan do servidor concluído", description: `Análise publicada em ${room} (via ${out.provider}).`, color: COLORS.claude });
  } catch (err) {
    console.error(`Scan falhou em ${guild.name}:`, err.message);
    await room.send("Não consegui fazer o scan agora. Escreve `scan` para tentar outra vez.");
  } finally {
    clearInterval(typing);
  }
}

async function handle(message, prompt) {
  const guild = message.guild;
  let history = histories.get(message.channelId) || [];
  if (history.length > MAX_HISTORY) history = [];
  history.push({ role: "user", content: `${message.author.username}: ${prompt}` });
  histories.set(message.channelId, history);

  const ctx = { guild, message };
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  message.channel.sendTyping().catch(() => {});

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Cada passo pode ser respondido por uma IA diferente se a anterior atingir o limite.
      const out = await chat({ system: systemPrompt(guild, message.author), messages: history, tools: apiTools });
      history.push(out.message);
      if (!out.toolCalls.length) return sendLong(message, signed(out));

      // Destrutivas uma de cada vez (confirmação); as restantes podem correr em paralelo.
      const results = [];
      for (const call of out.toolCalls) {
        const tool = toolMap.get(call.name);
        results.push(tool?.destructive ? await runTool(call, ctx) : runTool(call, ctx));
      }
      const settled = await Promise.all(results);
      out.toolCalls.forEach((call, i) => history.push({ role: "tool", tool_call_id: call.id, ...settled[i] }));
    }
    history.push({ role: "user", content: "(limite de passos atingido)" });
    return message.reply("Parei: o pedido precisava de demasiados passos. Diz-me como continuar.");
  } catch (err) {
    histories.delete(message.channelId); // recomeça a conversa para não ficar bloqueada
    console.error(err.message);
    if (err.allRefused) return message.reply("Não posso ajudar com esse pedido.");
    return message.reply("Nenhuma IA conseguiu responder agora (limites atingidos ou erro). Tenta daqui a pouco.");
  } finally {
    clearInterval(typing);
  }
}

discord.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild || isLogsChannel(message.channel)) return;
  // Na #claude-chat basta escrever; nos outros canais é preciso mencionar o bot.
  if (!isChatChannel(message.channel) && !message.mentions.users.has(discord.user.id)) return;

  const prompt = message.content.replace(new RegExp(`<@!?${discord.user.id}>`, "g"), "").trim();
  if (!isAllowed(message.member)) return message.reply("Só administradores me podem dar ordens.");
  if (prompt.toLowerCase() === "setup") {
    const { chat, logs } = await ensureChannels(message.guild);
    return message.reply(`Salas prontas: ${chat} e ${logs}.`);
  }
  if (["scan", "analisar"].includes(prompt.toLowerCase())) {
    const { chat } = await ensureChannels(message.guild);
    histories.delete(chat.id);
    return analyzeServer(message.guild, chat);
  }
  if (!prompt) return message.reply("Diz-me o que queres fazer no servidor. (`scan` analisa o servidor, `reset` apaga a memória)");
  if (prompt.toLowerCase() === "reset") {
    histories.delete(message.channelId);
    return message.reply("Memória da conversa apagada.");
  }
  await handle(message, prompt);
});

async function setupGuild(guild) {
  try {
    const { chat, created } = await ensureChannels(guild);
    // Primeira vez neste servidor: faz o scan e apresenta-se ao dono.
    if (created) await analyzeServer(guild, chat);
  } catch (err) {
    console.error(`Não consegui criar as salas em ${guild.name}: ${err.message}`);
  }
}

discord.once("clientReady", async (c) => {
  console.log(`Bot ligado como ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) {
    await setupGuild(guild);
    await log(guild, { title: "🟢 Claude ligado", description: "Estou online e a vigiar o servidor.", color: COLORS.ok });
  }
});

// Quando o bot é adicionado a um servidor novo, cria logo as salas.
discord.on("guildCreate", setupGuild);
discord.login(process.env.DISCORD_TOKEN);
