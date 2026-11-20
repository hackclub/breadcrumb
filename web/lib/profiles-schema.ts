// Auth must be migrated first. Profile ownership follows Better Auth's stable user ID.
export const profilesSchema = `
CREATE SCHEMA IF NOT EXISTS breadcrumb_profiles;
CREATE TABLE IF NOT EXISTS breadcrumb_profiles.profiles (
  owner_id text PRIMARY KEY REFERENCES breadcrumb_auth."user"(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9_]{2,23}$'),
  display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 60),
  bio text NOT NULL DEFAULT '' CHECK (length(bio) <= 280),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  share_apps boolean NOT NULL DEFAULT false,
  apps text[] NOT NULL DEFAULT '{}' CHECK (cardinality(apps) <= 30),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE breadcrumb_profiles.profiles ADD COLUMN IF NOT EXISTS github_url text NOT NULL DEFAULT '';
ALTER TABLE breadcrumb_profiles.profiles ADD COLUMN IF NOT EXISTS website_url text NOT NULL DEFAULT '';
ALTER TABLE breadcrumb_profiles.profiles ADD COLUMN IF NOT EXISTS avatar_mode text NOT NULL DEFAULT 'none' CHECK (avatar_mode IN ('none','gravatar','upload'));
ALTER TABLE breadcrumb_profiles.profiles ADD COLUMN IF NOT EXISTS avatar_key text;
ALTER TABLE breadcrumb_profiles.profiles ADD COLUMN IF NOT EXISTS avatar_hash text;
CREATE TABLE IF NOT EXISTS breadcrumb_profiles.avatar_garbage (
  key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION breadcrumb_profiles.queue_avatar_garbage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $avatar_gc$
BEGIN
  IF OLD.avatar_key IS NOT NULL AND (TG_OP='DELETE' OR OLD.avatar_key IS DISTINCT FROM NEW.avatar_key) THEN
    INSERT INTO breadcrumb_profiles.avatar_garbage (key) VALUES (OLD.avatar_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$avatar_gc$;
DROP TRIGGER IF EXISTS avatar_cleanup ON breadcrumb_profiles.profiles;
CREATE TRIGGER avatar_cleanup AFTER UPDATE OF avatar_key OR DELETE ON breadcrumb_profiles.profiles
  FOR EACH ROW EXECUTE FUNCTION breadcrumb_profiles.queue_avatar_garbage();
CREATE TABLE IF NOT EXISTS breadcrumb_profiles.limits (
  owner_id text PRIMARY KEY REFERENCES breadcrumb_auth."user"(id) ON DELETE CASCADE,
  window_started timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);`;
