# Rotina · dieta e treino

App pessoal (PWA) para acompanhar dieta e treinos todo dia, pelo celular, sem login.

* **Front:** React + Vite + TypeScript, PWA instalável, funciona offline (fila local de registros).
* **Back:** uma Netlify Function (`netlify/functions/api.mts`) com rotas em `/api/*`.
* **Banco e fotos:** Supabase (Postgres + Storage, bucket privado `photos`).
* **Acesso:** link secreto `https://SEU-SITE.netlify.app/?k=TOKEN`. O token fica no `localStorage`, sai da URL e vai no header `x-app-token`. As Functions respondem 401 se não bater com `APP_TOKEN`. A chave service role do Supabase só existe nas Functions.

## Instalação (uma vez)

1. **Supabase** (plano gratuito): crie um projeto, abra *SQL Editor*, cole o conteúdo de `supabase/setup.sql` e rode (pode rodar de novo sem problema; ao rodar de novo, o plano volta ao do seed). Isso cria as tabelas, a view `daily_summary`, o bucket privado `photos` e carrega o plano inicial (dieta 2.500 kcal + treino HYROX). Em *Project Settings → API* copie a **Project URL** e a chave **service_role**.
2. **Netlify:** *Add new site → Import from GitHub* → este repositório. Build e pasta já vêm do `netlify.toml`.
3. **Variáveis de ambiente** (Site configuration → Environment variables):

| Variável | Valor |
|---|---|
| `APP_TOKEN` | token longo e aleatório (o do seu link) |
| `SUPABASE_URL` | Project URL do Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | chave service_role |
| `ENABLE_PHOTO_AI` | `false` (padrão) |
| `ANTHROPIC_API_KEY` | só se ligar a IA de fotos |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | fase 2 |
| `STRAVA_VERIFY_TOKEN` | opcional (fase 2) |
| `MCP_TOKEN` | token do conector do Claude (diferente do `APP_TOKEN`), ver "Conectar ao Claude" |
| `MCP_ALLOW_PATH_TOKEN` | só `true` se precisar do plano B do conector (padrão: não definir) |

4. *Deploys → Trigger deploy*. Abra `https://SEU-SITE.netlify.app/?k=APP_TOKEN` no celular e use "Adicionar à tela de início".

Desenvolvimento: `npm install`, `npm run check` (lint, tipos, testes e build). Para rodar com as Functions localmente: `npx netlify dev` com um `.env`.

## Peso, fotos e água

* **Peso e fotos:** na segunda e na sexta a tela Hoje mostra o cartão "Peso e fotos" (peso em jejum, foto de frente e de lado). As fotos ficam no bucket privado do Supabase.
* **Evolução:** gráfico do peso, efeito médio do fim de semana (sexta → segunda) e comparação de fotos antes e depois, de frente ou de lado.
* **Água:** botões +500 ml e +1 L; meta padrão de 5 L, ajustável no Plano.

## Fechamento (semana, mês e acumulado)

* **Assertividade** = média de 4 pilares no período: dias com calorias na meta, refeições feitas, treinos previstos feitos e dias com a meta de água. Dias futuros não contam.
* **O que funcionou / onde falhou** é gerado a partir dos dados: dias acima ou abaixo da meta, refeição mais pulada, treinos não feitos, água, extras e álcool, peso no fim de semana e de segunda a sexta.
* Mês e acumulado mostram a nota de cada semana. A mesma análise está no conector do Claude (`get_review`) e no Excel (aba Resumo semanal e aba Peso).

## Regras de cálculo

* **Ingerido** = refeições marcadas (calorias reais se preenchidas, senão as previstas) + extras.
* **Dentro da meta** = ingerido entre meta − tolerância e meta + tolerância (padrão 10%). Dia sem registro não conta como dentro.
* **Gasto** = calorias dos treinos feitos + gasto base (se configurado). **Saldo** = ingerido − gasto, só com gasto base.
* As médias do resumo usam só dias com registro. As calorias de treino do plano são **estimativas**: ajuste no Plano ou no registro do dia.

## Importar plano (Plano → Importar plano)

```json
{
  "replace": true,
  "settings": { "calorie_goal": 2500, "tolerance_pct": 10, "base_expenditure": null },
  "meals": [
    {
      "weekdays": "todos",
      "name": "Almoço",
      "time": "12:00",
      "description": "Frango, arroz e legumes",
      "items": [{ "food": "Peito de frango", "qty": "110 g", "kcal": 175 }],
      "kcal": 518, "protein": 43, "carbs": 64, "fat": 9
    }
  ],
  "workouts": [
    {
      "weekdays": ["seg", "qua", "sex"],
      "name": "HYROX",
      "kind": "hyrox",
      "details": "Treino HYROX",
      "exercises": [{ "name": "Wall ball", "sets": "4", "reps": "20" }],
      "duration_min": 60, "kcal": 700
    }
  ]
}
```

