-- Verbatim from supabase/supabase docker/volumes/db/jwt.sql (master, fetched 2026-11-15)
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
