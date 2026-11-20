// Auth and profiles must be migrated first. No capture contents enter this index.
export const leaderboardsSchema = `
CREATE SCHEMA IF NOT EXISTS breadcrumb_leaderboards;
CREATE TABLE IF NOT EXISTS breadcrumb_leaderboards.preferences (
  owner_id text PRIMARY KEY REFERENCES breadcrumb_auth."user"(id) ON DELETE CASCADE,
  participant text NOT NULL UNIQUE CHECK (participant ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  share_app_usage boolean NOT NULL DEFAULT false,
  total_seconds double precision NOT NULL DEFAULT 0 CHECK (total_seconds >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS breadcrumb_leaderboards.days (
  participant text NOT NULL REFERENCES breadcrumb_leaderboards.preferences(participant) ON DELETE CASCADE,
  day date NOT NULL,
  seconds double precision NOT NULL CHECK (seconds >= 0 AND seconds <= 86400),
  captures integer NOT NULL CHECK (captures >= 0),
  apps jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(apps) = 'array'),
  source_updated_at timestamptz NOT NULL,
  PRIMARY KEY (participant, day)
);
CREATE INDEX IF NOT EXISTS leaderboard_days_by_date ON breadcrumb_leaderboards.days (day, participant) INCLUDE (seconds);
CREATE OR REPLACE FUNCTION breadcrumb_leaderboards.update_totals() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $totals$
BEGIN
  UPDATE breadcrumb_leaderboards.preferences SET
    total_seconds=GREATEST(0,total_seconds+COALESCE(NEW.seconds,0)-COALESCE(OLD.seconds,0)),
    updated_at=now()
  WHERE participant=COALESCE(NEW.participant,OLD.participant);
  RETURN NULL;
END;
$totals$;
DROP TRIGGER IF EXISTS leaderboard_totals ON breadcrumb_leaderboards.days;
CREATE TRIGGER leaderboard_totals AFTER INSERT OR UPDATE OR DELETE ON breadcrumb_leaderboards.days
  FOR EACH ROW EXECUTE FUNCTION breadcrumb_leaderboards.update_totals();
`;
