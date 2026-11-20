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
CREATE TABLE IF NOT EXISTS breadcrumb_profiles.limits (
  owner_id text PRIMARY KEY REFERENCES breadcrumb_auth."user"(id) ON DELETE CASCADE,
  window_started timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);`;
