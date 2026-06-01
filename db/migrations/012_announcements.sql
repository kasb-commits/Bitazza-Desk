CREATE TABLE IF NOT EXISTS announcements (
  id          TEXT PRIMARY KEY,
  title_en    TEXT NOT NULL,
  body_en     TEXT NOT NULL,
  title_th    TEXT NOT NULL,
  body_th     TEXT NOT NULL,
  active      BOOLEAN DEFAULT false,
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
