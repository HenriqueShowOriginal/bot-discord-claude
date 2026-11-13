import test from "node:test";
import assert from "node:assert/strict";
import { PermissionsBitField } from "discord.js";
import { parseColor, parsePerms, toolMap, validateInput } from "../src/tools.js";

const tool = (name) => toolMap.get(name);

// Servidor de faz-de-conta com um cargo, para testar sem ligar ao Discord.
function fakeGuild(rolePerms = []) {
  const edits = [];
  const role = { id: "10", name: "Teste", permissions: new PermissionsBitField(rolePerms), edit: async (data) => edits.push(data) };
  return { edits, guild: { id: "1", roles: { fetch: async (id) => (id === "10" ? role : null), cache: new Map([["10", role]]) } } };
}

test("parsePerms recusa nomes desconhecidos em vez de os ignorar", () => {
  assert.throws(() => parsePerms(["manage_messages"]), /Permissões desconhecidas: manage_messages/);
  assert.throws(() => parsePerms(["ManageMessages", "banMembers"]), /banMembers/);
  assert.deepEqual(parsePerms(["ManageMessages", "BanMembers"]).toArray().sort(), ["BanMembers", "ManageMessages"]);
  assert.equal(parsePerms(undefined), undefined);
});

test("editar_cargo com permissão mal escrita não toca no cargo", async () => {
  const { guild, edits } = fakeGuild(["ManageMessages"]);
  await assert.rejects(tool("editar_cargo").run({ guild }, { cargo_id: "10", permissoes: ["manage_messages"] }), /Permissões desconhecidas/);
  assert.equal(edits.length, 0);
});

test("parseColor só aceita hex de 6 dígitos", () => {
  assert.equal(parseColor("#ff0000"), 0xff0000);
  assert.equal(parseColor("00FF00"), 0x00ff00);
  assert.equal(parseColor(""), undefined);
  assert.throws(() => parseColor("vermelho"), /Cor inválida/);
  assert.throws(() => parseColor("#fff"), /Cor inválida/);
});

test("validateInput: números fora dos limites são recusados", () => {
  const limpar = tool("limpar_mensagens");
  for (const quantidade of [-5, 0, 2.5, NaN, Infinity, 101, "10"]) {
    assert.ok(validateInput(limpar, { canal_id: "1", quantidade }), `devia recusar ${quantidade}`);
  }
  assert.equal(validateInput(limpar, { canal_id: "1", quantidade: 100 }), null);
  assert.match(validateInput(tool("banir_membro"), { usuario_id: "1", apagar_mensagens_dias: -3 }), /no mínimo 0/);
  assert.match(validateInput(tool("castigar_membro"), { membro_id: "1", minutos: 99999 }), /no máximo 40320/);
});

test("validateInput: obrigatórios, campos desconhecidos, enums e listas", () => {
  assert.match(validateInput(tool("criar_canal"), { nome: "x" }), /falta o campo obrigatório "tipo"/);
  assert.match(validateInput(tool("criar_canal"), { nome: "x", tipo: "xpto" }), /deve ser um de/);
  assert.match(validateInput(tool("criar_canal"), { nome: "x", tipo: "texto", extra: 1 }), /campo desconhecido/);
  assert.match(validateInput(tool("criar_cargo"), { nome: "x", permissoes: "Administrator" }), /lista/);
  assert.match(validateInput(tool("criar_cargo"), { nome: "x", permissoes: [1] }), /lista de string/);
  assert.equal(validateInput(tool("criar_canal"), { nome: "x", tipo: "texto", privado: true }), null);
  assert.equal(validateInput(tool("info_servidor"), null), "input inválido");
});

test("dar permissões poderosas pede confirmação; as inofensivas não", async () => {
  assert.equal(await tool("editar_cargo").needsConfirm({}, { cargo_id: "10", permissoes: ["Administrator"] }), true);
  assert.equal(await tool("editar_cargo").needsConfirm({}, { cargo_id: "10", permissoes: ["SendMessages"] }), false);
  assert.equal(await tool("editar_cargo").needsConfirm({}, { cargo_id: "10", nome: "novo" }), false);
  assert.equal(await tool("criar_cargo").needsConfirm({}, { nome: "mod", permissoes: ["BanMembers"] }), true);
  assert.equal(await tool("permissoes_canal").needsConfirm({}, { canal_id: "1", alvo_id: "2", permitir: ["ManageWebhooks"] }), true);
  assert.equal(await tool("permissoes_canal").needsConfirm({}, { canal_id: "1", alvo_id: "2", negar: ["ManageWebhooks"] }), false);

  assert.equal(await tool("dar_cargo").needsConfirm(fakeGuild(["Administrator"]), { membro_id: "5", cargo_id: "10" }), true);
  assert.equal(await tool("dar_cargo").needsConfirm(fakeGuild(["SendMessages"]), { membro_id: "5", cargo_id: "10" }), false);
});

test("todas as ferramentas que pedem confirmação sabem descrever o que vão fazer", () => {
  for (const t of toolMap.values()) {
    if (t.destructive || t.needsConfirm) assert.equal(typeof t.describe, "function", t.name);
  }
});
