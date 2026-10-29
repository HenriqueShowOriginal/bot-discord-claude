import { ChannelType, PermissionsBitField } from "discord.js";
import { COLORS, log } from "./logs.js";
import { isOurChannel } from "./setup.js";

// Ferramentas que o Claude pode usar no servidor.
// `destructive: true` => o bot pede confirmação com botões antes de executar.

const CHANNEL_TYPES = {
  texto: ChannelType.GuildText,
  voz: ChannelType.GuildVoice,
  categoria: ChannelType.GuildCategory,
  anuncios: ChannelType.GuildAnnouncement,
  palco: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
};

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
});
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });

async function getChannel(guild, id) {
  const ch = await guild.channels.fetch(id).catch(() => null);
  if (!ch) throw new Error(`Canal ${id} não encontrado`);
  return ch;
}
function protect(ch) {
  if (isOurChannel(ch)) throw new Error("As salas do Claude (#claude-chat e #claude-logs) estão protegidas.");
  return ch;
}
async function getRole(guild, id) {
  const role = await guild.roles.fetch(id).catch(() => null);
  if (!role) throw new Error(`Cargo ${id} não encontrado`);
  return role;
}
async function getMember(guild, id) {
  const m = await guild.members.fetch(id).catch(() => null);
  if (!m) throw new Error(`Membro ${id} não encontrado`);
  return m;
}
function parseColor(c) {
  if (!c) return undefined;
  return parseInt(String(c).replace("#", ""), 16);
}
function parsePerms(list) {
  if (!list) return undefined;
  return new PermissionsBitField(list.map((p) => PermissionsBitField.Flags[p]).filter(Boolean));
}