* `weekdays`: número (0 = domingo … 6 = sábado), nome (`dom`, `seg`, `ter`, `qua`, `qui`, `sex`, `sab`), `todos`, `uteis`, `fds`, ou lista disso.
* `time`: `HH:MM`. `kind`: `hyrox`, `run`, `strength` ou `other` (usado para casar atividades do Strava).
* `replace: true` substitui as refeições (se `meals` vier) e os treinos (se `workouts` vier). `false` só adiciona.
* Opcionais: `description`, `items`, `protein`, `carbs`, `fat`, `details`, `exercises`, `duration_min`, `kcal`, `time` do treino.
* O plano inicial completo está em `supabase/seed-plan.json` (é um exemplo válido deste formato).

## Importar lançamentos do dia (Exportar → Importar lançamentos)

```json
{
  "date": "2026-11-25",
  "meals": [{ "name": "Almoço", "done": true, "kcal": 650, "note": "comi fora" }],
  "extras": [{ "description": "2 cervejas", "kcal": 300, "time": "21:00", "category": "alcool" }],
  "workouts": [{ "name": "HYROX", "done": true, "duration_min": 62, "kcal": 740, "distance_km": 8.2, "avg_hr": 151, "note": "" }]
}
```

* Refeições e treinos são casados **pelo nome** com o plano daquele dia (sem diferenciar acento e maiúscula). Treino sem par vira "avulso".
* `meals[].kcal` = calorias reais (opcional). `done` padrão `true`.
* `category` do extra: `alcool`, `lanche`, `refeicao` ou `outro`.
* Prompt sugerido para o Claude no chat: *"Gere o JSON de lançamentos do dia no formato do app Rotina (date, meals, extras, workouts) a partir deste print/foto."*

## Fotos e IA

Por padrão a foto é só comprimida no celular (máx. 1280 px), enviada ao bucket privado e anexada à refeição; as calorias reais você digita.
Com `ENABLE_PHOTO_AI=true` e `ANTHROPIC_API_KEY`, aparece o botão "Estimar calorias com IA" (rota `/api/analyze-photo`, modelo `claude-haiku-5-5`, o mais barato). A tela deixa claro que é estimativa e só aplica se você tocar em "Usar".

## Fase 2: Strava

1. Em https://www.strava.com/settings/api crie um app com *Authorization Callback Domain* = `SEU-SITE.netlify.app`.
2. Coloque `STRAVA_CLIENT_ID` e `STRAVA_CLIENT_SECRET` na Netlify e refaça o deploy.
3. No app: Plano → **Conectar Strava** → autorize → **Ativar webhook** (uma vez).
4. Cada atividade nova chega pelo webhook (`/api/strava/webhook`); o app busca só aquela atividade (duração, distância, calorias, FC média) e marca o treino previsto do dia do mesmo tipo. Se escolher errado, abra o treino e use "Este treino cumpre qual do plano?" ou "Não é este treino". O botão "Buscar últimos 7 dias" serve de reserva.

Tokens do Strava ficam só no banco (`strava_tokens`) e nas Functions.

## Conectar ao Claude (MCP)

O app tem um servidor MCP em `https://SEU-SITE.netlify.app/mcp` (Streamable HTTP, sem sessão) para você registrar e consultar tudo conversando com o Claude, no claude.ai ou no app do celular, sem abrir a Rotina. Ele usa as mesmas funções do app: mesmas regras de meta e saldo, mesma importação, mesmo banco.

### 1. Gerar o MCP_TOKEN

No terminal (Mac/Linux): `openssl rand -base64 48 | tr '+/' '-_' | tr -d '='`. Use um valor **diferente** do `APP_TOKEN`.

### 2. Configurar na Netlify

*Site configuration → Environment variables → Add a variable*: `MCP_TOKEN` = o valor gerado. Depois *Deploys → Trigger deploy*.
Teste rápido: `curl -i -X POST https://SEU-SITE.netlify.app/mcp` deve responder `401` (sem token).

### 3. Cadastrar o conector no Claude

No claude.ai (navegador): **Customize → Connectors → Add → Add custom connector**.

1. **Name:** `Rotina`
2. **Remote MCP server URL:** `https://SEU-SITE.netlify.app/mcp` → *Continue*
3. **Authentication:** *No sign-in*
4. **Request headers:** header `authorization`, valor `Bearer SEU_MCP_TOKEN` (com a palavra `Bearer` e um espaço; o Claude envia exatamente o que você digitar), marcar como obrigatório → *Add*
5. Numa conversa: botão **+ → Connectors →** ligue **Rotina**. Conectores da conta também aparecem no app do celular.

Para trocar o token depois: remova o conector e cadastre de novo (headers não podem ser editados).

**Se a seção "Request headers" não aparecer:** a Anthropic ainda está liberando esse recurso (beta) aos poucos. Plano B sem mudar código: na Netlify defina `MCP_ALLOW_PATH_TOKEN=true` e cadastre a URL `https://SEU-SITE.netlify.app/mcp/SEU_MCP_TOKEN` com *No sign-in*. Funciona, mas o token fica na URL (trate a URL como senha). A alternativa definitiva é um OAuth mínimo (um usuário, login por senha) no próprio site.

