-- Runs once, when the Postgres volume is first created.
-- One server, two databases: Keycloak's own, and the orchestrator's (sessions + audit log).
-- Change these passwords for anything beyond local development (and in docker-compose.yml / .env).
CREATE USER keycloak WITH PASSWORD 'keycloak';
CREATE DATABASE keycloak OWNER keycloak;
CREATE USER orchestrator WITH PASSWORD 'orchestrator';
CREATE DATABASE orchestrator OWNER orchestrator;
