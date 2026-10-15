# Zonde Systems — Bot Discord

Bot Discord em português brasileiro, desenvolvido com Node.js e discord.js v14. Comandos slash e o prefixo oficial `!red` encaminham para os mesmos serviços.

## Requisitos e inicialização

• Node.js 22.13 ou superior (utiliza o módulo integrado `node:sqlite`).
• `npm install`
• Copie `.env.example` para `.env` e configure `DISCORD_TOKEN` para iniciar o bot.
• `npm start`

Os comandos slash são registrados ao conectar. Para atualização imediata durante desenvolvimento, configure `DISCORD_GUILD_ID`; sem essa variável, o registro é global e pode levar algum tempo para aparecer.

`NVIDIA_API_KEY` é necessária para o chat com IA e o `/iacriar`, atendidos pelo modelo NVIDIA `z-ai/glm-5.3-flash`; sem ela, esses recursos permanecem indisponíveis e o restante do bot pode ser inicializado. `HUEHUE_API_KEY` é usada pelas integrações HueHue existentes, como `/discordver`; ela não é usada pelo monitor RedCloud de missões. `DATABASE_PATH` é opcional e por padrão usa `./data/zond.sqlite`.

## Configuração do Discord

No Developer Portal, habilite os intents privilegiados **Server Members Intent** e **Message Content Intent**. Convide o bot com os escopos `bot` e `applications.commands`.

Permissões do bot:

• Ver canais e enviar mensagens.
• Incorporar links (embeds).
• Gerenciar canais.
• Gerenciar cargos — necessário somente para configurar permissões básicas por meio do `/iacriar`.
• Ver registro de auditoria — necessário para detectar criação de webhooks.

As permissões do usuário são verificadas separadamente e respeitam a hierarquia de cargos. Não conceda permissões administrativas ao bot.

## Comandos

• `/discordinvite` ou `!red discordinvite` — convite oficial.
• `/painel` ou `!red painel` — atualizar/localizar a Central RedCloud no canal fixo.
• `/status` ou `!red status` — resumo dos serviços.
• `/news status` ou `!red news status` — estado do jornal.
• `/discordver` ou `!red discordver` — consulta informações de Discord Developers na API HueHue.
• `/ver` ou `!red ver` — menu com as quatro categorias Anti, Ticket, IA e Logs.
• `/zonde info`, `/zonde owner`, `!red info` e `!red owner`.
• `/ia mensagem` e mensagens gerais `!red <mensagem>` — NVIDIA GLM-5.3 Flash.
• `/iacriar` e `!red iacriar <pedido>` — cria um plano restrito, mostra a prévia e exige confirmação antes de executar.
• `/anti` e `!red anti` — controles por módulo, estado, limites, exceções de links e registros.
• `/clear all canal:#canal` — após confirmação, limpa mensagens possíveis somente no canal selecionado; sem `canal`, usa o canal atual.
• `/clear online acao:ativar canal:#canal` — após confirmação, apaga somente mensagens novas do canal configurado. Use `acao:desativar` ou `acao:status` para controlar o monitoramento.
• `/jornal canal canal:#noticias`, `/jornal automatico estado:ativar|desativar` e `/jornal estado` — configurar, ativar e consultar notícias automáticas.
• `/jornal intervalo minutos:5`, `/jornal fonte listar|adicionar|remover` e `/jornal teste` — ajustar consultas, fontes RSS/Atom e testar com notícia real ainda não publicada.
• `/ticket` e `!red ticket` — publicar/configurar painéis, abrir atendimentos por formulário, adicionar/remover participantes, assumir/encerrar tickets, gerar transcrições, coletar avaliações e consultar estatísticas.
• `/quest listar`, `/quest concluir` e `/quest criar` — acompanhar missões próprias do servidor; cadastro exige Gerenciar servidor e conclusões são autorrelatadas no Zond, sem alterar quests oficiais do Discord. O prefixo equivalente é `!red quest`.
• `/errorver` e `!red errorver` — erros técnicos, restritos ao proprietário e administradores.
• `!red quest status`, `!red news status`, `!red ia status` e `!red ia diagnostico` — estados e diagnóstico da IA (restrito).
• `/disponíveis` e `/indisponíveis`, com equivalentes no prefixo — configuração dos canais de missões.