export const tools = [
  {
    name: "info_servidor",
    readOnly: true,
    description: "Mostra informações gerais do servidor (nome, dono, nº de membros, canais, cargos).",
    input_schema: obj({}),
    run: async ({ guild }) => ({
      id: guild.id,
      nome: guild.name,
      dono: guild.ownerId,
      membros: guild.memberCount,
      canais: guild.channels.cache.size,
      cargos: guild.roles.cache.size,
      boost: guild.premiumTier,
    }),
  },
  {
    name: "editar_servidor",
    description: "Altera o nome ou a descrição do servidor.",
    input_schema: obj({ nome: str("Novo nome"), descricao: str("Nova descrição") }),
    run: async ({ guild }, { nome, descricao }) => {
      await guild.edit({ name: nome, description: descricao });
      return "Servidor atualizado.";
    },
  },

  // ---------- Canais ----------
  {
    name: "listar_canais",
    readOnly: true,
    description: "Lista todos os canais e categorias com id, tipo, categoria-pai e posição.",
    input_schema: obj({}),
    run: async ({ guild }) => {
      const chans = await guild.channels.fetch();
      return chans.map((c) => ({
        id: c.id,
        nome: c.name,
        tipo: ChannelType[c.type],
        categoria: c.parentId,
        posicao: c.rawPosition,
      }));
    },
  },
  {
    name: "criar_canal",
    description: "Cria um canal ou categoria.",
    input_schema: obj(
      {
        nome: str("Nome do canal"),
        tipo: { type: "string", enum: Object.keys(CHANNEL_TYPES) },
        categoria_id: str("ID da categoria-pai (opcional)"),
        topico: str("Tópico do canal de texto (opcional)"),
        privado: bool("Se true, esconde o canal de @everyone"),
      },
      ["nome", "tipo"],
    ),
    run: async ({ guild }, { nome, tipo, categoria_id, topico, privado }) => {
      const ch = await guild.channels.create({
        name: nome,
        type: CHANNEL_TYPES[tipo],
        parent: categoria_id,
        topic: topico,
        permissionOverwrites: privado
          ? [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }]
          : undefined,
      });
      return { id: ch.id, nome: ch.name };
    },
  },
  {
    name: "editar_canal",
    description: "Edita nome, tópico, categoria, posição, slowmode ou NSFW de um canal.",
    input_schema: obj(
      {
        canal_id: str("ID do canal"),
        nome: str("Novo nome"),
        topico: str("Novo tópico"),
        categoria_id: str("Nova categoria-pai"),
        posicao: num("Nova posição"),
        slowmode_segundos: num("Slowmode em segundos (0 desliga)"),
        nsfw: bool("Marcar como NSFW"),
      },
      ["canal_id"],
    ),
    run: async ({ guild }, i) => {
      const ch = protect(await getChannel(guild, i.canal_id));
      await ch.edit({
        name: i.nome,
        topic: i.topico,
        parent: i.categoria_id,
        position: i.posicao,
        rateLimitPerUser: i.slowmode_segundos,
        nsfw: i.nsfw,
      });
      return "Canal atualizado.";
    },
  },
  {
    name: "permissoes_canal",
    description:
      "Define permissões de um cargo ou membro num canal. Use nomes de PermissionFlagsBits do discord.js (ex.: ViewChannel, SendMessages, Connect).",
    input_schema: obj(
      {
        canal_id: str("ID do canal"),
        alvo_id: str("ID do cargo ou membro (use o id do servidor para @everyone)"),
        permitir: { type: "array", items: { type: "string" } },
        negar: { type: "array", items: { type: "string" } },
      },
      ["canal_id", "alvo_id"],
    ),
    run: async ({ guild }, { canal_id, alvo_id, permitir = [], negar = [] }) => {
      const ch = protect(await getChannel(guild, canal_id));
      const overwrite = {};
      for (const p of permitir) overwrite[p] = true;
      for (const p of negar) overwrite[p] = false;
      await ch.permissionOverwrites.edit(alvo_id, overwrite);
      return "Permissões atualizadas.";
    },
  },
  {
    name: "apagar_canal",
    description: "Apaga um canal ou categoria. Ação irreversível.",
    destructive: true,
    input_schema: obj({ canal_id: str("ID do canal") }, ["canal_id"]),
    describe: async ({ guild }, { canal_id }) => `Apagar o canal **#${(await getChannel(guild, canal_id)).name}**`,
    run: async ({ guild }, { canal_id }) => {
      await protect(await getChannel(guild, canal_id)).delete();
      return "Canal apagado.";
    },
  },

  // ---------- Cargos ----------
  {
    name: "listar_cargos",
    readOnly: true,
    description: "Lista os cargos com id, cor, posição, nº de membros e permissões.",
    input_schema: obj({}),
    run: async ({ guild }) => {
      const roles = await guild.roles.fetch();
      return roles
        .sort((a, b) => b.position - a.position)
        .map((r) => ({
          id: r.id,
          nome: r.name,
          cor: r.hexColor,
          posicao: r.position,
          membros: r.members.size,
          permissoes: r.permissions.toArray(),
        }));
    },
  },
  {
    name: "criar_cargo",
    description: "Cria um cargo. Permissões usam nomes de PermissionFlagsBits (ex.: ManageMessages).",
    input_schema: obj(
      {
        nome: str("Nome do cargo"),
        cor: str("Cor em hex, ex.: #ff0000"),
        permissoes: { type: "array", items: { type: "string" } },
        separado: bool("Mostrar separado na lista de membros"),
        mencionavel: bool("Pode ser mencionado"),
      },
      ["nome"],
    ),
    run: async ({ guild }, i) => {
      const r = await guild.roles.create({
        name: i.nome,
        color: parseColor(i.cor),
        permissions: parsePerms(i.permissoes),
        hoist: i.separado,
        mentionable: i.mencionavel,
      });
      return { id: r.id, nome: r.name };
    },
  },
  {
    name: "editar_cargo",
    description: "Edita nome, cor, permissões ou posição de um cargo.",
    input_schema: obj(
      {
        cargo_id: str("ID do cargo"),
        nome: str("Novo nome"),
        cor: str("Nova cor hex"),
        permissoes: { type: "array", items: { type: "string" }, description: "Substitui todas as permissões" },
        posicao: num("Nova posição"),
      },
      ["cargo_id"],
    ),
    run: async ({ guild }, i) => {
      const r = await getRole(guild, i.cargo_id);
      await r.edit({
        name: i.nome,
        color: parseColor(i.cor),
        permissions: parsePerms(i.permissoes),
        position: i.posicao,
      });
      return "Cargo atualizado.";
    },
  },
  {
    name: "apagar_cargo",
    description: "Apaga um cargo. Ação irreversível.",
    destructive: true,
    input_schema: obj({ cargo_id: str("ID do cargo") }, ["cargo_id"]),
    describe: async ({ guild }, { cargo_id }) => `Apagar o cargo **@${(await getRole(guild, cargo_id)).name}**`,
    run: async ({ guild }, { cargo_id }) => {
      await (await getRole(guild, cargo_id)).delete();
      return "Cargo apagado.";
    },
  },
  {
    name: "dar_cargo",
    description: "Adiciona um cargo a um membro.",
    input_schema: obj({ membro_id: str("ID do membro"), cargo_id: str("ID do cargo") }, ["membro_id", "cargo_id"]),
    run: async ({ guild }, { membro_id, cargo_id }) => {
      await (await getMember(guild, membro_id)).roles.add(cargo_id);
      return "Cargo adicionado.";
    },
  },
  {
    name: "tirar_cargo",
    description: "Remove um cargo de um membro.",
    input_schema: obj({ membro_id: str("ID do membro"), cargo_id: str("ID do cargo") }, ["membro_id", "cargo_id"]),
    run: async ({ guild }, { membro_id, cargo_id }) => {
      await (await getMember(guild, membro_id)).roles.remove(cargo_id);
      return "Cargo removido.";
    },
  },

  // ---------- Membros / moderação ----------
  {
    name: "procurar_membros",
    readOnly: true,
    description: "Procura membros pelo nome (ou lista os primeiros, se não indicar nome).",
    input_schema: obj({ nome: str("Parte do nome/apelido"), limite: num("Máximo de resultados (padrão 25)") }),
    run: async ({ guild }, { nome, limite = 25 }) => {
      const members = nome
        ? await guild.members.search({ query: nome, limit: limite })
        : await guild.members.fetch({ limit: limite });
      return members.map((m) => ({
        id: m.id,
        usuario: m.user.tag,
        apelido: m.nickname,
        cargos: m.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name),
        bot: m.user.bot,
      }));
    },
  },
  {
    name: "mudar_apelido",
    description: "Muda o apelido de um membro (string vazia remove).",
    input_schema: obj({ membro_id: str("ID do membro"), apelido: str("Novo apelido") }, ["membro_id", "apelido"]),
    run: async ({ guild }, { membro_id, apelido }) => {
      await (await getMember(guild, membro_id)).setNickname(apelido || null);
      return "Apelido alterado.";
    },
  },
  {
    name: "castigar_membro",
    description: "Aplica timeout (castigo) a um membro. 0 minutos remove o castigo.",
    input_schema: obj(
      { membro_id: str("ID do membro"), minutos: num("Duração em minutos (máx. 40320)"), motivo: str("Motivo") },
      ["membro_id", "minutos"],
    ),
    run: async ({ guild }, { membro_id, minutos, motivo }) => {
      const m = await getMember(guild, membro_id);
      await m.timeout(minutos > 0 ? minutos * 60_000 : null, motivo);
      return minutos > 0 ? `Castigo de ${minutos} min aplicado.` : "Castigo removido.";
    },
  },
  {
    name: "expulsar_membro",
    description: "Expulsa (kick) um membro do servidor.",
    destructive: true,
    input_schema: obj({ membro_id: str("ID do membro"), motivo: str("Motivo") }, ["membro_id"]),
    describe: async ({ guild }, { membro_id }) => `Expulsar **${(await getMember(guild, membro_id)).user.tag}**`,
    run: async ({ guild }, { membro_id, motivo }) => {
      await (await getMember(guild, membro_id)).kick(motivo);
      return "Membro expulso.";
    },
  },
  {
    name: "banir_membro",
    description: "Bane um utilizador do servidor.",
    destructive: true,
    input_schema: obj(
      { usuario_id: str("ID do utilizador"), motivo: str("Motivo"), apagar_mensagens_dias: num("Apagar mensagens dos últimos N dias (0-7)") },
      ["usuario_id"],
    ),
    describe: async (_ctx, { usuario_id }) => `Banir o utilizador **<@${usuario_id}>**`,
    run: async ({ guild }, { usuario_id, motivo, apagar_mensagens_dias = 0 }) => {
      await guild.bans.create(usuario_id, {
        reason: motivo,
        deleteMessageSeconds: Math.min(7, apagar_mensagens_dias) * 86400,
      });
      return "Utilizador banido.";
    },
  },
  {
    name: "desbanir",
    description: "Remove o ban de um utilizador.",
    input_schema: obj({ usuario_id: str("ID do utilizador") }, ["usuario_id"]),
    run: async ({ guild }, { usuario_id }) => {
      await guild.bans.remove(usuario_id);
      return "Ban removido.";
    },
  },

  // ---------- Mensagens ----------
  {
    name: "enviar_mensagem",
    description: "Envia uma mensagem num canal de texto, opcionalmente como embed.",
    input_schema: obj(
      {
        canal_id: str("ID do canal"),
        texto: str("Conteúdo da mensagem"),
        embed_titulo: str("Se definido, envia como embed com este título"),
        embed_cor: str("Cor hex do embed"),
      },
      ["canal_id", "texto"],
    ),
    run: async ({ guild }, { canal_id, texto, embed_titulo, embed_cor }) => {
      const ch = await getChannel(guild, canal_id);
      const msg = embed_titulo
        ? await ch.send({ embeds: [{ title: embed_titulo, description: texto, color: parseColor(embed_cor) }] })
        : await ch.send(texto);
      return { mensagem_id: msg.id };
    },
  },
  {
    name: "ler_mensagens",
    readOnly: true,
    description: "Lê as últimas mensagens de um canal.",
    input_schema: obj({ canal_id: str("ID do canal"), quantidade: num("Quantas (máx. 100, padrão 20)") }, ["canal_id"]),
    run: async ({ guild }, { canal_id, quantidade = 20 }) => {
      const ch = await getChannel(guild, canal_id);
      const msgs = await ch.messages.fetch({ limit: Math.min(100, quantidade) });
      return msgs.reverse().map((m) => ({
        id: m.id,
        autor: m.author.tag,
        autor_id: m.author.id,
        texto: m.content.slice(0, 500),
        data: m.createdAt.toISOString(),
      }));
    },
  },
  {
    name: "fixar_mensagem",
    description: "Fixa (ou desafixa) uma mensagem.",
    input_schema: obj(
      { canal_id: str("ID do canal"), mensagem_id: str("ID da mensagem"), desafixar: bool("true para desafixar") },
      ["canal_id", "mensagem_id"],
    ),
    run: async ({ guild }, { canal_id, mensagem_id, desafixar }) => {
      const msg = await (await getChannel(guild, canal_id)).messages.fetch(mensagem_id);
      desafixar ? await msg.unpin() : await msg.pin();
      return "Feito.";
    },
  },
  {
    name: "limpar_mensagens",
    description: "Apaga as últimas N mensagens de um canal (máx. 100, só mensagens com menos de 14 dias).",
    destructive: true,
    input_schema: obj({ canal_id: str("ID do canal"), quantidade: num("Quantas apagar") }, ["canal_id", "quantidade"]),
    describe: async ({ guild }, { canal_id, quantidade }) =>
      `Apagar ${quantidade} mensagens em **#${(await getChannel(guild, canal_id)).name}**`,
    run: async ({ guild }, { canal_id, quantidade }) => {
      const ch = await getChannel(guild, canal_id);
      const deleted = await ch.bulkDelete(Math.min(100, quantidade), true);
      return `${deleted.size} mensagens apagadas.`;
    },
  },
  {
    name: "enviar_aviso",
    description:
      "Publica um aviso na sala #claude-logs (resumos de alterações, alertas, lembretes para o dono). Não usar para conversa normal.",
    input_schema: obj(
      {
        titulo: str("Título curto"),
        texto: str("Conteúdo do aviso"),
        nivel: { type: "string", enum: ["info", "ok", "aviso", "perigo"] },
      },
      ["titulo", "texto"],
    ),
    run: async ({ guild }, { titulo, texto, nivel = "info" }) => {
      await log(guild, { title: `🤖 ${titulo}`, description: texto, color: COLORS[nivel] });
      return "Aviso publicado nos logs.";
    },
  },
  {
    name: "criar_convite",
    description: "Cria um link de convite para um canal.",
    input_schema: obj(
      { canal_id: str("ID do canal"), horas: num("Validade em horas (0 = nunca expira)"), usos: num("Máximo de usos (0 = ilimitado)") },
      ["canal_id"],
    ),
    run: async ({ guild }, { canal_id, horas = 24, usos = 0 }) => {
      const inv = await (await getChannel(guild, canal_id)).createInvite({ maxAge: horas * 3600, maxUses: usos });
      return inv.url;
    },
  },
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));

// Definições enviadas à API (sem as funções locais).
export const apiTools = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

// Validação simples do input (campos obrigatórios e tipos básicos).
export function validateInput(tool, input) {
  if (typeof input !== "object" || input === null) return "input inválido";
  const { properties, required = [] } = tool.input_schema;
  for (const key of required) if (input[key] === undefined) return `falta o campo obrigatório "${key}"`;
  for (const [key, value] of Object.entries(input)) {
    const spec = properties[key];
    if (!spec) return `campo desconhecido "${key}"`;
    const ok = spec.type === "array" ? Array.isArray(value) : typeof value === spec.type;
    if (!ok) return `campo "${key}" deve ser ${spec.type}`;
    if (spec.enum && !spec.enum.includes(value)) return `campo "${key}" deve ser um de: ${spec.enum.join(", ")}`;
  }
  return null;
}
