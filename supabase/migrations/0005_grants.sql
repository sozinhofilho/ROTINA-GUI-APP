-- Projetos novos do Supabase não liberam as tabelas criadas por SQL para a API.
-- O servidor do app (Netlify Functions) usa a chave secreta = papel service_role.
-- anon e authenticated continuam sem acesso (RLS ligado e sem grants).
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
