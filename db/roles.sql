-- One-time role setup. Run as a database admin (psql, or your provider's SQL console).
-- Set each password afterwards with \password <role> or the provider's console; never commit them.
--
--   truss_migrator  owns the safety schema and runs migrations on deploy. Holds the only right to
--                   change the fixed limits, and only by shipping a new migration file (a code change).
--   truss_app       the booking worker. Can call safety.app_* functions and nothing else.
--   truss_owner     Matt's owner CLI. Can call safety.owner_* functions and read the owner views.
--
-- No role is a member of another, so none can SET ROLE into a more privileged one.

CREATE ROLE truss_migrator LOGIN;
CREATE ROLE truss_app      LOGIN;
CREATE ROLE truss_owner    LOGIN;

-- Lets the migrator create the safety schema. Replace truss with your database name if different.
GRANT CREATE ON DATABASE truss TO truss_migrator;

-- Session limits. A worker transaction left open (a bug, a hung process) would hold the global lock and
-- delay everything, including the owner's "disable"; these end it. The worker never needs more.
ALTER ROLE truss_app   SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE truss_app   SET statement_timeout = '30s';
ALTER ROLE truss_app   SET lock_timeout = '15s';
ALTER ROLE truss_owner SET idle_in_transaction_session_timeout = '60s';
-- An owner command that waits behind a worker's lock fails after 20 s instead of hanging. (The disable
-- never waits: no worker function touches the kill switch.)
ALTER ROLE truss_owner SET lock_timeout = '20s';
