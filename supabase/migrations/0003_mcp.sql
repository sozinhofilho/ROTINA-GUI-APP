-- Conector MCP: pace médio nos treinos.
alter table public.workout_logs add column if not exists avg_pace text
  check (avg_pace is null or avg_pace ~ '^[0-9]{1,2}:[0-5][0-9]$');
