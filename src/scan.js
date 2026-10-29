import { ChannelType, GuildVerificationLevel, GuildExplicitContentFilter, PermissionsBitField, SnowflakeUtil } from "discord.js";
import { isOurChannel } from "./setup.js";

const { Flags } = PermissionsBitField;

// Permissões que vale a pena destacar (poderosas ou arriscadas).
const KEY_PERMS = [
  "Administrator",
  "ManageGuild",
  "ManageRoles",
  "ManageChannels",
  "BanMembers",
  "KickMembers",
  "ModerateMembers",
  "ManageMessages",
  "MentionEveryone",
  "ManageWebhooks",
];

const daysAgo = (ts) => (ts ? Math.floor((Date.now() - ts) / 86_400_000) : null);

function lastActivity(ch) {
  if (!ch.lastMessageId) return null;
  return daysAgo(SnowflakeUtil.timestampFrom(ch.lastMessageId));
}

function isPrivate(ch, guild) {
  return ch.permissionOverwrites?.cache.get(guild.id)?.deny.has(Flags.ViewChannel) ?? false;
}

// Recolhe uma "fotografia" do servidor para o Claude analisar.
export async function buildSnapshot(guild) {
  const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);

  // Membros: em servidores grandes não vale a pena carregar todos.
  let members = guild.members.cache;
  if (guild.memberCount <= 5000) members = await guild.members.fetch().catch(() => guild.members.cache);
  const bots = members.filter((m) => m.user.bot && m.id !== guild.client.user.id);
  const humans = members.filter((m) => !m.user.bot);

  // Árvore de canais por categoria.
  const visible = channels.filter((c) => c && !isOurChannel(c));
  const categories = visible.filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => a.rawPosition - b.rawPosition);
  const describe = (c) => ({
    nome: c.name,
    tipo: ChannelType[c.type],
    privado: isPrivate(c, guild) || undefined,
    topico: c.topic?.slice(0, 150) || undefined,
    nsfw: c.nsfw || undefined,
    slowmode: c.rateLimitPerUser || undefined,
    ultima_msg_ha_dias: c.isTextBased?.() ? lastActivity(c) : undefined,
  });
  const childrenOf = (id) =>
    visible.filter((c) => c.parentId === id && c.type !== ChannelType.GuildCategory).sort((a, b) => a.rawPosition - b.rawPosition).map(describe);

  const estrutura = [
    { categoria: "(sem categoria)", canais: childrenOf(null) },
    ...categories.map((cat) => ({ categoria: cat.name, privada: isPrivate(cat, guild) || undefined, canais: childrenOf(cat.id) })),
  ].filter((g) => g.canais.length || g.categoria !== "(sem categoria)");

  const everyonePerms = guild.roles.everyone.permissions;

  // Amostra de conversa dos canais de texto mais ativos, para perceber o tema do servidor.
  const active = visible
    .filter((c) => c.type === ChannelType.GuildText && c.lastMessageId && !isPrivate(c, guild))
    .sort((a, b) => SnowflakeUtil.timestampFrom(b.lastMessageId) - SnowflakeUtil.timestampFrom(a.lastMessageId))
    .first(5);
  const amostra = [];
  for (const ch of active) {
    const msgs = await ch.messages.fetch({ limit: 15 }).catch(() => null);
    if (!msgs?.size) continue;
    amostra.push({
      canal: ch.name,
      mensagens: msgs
        .filter((m) => m.content)
        .reverse()
        .map((m) => `${m.author.bot ? "[bot] " : ""}${m.author.username}: ${m.content.slice(0, 200)}`),
    });
  }

  return {
    servidor: {
      nome: guild.name,
      descricao: guild.description,
      criado_ha_dias: daysAgo(guild.createdTimestamp),
      idioma: guild.preferredLocale,
      membros_total: guild.memberCount,
      humanos_carregados: humans.size,
      membros_novos_ultimos_7_dias: humans.filter((m) => daysAgo(m.joinedTimestamp) <= 7).size,
      boost_nivel: guild.premiumTier,
      boosts: guild.premiumSubscriptionCount,
      comunidade_ativada: guild.features.includes("COMMUNITY"),
      funcionalidades: guild.features,
      canal_regras: guild.rulesChannel?.name ?? null,
      canal_sistema: guild.systemChannel?.name ?? null,
      emojis: guild.emojis.cache.size,
      stickers: guild.stickers.cache.size,
    },
    seguranca: {
      nivel_verificacao: GuildVerificationLevel[guild.verificationLevel],
      filtro_conteudo_explicito: GuildExplicitContentFilter[guild.explicitContentFilter],
      "2fa_para_moderadores": guild.mfaLevel === 1,
      permissoes_perigosas_do_everyone: KEY_PERMS.filter((p) => everyonePerms.has(Flags[p])),
      cargos_com_administrador: roles.filter((r) => r.permissions.has(Flags.Administrator) && !r.managed).map((r) => `${r.name} (${r.members.size} membros)`),
    },
    estrutura_canais: estrutura,
    cargos: roles
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        nome: r.name,
        membros: r.members.size,
        cor: r.color ? r.hexColor : undefined,
        separado: r.hoist || undefined,
        de_bot: r.managed || undefined,
        permissoes_chave: r.permissions.has(Flags.Administrator)
          ? ["Administrator"]
          : KEY_PERMS.filter((p) => r.permissions.has(Flags[p])),
      })),
    bots_instalados: bots.map((b) => b.user.username),
    amostra_conversas: amostra,
  };
}

export const SCAN_PROMPT = `Acabei de entrar neste servidor e fiz um scan completo (dados em JSON abaixo).
Escreve uma primeira análise para o dono, em português, formatada para Discord (títulos com **negrito**, listas curtas, emojis com moderação). Máximo ~3500 caracteres. Estrutura:

1. **🔎 Que tipo de servidor é** — o teu palpite (gaming, comunidade, estudo, loja, amigos, criador de conteúdo, etc.), com base nos nomes, tópicos e conversas. Diz o grau de certeza.
2. **✅ O que está bem**
3. **⚠️ Problemas e riscos** — segurança (verificação, permissões do @everyone, demasiados admins), organização (canais mortos, sem categorias, sem regras/boas-vindas), cargos desarrumados, etc. Sê concreto, cita nomes.
4. **🛠️ O que eu mudaria** — propostas concretas e priorizadas.
5. **🤖 Bots recomendados** — 3 a 6 bots conhecidos úteis para ESTE tipo de servidor (diz para que serve cada um), tendo em conta os que já estão instalados (sugere remover duplicados ou inúteis). Lembra que eu próprio já trato de administração e logs.
6. **❓ Perguntas para ti** — 4 a 6 perguntas para perceber como o dono quer o servidor (objetivo, público, tamanho esperado, estilo, regras, se quer monetizar, etc.).

Termina a dizer que não mudas nada sem autorização e que basta ele responder às perguntas ou dizer "aplica" (tudo ou só alguns pontos) para começares.`;
