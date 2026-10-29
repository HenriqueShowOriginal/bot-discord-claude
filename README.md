# Bot de Discord com Claude

Um bot que gere o teu servidor através de conversa.

## As salas do Claude
Quando o bot entra no servidor, cria uma categoria privada **🤖 Claude** com duas salas:
- **#claude-chat:** só o dono (e os admins) a veem. Escreves aqui o que queres e o bot faz, sem precisares de o mencionar.
- **#claude-logs:** registo automático de tudo o que acontece. Ninguém escreve lá, só o bot:
  - entradas, saídas, expulsões e bans;
  - mensagens apagadas e editadas;
  - canais e cargos criados, apagados ou alterados (com aviso se um cargo ganhar Administrador);
  - mudanças de cargos, apelidos e castigos dos membros;
  - **cada ação que o Claude faz**, com quem a pediu;
  - avisos e resumos que o Claude decide publicar.

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

O Claude consulta o servidor, escolhe as ferramentas certas e executa. Antes de **apagar canais ou cargos, expulsar, banir ou limpar mensagens**, aparece um botão para confirmares.

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
3. **Arranja a chave da API do Claude** em https://console.anthropic.com.
4. **Corre o bot** (precisas de Node.js 18 ou mais recente):
   ```bash
   npm install
   cp .env.example .env   # preenche DISCORD_TOKEN e ANTHROPIC_API_KEY
   npm start
   ```

Para o bot ficar ligado 24/7, aloja-o num VPS, Railway, Render, Fly.io ou similar.

## Adicionar novas ferramentas
Em `src/tools.js`, acrescenta um objeto com `name`, `description`, `input_schema` e `run`. Se a ação for perigosa, junta `destructive: true` e `describe`. O Claude passa a usá-la automaticamente.

## Notas
- O bot usa o modelo `claude-opus-5-5` com esforço `medium`. Tem fallback automático do lado do servidor (`fallbacks: "default"`): se um pedido for recusado por um filtro de segurança, outro modelo tenta responder.
- Cada pedido gasta tokens da API e pode precisar de várias chamadas. Pedidos grandes, como "reorganiza tudo", custam mais.
