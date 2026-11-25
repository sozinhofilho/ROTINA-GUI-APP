# Rotina · dieta e treino

App pessoal (PWA) para acompanhar dieta e treinos todo dia, pelo celular, sem login.

* **Front:** React + Vite + TypeScript, PWA instalável, funciona offline (fila local de registros).
* **Back:** uma Netlify Function (`netlify/functions/api.mts`) com rotas em `/api/*`.
* **Banco e fotos:** Supabase (Postgres + Storage, bucket privado `photos`).
* **Acesso:** link secreto `https://SEU-SITE.netlify.app/?k=TOKEN`. O token fica no `localStorage`, sai da URL e vai no header `x-app-token`. As Functions respondem 401 se não bater com `APP_TOKEN`. A chave service role do Supabase só existe nas Functions.

## Instalação (uma vez)

1. **Supabase** (plano gratuito): crie um projeto, abra *SQL Editor*, cole o conteúdo de `supabase/setup.sql` e rode. Isso cria as tabelas, a view `daily_summary`, o bucket privado `photos` e carrega o plano inicial (dieta 2.500 kcal + treino HYROX). Em *Project Settings → API* copie a **Project URL** e a chave **service_role**.
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

4. *Deploys → Trigger deploy*. Abra `https://SEU-SITE.netlify.app/?k=APP_TOKEN` no celular e use "Adicionar à tela de início".

Desenvolvimento: `npm install`, `npm run check` (lint, tipos, testes e build). Para rodar com as Functions localmente: `npx netlify dev` com um `.env`.

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

## Estrutura

```
shared/            tipos, validação (zod), cálculos e lógica usados no front e nas Functions
netlify/functions/ api.mts (roteador /api/*)
netlify/lib/       auth, Supabase, mutações, Strava, IA de foto
src/               app React (telas Hoje, Plano, Resumo, Exportar)
supabase/          migrações, seed e setup.sql (tudo junto)
tests/             testes das regras (vitest)
```

Observação: a exportação usa o pacote `xlsx` (SheetJS) 0.18.5 do npm, só para **gerar** planilhas; os alertas de segurança conhecidos dessa versão afetam a leitura de arquivos, que o app não faz.