As listas de domínio podem ser alteradas com `/anti links domain` (bloqueados ou autorizados); exceções de cargo/canal são configuradas com `/anti links exception`. O painel `/anti config` também permite ajustar limites e alternar individualmente os seis módulos.

## Central RedCloud

O painel administrativo fica no canal `1559371103120527450`. Ao iniciar, o bot atualiza a mensagem salva no SQLite, procura o marcador caso a mensagem tenha sido removida e só então recria; não publica cópias quando a existente está acessível. `/painel` ou `!red painel` permite a administradores atualizar/localizar o painel. As permissões são revalidadas em cada interação; Administrador, Gerenciar servidor, proprietário configurado e cargos Founder/Direção/Gestão existentes têm acesso. `ADMIN_ROLE_IDS` é opcional para cargos adicionais.

O painel inclui estado geral, alternância das proteções antispam existentes, configuração de canais, News, Quest, catálogo, publicações simples/embeds, logs, diagnóstico da IA e erros recentes. O catálogo continua usando o gerenciador de loja existente. Publicações criadas no painel podem ser editadas ou excluídas somente pelos IDs que o próprio painel registrou. `REDCLOUD_ICON_URL` é opcional e só é usado se for uma URL HTTPS válida.

## Limpeza e jornal

`/clear all` pede confirmação privada e limita a operação ao canal escolhido. Mensagens com mais de 14 dias são excluídas individualmente, conforme as regras do Discord. A limpeza automática monitora somente o canal habilitado, não varre o histórico e remove mensagens novas de membros, bots e webhooks; a ativação exige confirmação explícita e pode apagar mensagens importantes.

O jornal usa RSS/Atom público por HTTPS, inicia desativado e consulta a cada 5 minutos por padrão. A fonte padrão editável está em `config.newsDefaultSources`; fontes também podem ser gerenciadas por `/jornal fonte adicionar`, `/jornal fonte remover` e `/jornal fonte listar`. Configure um canal com `/jornal canal`, revise as fontes e ative com `/jornal automatico estado:ativar`. `/jornal teste` publica apenas uma notícia real ainda não enviada. O status usa timestamp relativo do Discord para indicar a próxima consulta, não garantir que haverá uma notícia.

Os agendamentos, fontes, estado e IDs deduplicados são persistidos por servidor no SQLite existente. Para sobreviver a reinicializações da hospedagem, mantenha `DATABASE_PATH` em um volume persistente. Nenhuma variável de ambiente nova é obrigatória; as fontes padrão podem ser editadas em `src/config.js`.

Para ativar tickets em um servidor, configure uma categoria e os canais/cargos de equipe com `/ticket configurar`; depois publique o painel com `/ticket painel`. Revise os canais e cargos padrão no próprio servidor antes do uso. Transcrições só são enviadas a um canal que não permita visualização por `@everyone`; configure um destino privado. Também é possível personalizar limite por usuário, comportamento de fechamento e conteúdo do painel.

Para missões do servidor, um membro com **Gerenciar servidor** cadastra com `/quest criar` (ou `!red quest criar Título | descrição`). Os membros usam `/quest listar` e `/quest concluir missao:<id>` (ou `!red quest concluir <id>`). A conclusão é um registro autorrelatado persistido por servidor e membro, não uma validação automática nem uma alteração no progresso ou nas recompensas das quests oficiais do Discord.

## Missões e Source Codes

O monitor externo é independente do `/quest` local. A origem não usa HueHue: configure um endpoint público JSON HTTPS por `/missoes configurar fonte_url:<URL>` ou pela seção Quest do painel. O host é validado por DNS para bloquear endereços locais/privados, a consulta não envia credenciais, não segue redirects e limita a resposta a 1 MB/10 segundos. O JSON deve conter uma lista em `missions`, `missoes` ou `data`; os registros precisam de ID, título/nome e data de expiração. O sistema não inventa recompensas, datas, tradução ou imagem. Sem fonte configurada, a sincronização é omitida e o status informa a limitação. O intervalo configurável padrão é 300 segundos.

