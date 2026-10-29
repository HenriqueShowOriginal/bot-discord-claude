# Bot de Discord com IA (Gemini, Groq, Cerebras, Claude…)

Um bot que gere o teu servidor através de conversa.

## As salas do Claude
Quando o bot entra no servidor, cria uma categoria privada **🤖 Claude** com duas salas:
- **#claude-chat:** só o dono (e os admins) a veem. Escreves aqui o que queres e o bot faz, sem precisares de o mencionar.
- **#claude-logs:** registo automático de tudo o que acontece. Ninguém escreve lá, só o bot:
  - entradas, saídas, expulsões e bans;
  - mensagens apagadas e editadas;
  - canais e cargos criados, apagados ou alterados (com aviso se um cargo ganhar Administrador);
  - mudanças de cargos, apelidos e castigos dos membros;
  - **cada ação que a IA faz**, com quem a pediu;
  - avisos e resumos que a IA decide publicar.

## Scan automático ao entrar no servidor
Na primeira vez que o bot entra num servidor, faz um **scan completo**:
- estrutura de canais e categorias, incluindo quais estão parados;
- cargos e permissões;
- bots instalados;
- definições de segurança (verificação, filtro de conteúdo, 2FA, permissões do @everyone);
- uma amostra das conversas recentes.

Depois publica na #claude-chat uma análise para o dono:
1. 🔎 que tipo de servidor parece ser;
2. ✅ o que está bem;
3. ⚠️ problemas e riscos;
4. 🛠️ o que mudaria, por prioridade;
5. 🤖 bots recomendados para esse tipo de servidor;
6. ❓ perguntas sobre como queres o servidor.

Respondes às perguntas ali mesmo, ou dizes "aplica" (tudo ou só alguns pontos). O bot não muda nada sem a tua autorização. Para repetir a análise, escreve `scan` na #claude-chat.

Se alguém apagar uma destas salas, o bot volta a criá-la. Para as recriar manualmente, escreve `setup` na #claude-chat ou `@Bot setup` em qualquer canal.

Também podes mencionar o bot em qualquer outro canal, por exemplo:

> @Bot cria uma categoria "Eventos" com um canal de texto #anuncios só de leitura para membros e um canal de voz "Palco"

> @Bot dá o cargo VIP ao João e muda a cor do cargo para dourado

> @Bot apaga as últimas 50 mensagens do #geral

A IA consulta o servidor, escolhe as ferramentas certas e executa. Antes de **apagar canais ou cargos, expulsar, banir ou limpar mensagens**, aparece um botão para confirmares.

## O que ele consegue fazer
- **Servidor:** ver informações, mudar o nome e a descrição
- **Canais:** listar, criar (texto, voz, categoria, fórum…), editar, mudar permissões, apagar
- **Cargos:** listar, criar, editar (cor, permissões, posição), apagar, dar e tirar cargos a membros
- **Membros:** procurar, mudar apelido, castigar (timeout), expulsar, banir e desbanir
- **Mensagens:** enviar (texto ou embed), ler, fixar, limpar, criar convites

Só **o dono do servidor**, quem tem **Administrador** ou os IDs em `ALLOWED_USERS` podem dar ordens ao bot. O bot lembra-se da conversa em cada canal. Escreve `@Bot reset` para apagar essa memória.

## Instalação

1. **Cria o bot:** em https://discord.com/developers/applications, vai a New Application > Bot.
   - Carrega em **Reset Token** e copia o token.
   - Liga **Server Members Intent** e **Message Content Intent**.
   - A permissão `Administrator` inclui "Ver registo de auditoria", que o bot usa para mostrar nos logs *quem* fez cada ação.
2. **Convida o bot:** em OAuth2 > URL Generator, escolhe os scopes `bot` e a permissão `Administrator`. Abre o link e adiciona o bot ao teu servidor.
   - Na lista de cargos, arrasta o cargo do bot para o topo, senão ele não consegue gerir os cargos que estão acima dele.
3. **Arranja pelo menos uma chave de IA.** O mais fácil é o Gemini, que é grátis: https://aistudio.google.com/apikey. Vê a secção "Várias IAs".
4. **Corre o bot** (precisas de Node.js 18 ou mais recente):
   ```bash
   npm install
   cp .env.example .env   # preenche DISCORD_TOKEN e pelo menos uma chave de IA
   npm start
   ```

Para o bot ficar ligado 24/7, aloja-o num VPS, Railway, Render, Fly.io ou similar.

## Várias IAs com reserva automática
O bot pode usar várias IAs. Em `AI_PROVIDERS` defines a ordem; se a primeira atingir o limite grátis ou falhar, o bot passa **automaticamente** para a seguinte, até a meio de um pedido. A conversa continua sem se perder nada.

```
AI_PROVIDERS=gemini,cerebras,groq          # 100% grátis
AI_PROVIDERS=gemini,groq,claude            # grátis, com o Claude como último recurso
AI_PROVIDERS=claude                        # só Claude
```

| IA | Preço | Onde tirar a chave |
|---|---|---|
| Gemini | grátis (com limites) | https://aistudio.google.com/apikey |
| Cerebras | grátis (com limites) | https://cloud.cerebras.ai |
| Groq | grátis (com limites) | https://console.groq.com/keys |
| OpenRouter | modelos `:free` grátis | https://openrouter.ai/keys |
| Ollama | grátis, corre no teu PC | https://ollama.com |
| Claude | pago (Haiku 5.5 é muito barato) | https://console.anthropic.com |

No fim de cada resposta aparece, em letra pequena, que IA respondeu. Se um serviço der "limite atingido", fica em pausa durante uns segundos ou minutos e as outras assumem.

⚠️ Os planos grátis mudam muitas vezes. Confirma os limites e os nomes dos modelos no site de cada serviço; os nomes podem ser trocados no `.env` (`GEMINI_MODEL`, etc.). Alguns planos grátis (ex.: Gemini fora da UE, Mistral) podem usar os dados para treino.

## Adicionar novas ferramentas
Em `src/tools.js`, acrescenta um objeto com `name`, `description`, `input_schema` e `run`. Se a ação for perigosa, junta `destructive: true` e `describe`. A IA passa a usá-la automaticamente.

## Notas
- Cada pedido envia ~5 a 8 mil tokens (instruções + ferramentas) e pode precisar de várias chamadas. Serviços com limites de tokens por minuto baixos (ex.: Groq grátis) esgotam-se mais depressa, e é para isso que serve a reserva automática.
- Os modelos grátis são menos fiáveis em pedidos grandes, como "reorganiza tudo". As ações perigosas pedem sempre confirmação com botão.