### Ferramentas

| Ferramenta | O que faz |
|---|---|
| `get_day(date)` | plano do dia, o que foi feito, extras, kcal ingeridas, gastas, saldo, meta |
| `get_range(from, to)` | métricas do período (adesão, médias, dias na meta, sequência) e cada dia |
| `get_plan()` | plano semanal com ids |
| `set_meal_done(date, meal_id, done, kcal_real?, note?)` | marca/desmarca refeição (id ou nome, ex.: "almoço") |
| `log_workout(date, workout_id?, type, duration_min, distance_km?, avg_pace?, avg_hr?, kcal?, source?, note?)` | registra treino; sem id cumpre o previsto do mesmo tipo |
| `add_extra(date, description, kcal, time?)` | extra fora do plano (álcool é detectado pela descrição) |
| `remove_entry(date, entry_type, entry_id)` | desfaz refeição, treino, extra ou troca de dia |
| `move_workout(from_date, to_date, workout_id?)` | troca o treino de dia só naquela data |
| `update_plan(plan_json, confirm=false)` | prévia das diferenças; grava só com `confirm=true` |
| `import_json(payload, confirm=false)` | lançamentos do dia (ou plano) com prévia e merge idempotente |
| `get_export(from, to, format)` | link de 1 hora, assinado, para baixar o .xlsx ou .csv |
| `log_weight(date, weight_kg, note?)` | peso em jejum (segunda e sexta); fotos são pelo app |
| `add_water(date, add_ml? , total_ml?)` | água do dia: `add_ml` soma, `total_ml` fixa o total |
| `get_review(period, date?)` | fechamento da semana, do mês ou acumulado: nota, o que funcionou, onde falhou, peso |

Todas as escritas são idempotentes: repetir a mesma frase não duplica nada. `date` omitido = hoje (America/Sao_Paulo).

### Exemplos de frases

| Você fala | O Claude chama |
|---|---|
| "marquei o almoço" | `set_meal_done(meal_id: "almoço", done: true)` |
| "almocei fora, umas 900 kcal" | `set_meal_done(meal_id: "almoço", kcal_real: 900)` |
| "não comi a ceia ontem" | `set_meal_done(date: ontem, meal_id: "ceia", done: false)` |
| "bebi duas cervejas de 350 ml" | `add_extra(description: "2 cervejas 350 ml", kcal: ~300)` (categoria álcool automática) |
| "fiz o HYROX, 62 min, 740 kcal, FC 151" | `log_workout(type: "hyrox", duration_min: 62, kcal: 740, avg_hr: 151)` |
| "corri 6 km em 33 min, pace 5:30" | `log_workout(type: "run", duration_min: 33, distance_km: 6, avg_pace: "5:30")` |
| "troquei o treino de sexta para sábado" | `move_workout(from_date: sexta, to_date: sábado)` |
| "desfaz a cerveja" | `get_day` → `remove_entry(entry_type: "extra", entry_id: …)` |
| "como estou hoje?" | `get_day()` |
| "como foi minha semana?" | `get_range(segunda, domingo)` |
| "qual meu treino de quinta?" | `get_plan()` |
| "muda a ceia para 22h" | `update_plan(…)` mostra a prévia → você confirma → `confirm: true` |
| "pesei 84,3 hoje" | `log_weight(weight_kg: 84.3)` |
| "tomei mais um litro de água" | `add_water(add_ml: 1000)` |
| "como fechou minha semana?" | `get_review(period: "week")` |
| "e o mês? e desde o começo?" | `get_review(period: "month")` / `get_review(period: "all")` |
| "me manda a planilha de novembro" | `get_export(from: "2026-11-01", to: "2026-11-30", format: "xlsx")` |

### Segurança

Token comparado em tempo constante; sem token ou token errado: `401` sem detalhes. Os logs registram só o tipo do erro, nunca token, corpo da requisição ou dados de saúde. O link de exportação é assinado com HMAC (chave derivada do `MCP_TOKEN`), expira em 1 hora e não contém o token.

## Estrutura

```
shared/            tipos, validação (zod), cálculos e lógica usados no front e nas Functions
netlify/functions/ api.mts (roteador /api/*) e mcp.mts (conector do Claude em /mcp)
netlify/lib/       store (dados), tools (casos de uso do MCP e das importações), mcp, auth, Strava, IA de foto
src/               app React (telas Hoje, Plano, Resumo, Exportar)
supabase/          migrações, seed e setup.sql (tudo junto)
tests/             testes das regras e de cada ferramenta MCP (vitest)
```

Observação: a exportação usa o pacote `xlsx` (SheetJS) 0.18.5 do npm, só para **gerar** planilhas; os alertas de segurança conhecidos dessa versão afetam a leitura de arquivos, que o app não faz.
