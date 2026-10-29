import { ChannelType, PermissionsBitField } from "discord.js";

// Marcadores no tópico para reencontrar as salas mesmo que mudem de nome.
const CHAT_MARKER = "[claude-chat]";
const LOGS_MARKER = "[claude-logs]";

const { ViewChannel, SendMessages, ReadMessageHistory, EmbedLinks, ManageChannels } = PermissionsBitField.Flags;

// Cache guildId -> { chatId, logsId }
const cache = new Map();

function overwrites(guild, readOnly) {
  return [
    { id: guild.roles.everyone.id, deny: [ViewChannel] },
    { id: guild.client.user.id, allow: [ViewChannel, SendMessages, ReadMessageHistory, EmbedLinks, ManageChannels] },
    {
      id: guild.ownerId,
      allow: readOnly ? [ViewChannel, ReadMessageHistory] : [ViewChannel, SendMessages, ReadMessageHistory],
      deny: readOnly ? [SendMessages] : [],
    },
  ];
}

// Garante que a categoria e as duas salas existem; cria o que faltar.
export async function ensureChannels(guild) {
  const channels = await guild.channels.fetch();
  let chat = channels.find((c) => c?.topic?.includes(CHAT_MARKER));
  let logs = channels.find((c) => c?.topic?.includes(LOGS_MARKER));
  const created = !chat; // sala de chat nova => primeira vez neste servidor (ou foi apagada)

  if (!chat || !logs) {
    const parent =
      chat?.parent ??
      logs?.parent ??
      (await guild.channels.create({
        name: "🤖 Claude",
        type: ChannelType.GuildCategory,
        permissionOverwrites: overwrites(guild, false),
      }));
    if (!logs) {
      logs = await guild.channels.create({
        name: "claude-logs",
        type: ChannelType.GuildText,
        parent,
        topic: `Registos e avisos do servidor. ${LOGS_MARKER}`,
        permissionOverwrites: overwrites(guild, true),
      });
    }
    if (!chat) {
      chat = await guild.channels.create({
        name: "claude-chat",
        type: ChannelType.GuildText,
        parent,
        topic: `Fala aqui com o Claude para gerir o servidor (não precisas de mencionar). Escreve "reset" para limpar a memória. ${CHAT_MARKER}`,
        permissionOverwrites: overwrites(guild, false),
        position: 0,
      });
      await chat.send(
        `Olá <@${guild.ownerId}>! 👋 Esta sala é só tua. Escreve aqui o que queres mudar no servidor e eu trato disso.\n` +
          `Avisos e registos de tudo o que acontece vão para <#${logs.id}>.`,
      );
    }
  }
  cache.set(guild.id, { chatId: chat.id, logsId: logs.id });
  return { chat, logs, created };
}

export function isChatChannel(channel) {
  return cache.get(channel.guildId)?.chatId === channel.id;
}

export function isLogsChannel(channel) {
  return cache.get(channel.guildId)?.logsId === channel.id;
}

export function isOurChannel(channel) {
  return isChatChannel(channel) || isLogsChannel(channel);
}

export function forget(guildId) {
  cache.delete(guildId);
}

export async function getLogsChannel(guild) {
  const id = cache.get(guild.id)?.logsId;
  const ch = id && (await guild.channels.fetch(id).catch(() => null));
  return ch || (await ensureChannels(guild)).logs;
}
