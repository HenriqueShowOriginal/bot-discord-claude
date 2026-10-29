import { AuditLogEvent, ChannelType, Events } from "discord.js";
import { forget, getLogsChannel, isOurChannel, ensureChannels } from "./setup.js";

export const COLORS = {
  info: 0x5865f2,
  ok: 0x57f287,
  aviso: 0xfee75c,
  perigo: 0xed4245,
  claude: 0xd97757,
};

// Envia um embed para a sala de logs do servidor.
export async function log(guild, { title, description, color = COLORS.info, fields }) {
  try {
    const ch = await getLogsChannel(guild);
    await ch.send({
      embeds: [{ title, description: description?.slice(0, 4000), color, fields, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error(`Falha ao registar log em ${guild.name}:`, err.message);
  }
}

// Tenta descobrir quem fez a ação pelo registo de auditoria (precisa de "Ver registo de auditoria").
async function executor(guild, type, targetId) {
  try {
    const entries = await guild.fetchAuditLogs({ type, limit: 5 });
    const e = entries.entries.find((x) => x.targetId === targetId && Date.now() - x.createdTimestamp < 10_000);
    return e?.executor ? ` por <@${e.executor.id}>` : "";
  } catch {
    return "";
  }
}

const cut = (s, n = 1000) => (s && s.length > n ? s.slice(0, n) + "…" : s || "*(vazio)*");

export function registerLogEvents(client) {
  client.on(Events.GuildMemberAdd, (m) =>
    log(m.guild, {
      title: "📥 Membro entrou",
      description: `<@${m.id}> (${m.user.tag})\nConta criada <t:${Math.floor(m.user.createdTimestamp / 1000)}:R>`,
      color: COLORS.ok,
    }),
  );

  client.on(Events.GuildMemberRemove, async (m) => {
    const kickedBy = await executor(m.guild, AuditLogEvent.MemberKick, m.id);
    log(m.guild, {
      title: kickedBy ? "👢 Membro expulso" : "📤 Membro saiu",
      description: `<@${m.id}> (${m.user.tag})${kickedBy}`,
      color: COLORS.aviso,
    });
  });

  client.on(Events.GuildBanAdd, async (ban) =>
    log(ban.guild, {
      title: "🔨 Utilizador banido",
      description: `<@${ban.user.id}> (${ban.user.tag})${await executor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id)}`,
      color: COLORS.perigo,
    }),
  );

  client.on(Events.GuildBanRemove, (ban) =>
    log(ban.guild, { title: "♻️ Ban removido", description: `<@${ban.user.id}> (${ban.user.tag})`, color: COLORS.ok }),
  );

  client.on(Events.GuildMemberUpdate, (before, after) => {
    const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
    const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
    const changes = [];
    if (added.size) changes.push(`➕ ${added.map((r) => `<@&${r.id}>`).join(" ")}`);
    if (removed.size) changes.push(`➖ ${removed.map((r) => `<@&${r.id}>`).join(" ")}`);
    if (before.nickname !== after.nickname) changes.push(`Apelido: \`${before.nickname ?? "—"}\` → \`${after.nickname ?? "—"}\``);
    if (!before.isCommunicationDisabled() && after.isCommunicationDisabled())
      changes.push(`⏳ Castigo até <t:${Math.floor(after.communicationDisabledUntilTimestamp / 1000)}:f>`);
    if (changes.length)
      log(after.guild, { title: "👤 Membro atualizado", description: `<@${after.id}>\n${changes.join("\n")}` });
  });

  client.on(Events.MessageDelete, (msg) => {
    if (!msg.guild || msg.author?.bot || isOurChannel(msg.channel)) return;
    log(msg.guild, {
      title: "🗑️ Mensagem apagada",
      description: `Em <#${msg.channelId}>${msg.author ? ` de <@${msg.author.id}>` : ""}\n${cut(msg.content)}`,
      color: COLORS.aviso,
    });
  });

  client.on(Events.MessageBulkDelete, (msgs, channel) => {
    if (isOurChannel(channel)) return;
    log(channel.guild, { title: "🧹 Mensagens apagadas em massa", description: `${msgs.size} mensagens em <#${channel.id}>`, color: COLORS.aviso });
  });

  client.on(Events.MessageUpdate, (before, after) => {
    if (!after.guild || after.author?.bot || isOurChannel(after.channel)) return;
    if (before.partial || before.content === after.content) return;
    log(after.guild, {
      title: "✏️ Mensagem editada",
      description: `Em <#${after.channelId}> por <@${after.author.id}> — [ver](${after.url})`,
      fields: [
        { name: "Antes", value: cut(before.content) },
        { name: "Depois", value: cut(after.content) },
      ],
    });
  });

  client.on(Events.ChannelCreate, async (ch) => {
    if (isOurChannel(ch)) return;
    log(ch.guild, {
      title: "📁 Canal criado",
      description: `<#${ch.id}> (${ChannelType[ch.type]})${await executor(ch.guild, AuditLogEvent.ChannelCreate, ch.id)}`,
      color: COLORS.ok,
    });
  });

  client.on(Events.ChannelDelete, async (ch) => {
    if (!ch.guild) return;
    if (isOurChannel(ch)) {
      // Se apagarem as salas do Claude, recria-as.
      forget(ch.guild.id);
      await ensureChannels(ch.guild);
      await log(ch.guild, { title: "⚠️ Sala do Claude apagada", description: `\`#${ch.name}\` foi apagada e recriada.`, color: COLORS.perigo });
      return;
    }
    log(ch.guild, {
      title: "🗑️ Canal apagado",
      description: `\`#${ch.name}\`${await executor(ch.guild, AuditLogEvent.ChannelDelete, ch.id)}`,
      color: COLORS.perigo,
    });
  });

  client.on(Events.GuildRoleCreate, async (r) =>
    log(r.guild, { title: "🏷️ Cargo criado", description: `<@&${r.id}>${await executor(r.guild, AuditLogEvent.RoleCreate, r.id)}`, color: COLORS.ok }),
  );

  client.on(Events.GuildRoleDelete, async (r) =>
    log(r.guild, { title: "🗑️ Cargo apagado", description: `\`@${r.name}\`${await executor(r.guild, AuditLogEvent.RoleDelete, r.id)}`, color: COLORS.perigo }),
  );

  client.on(Events.GuildRoleUpdate, (before, after) => {
    const changes = [];
    if (before.name !== after.name) changes.push(`Nome: \`${before.name}\` → \`${after.name}\``);
    if (before.color !== after.color) changes.push(`Cor: \`${before.hexColor}\` → \`${after.hexColor}\``);
    const gained = after.permissions.toArray().filter((p) => !before.permissions.has(p));
    const lost = before.permissions.toArray().filter((p) => !after.permissions.has(p));
    if (gained.length) changes.push(`➕ Permissões: ${gained.join(", ")}`);
    if (lost.length) changes.push(`➖ Permissões: ${lost.join(", ")}`);
    if (gained.includes("Administrator")) changes.push("⚠️ **Este cargo ganhou Administrador!**");
    if (changes.length) log(after.guild, { title: "🏷️ Cargo atualizado", description: `<@&${after.id}>\n${changes.join("\n")}` });
  });

  client.on(Events.GuildUpdate, (before, after) => {
    if (before.name !== after.name)
      log(after, { title: "🏠 Servidor atualizado", description: `Nome: \`${before.name}\` → \`${after.name}\`` });
  });
}
