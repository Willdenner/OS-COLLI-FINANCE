# Render Environment Map

Mapa das variáveis que o projeto usa no Render, separadas entre:

- `auto`: o Blueprint/Render já preenche sozinho
- `manual`: você precisa informar no painel do Render
- `opcional`: só preencha se for usar aquele recurso

## 1. `os-colli-finance` (serviço principal)

### Auto pelo Blueprint

| Variável | Origem | Observação |
| --- | --- | --- |
| `SERVICE_NAME` | `render.yaml` | Nome interno do serviço |
| `PORT` | `render.yaml` | Porta do container |
| `NODE_ENV` | `render.yaml` | `production` |
| `ADMIN_USER` | env group `colli-admin-auth` | Basic Auth do painel |
| `ADMIN_PASSWORD` | env group `colli-admin-auth` | Gerado pelo Render |
| `BOT_DATA_DIR` | `render.yaml` | Persistência local fallback |
| `DATABASE_URL` | `fromDatabase: colli-postgres` | Estado durável do sistema |
| `RECEIVABLES_SEND_DELAY_MS` | `render.yaml` | Intervalo padrão do lote de cobrança |
| `COBRANCAS_URL` | `render.yaml` | URL pública do módulo de cobrança |
| `COBRANCAS_INTERNAL_URL` | `fromService: bot-cobranca` | Link interno entre serviços |
| `EXTRATOR_URL` | `render.yaml` | URL pública do extrator |
| `EXTRATOR_INTERNAL_URL` | `fromService: bot-extrator` | Link interno entre serviços |

### Manual no Render

| Variável | Obrigatória | Quando usar |
| --- | --- | --- |
| `COLLI_FINANCE_CONTRACTS_URL` | Sim | Orquestrador puxar contratos novos do Finance |
| `COLLI_FINANCE_BILLING_CARDS_URL` | Sim | Orquestrador puxar cards de cobrança do dia/atrasados |
| `COLLI_FINANCE_PAYMENTS_URL` | Sim | Fechamento diário puxar pagamentos confirmados |
| `COLLI_FINANCE_API_TOKEN` | Depende | Se os endpoints do Finance exigirem bearer token |
| `CONTA_AZUL_CLIENT_ID` | Sim para Conta Azul | Integração OAuth com Conta Azul |
| `CONTA_AZUL_CLIENT_SECRET` | Sim para Conta Azul | Integração OAuth com Conta Azul |
| `CONTA_AZUL_REDIRECT_URI` | Sim para Conta Azul | Redirect URI cadastrado no app do Conta Azul |
| `CONTA_AZUL_BASE_URL` ou `CONTA_AZUL_API_BASE_URL` | Opcional | URL base da API (padrão: `https://api-v2.contaazul.com`) |
| `CONTA_AZUL_AUTH_URL` | Opcional | Página de login OAuth (padrão: `https://auth.contaazul.com/login`) |
| `CONTA_AZUL_TOKEN_URL` | Opcional | Endpoint de token OAuth (padrão: `https://auth.contaazul.com/oauth2/token`) |
| `CONTA_AZUL_SCOPE` ou `CONTA_AZUL_OAUTH_SCOPE` | Opcional | Escopos OAuth (padrão do app Conta Azul) |
| `CONTA_AZUL_HEALTH_PATH` ou `CONTA_AZUL_HEALTH_ENDPOINT` | Opcional | GET de “saúde” da conta (padrão: `/v1/pessoas/conta-conectada`, usado em testes de conexão) |
| `CONTA_AZUL_CONTRACTS_PATH` | Opcional | `POST` de criação de contrato (padrão: `/v1/contratos`); alinhe com a versão da API do app |
| `CONTA_AZUL_NEXT_CONTRACT_NUMBER_PATH` | Opcional | Próximo número de contrato (padrão: `/v1/contratos/proximo-numero`) |
| `CONTA_AZUL_AUTH_MODE` | Opcional | `bearer` (padrão), `custom_header` ou `none` — define como a API recebe a autorização |
| `CONTA_AZUL_ACCESS_TOKEN` / `CONTA_AZUL_REFRESH_TOKEN` | Opcional | Pré-preenchimento de tokens (útil com persistência; OAuth pelo painel continua válido) |
| `CONTA_AZUL_TOKEN_TYPE` / `CONTA_AZUL_ACCESS_TOKEN_TYPE` | Opcional | Tipo do token (padrão: `Bearer`) |
| `CONTA_AZUL_CUSTOM_HEADER_NAME` / `CONTA_AZUL_CUSTOM_HEADER_VALUE` | Opcional | Se `CONTA_AZUL_AUTH_MODE=custom_header` |
| `LOVABLE_WEBHOOK_SECRET` | Opcional | Se o serviço principal receber webhooks assinados |

### Observação crítica

Sem `COLLI_FINANCE_CONTRACTS_URL` e `COLLI_FINANCE_BILLING_CARDS_URL`, o FP&A não reconhece novos contratos nem novas cobranças. Agora a tela mostra isso como `Conexão Finance pendente`.

## 2. `bot-extrator`

### Auto pelo Blueprint