O adaptador rejeita registros sem identificador, nome e data de expiração reconhecíveis, deduplica por ID e não trata uma falha de consulta como expiração. Não foi confirmado um notificador público/atualizável oficial de Discord Quests; portanto, não há feed oficial pré-configurado. `src/autoquest` contém automação que depende de internals privados do cliente Discord e não é executada pelo bot.

A loja Source Codes publica painel e catálogo persistentes nos canais configurados. Os comandos incluem `/loja painel|catalogo|listar|cadastrar|editar|arquivo|ativar|preco|comprar|cancelar|pedido|confirmar|entregar|reenviar|vendas`; compradores podem usar `comprar` e `cancelar`, enquanto cada operação administrativa valida novamente os cargos autorizados. Founder tem acesso completo, Direção/Gestão administram e Staff recebe apenas as operações listadas em `STORE_STAFF_OPERATIONS` (padrão: `list,catalog,stats`). O cargo Geral não recebe permissões administrativas.

Não há gateway de pagamento integrado: somente confirmação manual por equipe autorizada muda um pedido para pago. O bot envia ZIP privado por DM após a autorização, registra tentativas e não reenvia automaticamente uma entrega pendente após reinicialização. Reenvios requerem autorização explícita.

`PRODUCT_STORAGE_PATH` deve apontar para um volume privado e persistente; o padrão `./data/private-products` só persiste se a hospedagem preservar `./data`. O armazenamento total padrão é 1 GiB (`PRODUCT_MAX_STORAGE_BYTES`) e cada ZIP pode ter até 10 MiB (`PRODUCT_MAX_ZIP_BYTES`). `DATABASE_PATH` também deve estar em volume persistente para preservar produtos, pedidos, histórico e reservas. O bot valida os ZIPs sem extraí-los ou executá-los. Conceda acesso do bot aos canais Source Codes, jornal e logs configurados, incluindo ver canal, enviar mensagens, incorporar links e ler histórico nos canais de mensagens persistentes.

Proteções e punições iniciam desativadas. As implementações anti registram detecções, mas não aplicam timeout, exclusão de mensagens ou remoção de webhooks automaticamente.

## Persistência e privacidade

SQLite persiste configurações separadas por servidor, votos de painéis, logs e até 200 erros técnicos/5.000 eventos recentes. Em hospedagem efêmera, configure `DATABASE_PATH` para um volume persistente. Segredos devem permanecer apenas no ambiente; `.env` está ignorado pelo Git.

Os erros técnicos são sanitizados antes de persistidos e `/errorver` é privado. Logs de servidor são enviados somente ao canal configurado por administrador; sem canal, permanecem no banco.

## Limitações conhecidas

• O chat usa a API NVIDIA compatível com OpenAI, sem streaming, com temperatura 0.5, top_p 1 e máximo de 1.024 tokens. Erros de autenticação, limite, timeout e indisponibilidade são registrados sem gravar a chave.
• Não foi confirmado um notificador oficial/atualizável de Discord Quests para bots. O monitor aguarda um feed público autorizado; não publica missões até uma fonte ser configurada.
• A fonte oficial de Discord Quests permanece externa: forneça um endpoint público JSON HTTPS autorizado antes de ativar o monitor. Não há tradução automática configurada.
• Planos do `/iacriar` só aceitam a allowlist de operações documentada no código, permissões válidas e confirmação explícita; não executam código arbitrário.
• O monitoramento anti-webhook depende do evento e do registro de auditoria disponível ao bot. Anti-links só registra os domínios bloqueados configurados; não remove mensagens.

## Verificações

• `npm test` — valida isolamento, persistência, sanitização, parser de respostas, allowlist de ações e registro/configuração de comandos, incluindo tickets.
• `npm run check` — valida a sintaxe de todos os módulos de execução, incluindo o sistema de tickets.
# 🤖 Zond Discord Bot

> **Disclaimer:** Selfbots and custom API quest auto-completers are against Discord ToS. Use at your own risk.

Bot multifuncional avançado para o Discord com sistema modular de tickets, moderação, IA, proteção anti-raid e automação de quests.

## ✨ Recursos
- Sistema completo de moderação e tickets.
- Automação e suporte para Quests do Discord.
- Integração com inteligência artificial.

## 🚀 Instalação
1. Clone o repositório.
2. Execute `npm install`.
3. Configure o seu ficheiro `.env` com o token.
4. Execute `npm start`.