| Variável | Origem | Observação |
| --- | --- | --- |
| `SERVICE_NAME` | `render.yaml` | Nome interno |
| `PORT` | `render.yaml` | Porta do container |
| `ADMIN_USER` | env group `colli-admin-auth` | Basic Auth |
| `ADMIN_PASSWORD` | env group `colli-admin-auth` | Basic Auth |
| `REDIS_URL` | `fromService: colli-redis` | Hoje não é usado no fluxo principal |
| `DATABASE_URL` | `fromDatabase: colli-postgres` | Hoje não é usado no fluxo principal |
| `GOOGLE_CREDENTIALS_PATH` | `render.yaml` | `credentials.json` |
| `ENVIRONMENT` | `render.yaml` | `production` |
| `LOG_LEVEL` | `render.yaml` | `INFO` |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Dockerfile | Já aponta para `/usr/bin/chromium` |
| `CHROMIUM_EXECUTABLE_PATH` | Dockerfile | Já aponta para `/usr/bin/chromium` |

### Manual no Render

| Variável | Obrigatória | Quando usar |
| --- | --- | --- |
| `BASE_URL` | Sim | URL base do seu Finance, ex.: `https://finance.seudominio.com` |
| `LOGIN_EMAIL` | Sim | Login do extrator no Finance |
| `LOGIN_PASSWORD` | Sim | Senha do extrator no Finance |
| `SPREADSHEET_ID` | Sim | Planilha de destino no Google Sheets |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Sim no Render | JSON completo da service account |

### Observação crítica

No Render, use `GOOGLE_SERVICE_ACCOUNT_JSON`. O caminho de arquivo `credentials.json` só funciona se você montar o arquivo manualmente dentro do container, o que normalmente não acontece no Blueprint.

## 3. `bot-cobranca`

### Auto pelo Blueprint

| Variável | Origem | Observação |
| --- | --- | --- |
| `SERVICE_NAME` | `render.yaml` | Nome interno |
| `PORT` | `render.yaml` | Porta do container |
| `NODE_ENV` | `render.yaml` | `production` |
| `ADMIN_USER` | env group `colli-admin-auth` | Basic Auth |
| `ADMIN_PASSWORD` | env group `colli-admin-auth` | Basic Auth |
| `BOT_DATA_DIR` | `render.yaml` | Persistência local no disk |
| `DATABASE_URL` | `fromDatabase: colli-postgres` | Persistência principal |
| `REDIS_URL` | `fromService: colli-redis` | Provisionado pelo Blueprint |
| `DEFAULT_COUNTRY_CODE` | `render.yaml` | Default `55` |
| `MASS_SEND_DELAY_MS` | `render.yaml` | Default `15000` |
| `CHROME_EXECUTABLE_PATH` | Dockerfile | Já aponta para `/usr/bin/chromium` |

### Manual no Render

| Variável | Obrigatória | Quando usar |
| --- | --- | --- |
| `LOVABLE_WEBHOOK_SECRET` | Opcional | Se o bot receber webhook assinado direto da origem |
| `GMAIL_USER` | Opcional | Se for enviar cobranças por e-mail |
| `GMAIL_APP_PASSWORD` | Opcional | App Password do Gmail |
| `GMAIL_FROM_NAME` | Opcional | Nome exibido no remetente |
| `WHATSAPP_CHROMIUM_ARGS` | Opcional | Só se precisar customizar flags do Chromium |

### Observação crítica

Para o bot de cobrança funcionar por WhatsApp no Render, o que realmente importa é:

- o serviço subir com o disk persistente já definido no Blueprint
- o QR Code ser autenticado uma vez
- `CHROME_EXECUTABLE_PATH` continuar apontando para o Chromium do container

Ou seja: para WhatsApp, não existe uma variável manual obrigatória além do Basic Auth, que o próprio Blueprint já cria.

## 4. Valores que precisam bater entre serviços

| Variável | Serviços | Regra |
| --- | --- | --- |
| `ADMIN_USER` / `ADMIN_PASSWORD` | todos os web services | já unificados pelo env group |
| `LOVABLE_WEBHOOK_SECRET` | `os-colli-finance` e/ou `bot-cobranca` | só precisa ser igual se o mesmo origin estiver assinando webhooks para ambos |

## 5. Checklist mínimo para seu cenário atual

Pelo fluxo que você descreveu hoje, o mínimo manual no Render é:

### `os-colli-finance`

- `COLLI_FINANCE_CONTRACTS_URL`
- `COLLI_FINANCE_BILLING_CARDS_URL`
- `COLLI_FINANCE_PAYMENTS_URL`
- `COLLI_FINANCE_API_TOKEN` se houver autenticação
- `CONTA_AZUL_CLIENT_ID`
- `CONTA_AZUL_CLIENT_SECRET`
- `CONTA_AZUL_REDIRECT_URI`
- (opcionais) `CONTA_AZUL_BASE_URL`, `CONTA_AZUL_AUTH_URL`, `CONTA_AZUL_TOKEN_URL`, `CONTA_AZUL_SCOPE`, `CONTA_AZUL_CONTRACTS_PATH`, `CONTA_AZUL_NEXT_CONTRACT_NUMBER_PATH`, `CONTA_AZUL_HEALTH_PATH`, `CONTA_AZUL_AUTH_MODE`, tokens e header customizados — ver tabela acima

### `bot-extrator`

- `BASE_URL`
- `LOGIN_EMAIL`
- `LOGIN_PASSWORD`
- `SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`

### `bot-cobranca`

- nenhum obrigatório extra para WhatsApp
- `GMAIL_USER` e `GMAIL_APP_PASSWORD` apenas se quiser cobrança por e-mail
