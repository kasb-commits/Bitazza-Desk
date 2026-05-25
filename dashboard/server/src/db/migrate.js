// Run once to set up schema: node src/db/migrate.js
const pool = require('./pg');

const SQL = `
-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users (agents/supervisors/admins)
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR UNIQUE NOT NULL,
  name          VARCHAR NOT NULL,
  password_hash VARCHAR NOT NULL,
  role          VARCHAR NOT NULL CHECK (role IN ('super_admin','supervisor','agent','kyc_agent','finance_agent')),
  team          VARCHAR NOT NULL DEFAULT 'cs',
  state         VARCHAR NOT NULL DEFAULT 'Offline' CHECK (state IN ('Available','Busy','Break','Offline')),
  active_chats  INT NOT NULL DEFAULT 0,
  max_chats     INT NOT NULL DEFAULT 3,
  skills        TEXT[] DEFAULT '{}',
  shift         VARCHAR,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Customers
CREATE TABLE IF NOT EXISTS customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bitazza_uid   VARCHAR UNIQUE,
  line_uid      VARCHAR UNIQUE,
  fb_psid       VARCHAR UNIQUE,
  email         VARCHAR,
  name          VARCHAR,
  tier          VARCHAR NOT NULL DEFAULT 'Standard' CHECK (tier IN ('VIP','EA','Standard')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          UUID REFERENCES customers(id),
  owner_id             UUID REFERENCES users(id),   -- NEVER changes on handoff
  assigned_to          UUID REFERENCES users(id),
  team                 VARCHAR NOT NULL DEFAULT 'cs',
  channel              VARCHAR NOT NULL CHECK (channel IN ('line','facebook','email','web')),
  status               VARCHAR NOT NULL DEFAULT 'Open_Live'
                         CHECK (status IN ('Open_Live','In_Progress','Pending_Customer',
                                           'Closed_Resolved','Closed_Unresponsive',
                                           'Orphaned','Escalated')),
  priority             INT NOT NULL DEFAULT 3 CHECK (priority IN (1,2,3)),
  category             VARCHAR,
  tags                 TEXT[] DEFAULT '{}',
  sla_deadline         TIMESTAMPTZ,
  sla_breached         BOOLEAN NOT NULL DEFAULT false,
  last_customer_msg_at TIMESTAMPTZ,
  nudge_sent_at        TIMESTAMPTZ,
  csat_score           INT CHECK (csat_score BETWEEN 1 AND 5),
  ai_persona           JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_customer_updated ON tickets (customer_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_pending ON tickets (status, last_customer_msg_at)
  WHERE status = 'Pending_Customer';
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status, assigned_to);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_type VARCHAR NOT NULL CHECK (sender_type IN ('customer','agent','bot','system','internal_note','whisper')),
  sender_id   UUID,
  content     TEXT NOT NULL,
  channel     VARCHAR,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_ticket_created ON messages (ticket_id, created_at ASC);

-- Canned responses
CREATE TABLE IF NOT EXISTS canned_responses (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shortcut  VARCHAR NOT NULL,
  title     VARCHAR NOT NULL,
  body      TEXT NOT NULL,
  scope     VARCHAR NOT NULL DEFAULT 'shared' CHECK (scope IN ('shared','personal')),
  owner_id  UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tags
CREATE TABLE IF NOT EXISTS tags (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name  VARCHAR UNIQUE NOT NULL,
  color VARCHAR DEFAULT '#000000'
);

-- AI Studio flows
CREATE TABLE IF NOT EXISTS ai_studio_flows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR NOT NULL,
  flow_json     JSONB NOT NULL DEFAULT '{}',
  published     BOOLEAN NOT NULL DEFAULT false,
  published_at  TIMESTAMPTZ,
  published_by  UUID REFERENCES users(id),
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES users(id),
  action      VARCHAR NOT NULL,
  target_type VARCHAR,
  target_id   UUID,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Roles table (dynamic roles) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  name       VARCHAR PRIMARY KEY,
  is_preset  BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed preset roles
INSERT INTO roles (name, is_preset) VALUES
  ('agent',          true),
  ('kyc_agent',      true),
  ('finance_agent',  true),
  ('supervisor',     true),
  ('admin',          true),
  ('super_admin',    true)
ON CONFLICT (name) DO NOTHING;

-- ── Role permissions table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
  role_name  VARCHAR NOT NULL REFERENCES roles(name) ON DELETE CASCADE ON UPDATE CASCADE,
  permission VARCHAR NOT NULL,
  PRIMARY KEY (role_name, permission)
);

-- Seed preset role permissions (mirrors hardcoded NAV + action rules)
INSERT INTO role_permissions (role_name, permission) VALUES
  -- agent
  ('agent', 'section.home'),
  ('agent', 'section.inbox'),
  ('agent', 'inbox.reply'),
  ('agent', 'inbox.close'),
  ('agent', 'inbox.escalate'),
  ('agent', 'inbox.internal_note'),
  ('agent', 'inbox.claim'),
  -- kyc_agent
  ('kyc_agent', 'section.home'),
  ('kyc_agent', 'section.inbox'),
  ('kyc_agent', 'inbox.reply'),
  ('kyc_agent', 'inbox.close'),
  ('kyc_agent', 'inbox.escalate'),
  ('kyc_agent', 'inbox.internal_note'),
  ('kyc_agent', 'inbox.claim'),
  -- finance_agent
  ('finance_agent', 'section.home'),
  ('finance_agent', 'section.inbox'),
  ('finance_agent', 'inbox.reply'),
  ('finance_agent', 'inbox.close'),
  ('finance_agent', 'inbox.escalate'),
  ('finance_agent', 'inbox.internal_note'),
  ('finance_agent', 'inbox.claim'),
  -- supervisor
  ('supervisor', 'section.home'),
  ('supervisor', 'section.inbox'),
  ('supervisor', 'section.supervisor'),
  ('supervisor', 'section.analytics'),
  ('supervisor', 'section.metrics'),
  ('supervisor', 'section.studio'),
  ('supervisor', 'inbox.reply'),
  ('supervisor', 'inbox.assign'),
  ('supervisor', 'inbox.close'),
  ('supervisor', 'inbox.escalate'),
  ('supervisor', 'inbox.internal_note'),
  ('supervisor', 'inbox.claim'),
  ('supervisor', 'supervisor.whisper'),
  ('supervisor', 'studio.publish'),
  -- admin
  ('admin', 'section.home'),
  ('admin', 'section.inbox'),
  ('admin', 'section.supervisor'),
  ('admin', 'section.analytics'),
  ('admin', 'section.knowledge'),
  ('admin', 'section.admin'),
  ('admin', 'inbox.reply'),
  ('admin', 'inbox.assign'),
  ('admin', 'inbox.close'),
  ('admin', 'inbox.escalate'),
  ('admin', 'inbox.internal_note'),
  ('admin', 'inbox.claim'),
  ('admin', 'admin.agents'),
  ('admin', 'admin.roles'),
  ('admin', 'admin.settings'),
  -- super_admin (all)
  ('super_admin', 'section.home'),
  ('super_admin', 'section.inbox'),
  ('super_admin', 'section.supervisor'),
  ('super_admin', 'section.analytics'),
  ('super_admin', 'section.metrics'),
  ('super_admin', 'section.studio'),
  ('super_admin', 'section.knowledge'),
  ('super_admin', 'section.users'),
  ('super_admin', 'section.admin'),
  ('super_admin', 'inbox.reply'),
  ('super_admin', 'inbox.assign'),
  ('super_admin', 'inbox.close'),
  ('super_admin', 'inbox.escalate'),
  ('super_admin', 'inbox.internal_note'),
  ('super_admin', 'inbox.claim'),
  ('super_admin', 'supervisor.whisper'),
  ('super_admin', 'studio.publish'),
  ('super_admin', 'admin.agents'),
  ('super_admin', 'admin.roles'),
  ('super_admin', 'admin.settings')
ON CONFLICT DO NOTHING;

-- Backfill section.knowledge, section.users, and user360.* permissions
INSERT INTO role_permissions (role_name, permission) VALUES
  ('admin',         'section.knowledge'),
  ('super_admin',   'section.knowledge'),
  -- section.users: who can access User360 page
  ('agent',         'section.users'),
  ('kyc_agent',     'section.users'),
  ('finance_agent', 'section.users'),
  ('supervisor',    'section.users'),
  ('admin',         'section.users'),
  ('super_admin',   'section.users'),
  -- user360.identity: basic name/email/phone/tier/KYC status
  ('agent',         'user360.identity'),
  ('kyc_agent',     'user360.identity'),
  ('finance_agent', 'user360.identity'),
  ('supervisor',    'user360.identity'),
  ('admin',         'user360.identity'),
  ('super_admin',   'user360.identity'),
  -- user360.kyc: full KYC detail (rejection reason, reviewed date)
  ('kyc_agent',     'user360.kyc'),
  ('supervisor',    'user360.kyc'),
  ('admin',         'user360.kyc'),
  ('super_admin',   'user360.kyc'),
  -- user360.restrictions: restriction type, reason, lift date
  ('agent',         'user360.restrictions'),
  ('kyc_agent',     'user360.restrictions'),
  ('finance_agent', 'user360.restrictions'),
  ('supervisor',    'user360.restrictions'),
  ('admin',         'user360.restrictions'),
  ('super_admin',   'user360.restrictions'),
  -- user360.financials: balances, transactions, spot & futures trades
  ('finance_agent', 'user360.financials'),
  ('supervisor',    'user360.financials'),
  ('admin',         'user360.financials'),
  ('super_admin',   'user360.financials'),
  -- user360.tickets: CS ticket history
  ('agent',         'user360.tickets'),
  ('kyc_agent',     'user360.tickets'),
  ('finance_agent', 'user360.tickets'),
  ('supervisor',    'user360.tickets'),
  ('admin',         'user360.tickets'),
  ('super_admin',   'user360.tickets')
ON CONFLICT DO NOTHING;

-- Backfill missing inbox action permissions (inbox.assign, inbox.set_priority, inbox.set_tags,
-- supervisor.reassign, studio.*, admin.tags, admin.canned_responses, etc.)
INSERT INTO role_permissions (role_name, permission) VALUES
  -- inbox.assign — agents can claim/assign conversations
  ('agent',         'inbox.assign'),
  ('kyc_agent',     'inbox.assign'),
  ('finance_agent', 'inbox.assign'),
  -- inbox.set_priority — all front-line staff can set ticket priority
  ('agent',         'inbox.set_priority'),
  ('kyc_agent',     'inbox.set_priority'),
  ('finance_agent', 'inbox.set_priority'),
  ('supervisor',    'inbox.set_priority'),
  ('admin',         'inbox.set_priority'),
  ('super_admin',   'inbox.set_priority'),
  -- inbox.set_tags — all front-line staff can add/remove tags on tickets
  ('agent',         'inbox.set_tags'),
  ('kyc_agent',     'inbox.set_tags'),
  ('finance_agent', 'inbox.set_tags'),
  ('supervisor',    'inbox.set_tags'),
  ('admin',         'inbox.set_tags'),
  ('super_admin',   'inbox.set_tags'),
  -- supervisor.reassign — supervisors and admins can reassign tickets
  ('supervisor',    'supervisor.reassign'),
  ('admin',         'supervisor.reassign'),
  ('super_admin',   'supervisor.reassign'),
  -- studio permissions — supervisors/admins manage AI Studio flows
  ('supervisor',    'studio.create'),
  ('supervisor',    'studio.edit'),
  ('supervisor',    'studio.delete'),
  ('supervisor',    'studio.test'),
  ('admin',         'studio.create'),
  ('admin',         'studio.edit'),
  ('admin',         'studio.delete'),
  ('admin',         'studio.test'),
  ('super_admin',   'studio.create'),
  ('super_admin',   'studio.edit'),
  ('super_admin',   'studio.delete'),
  ('super_admin',   'studio.test'),
  -- admin.* — full admin panel permissions
  ('admin',         'admin.tags'),
  ('admin',         'admin.canned_responses'),
  ('admin',         'admin.assignment_rules'),
  ('admin',         'admin.sla_targets'),
  ('admin',         'admin.bot_config'),
  ('admin',         'admin.report_settings'),
  ('super_admin',   'admin.tags'),
  ('super_admin',   'admin.canned_responses'),
  ('super_admin',   'admin.assignment_rules'),
  ('super_admin',   'admin.sla_targets'),
  ('super_admin',   'admin.bot_config'),
  ('super_admin',   'admin.report_settings'),
  -- knowledge.read/write — agents can read, admins can write
  ('agent',         'knowledge.read'),
  ('kyc_agent',     'knowledge.read'),
  ('finance_agent', 'knowledge.read'),
  ('supervisor',    'knowledge.read'),
  ('admin',         'knowledge.read'),
  ('admin',         'knowledge.write'),
  ('super_admin',   'knowledge.read'),
  ('super_admin',   'knowledge.write'),
  -- section.metrics
  ('admin',         'section.metrics'),
  ('super_admin',   'section.metrics'),
  -- section.studio for admin
  ('admin',         'section.studio')
ON CONFLICT DO NOTHING;

-- roles.display_name — optional human-readable label for custom roles
DO $$ BEGIN
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS display_name VARCHAR;
EXCEPTION WHEN others THEN NULL;
END $$;

-- Idempotent column backfills (safe to re-run)
DO $$ BEGIN
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_persona JSONB;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_customer_msg_at TIMESTAMPTZ;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS nudge_sent_at TIMESTAMPTZ;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS csat_score INT;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel VARCHAR;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
EXCEPTION WHEN others THEN NULL;
END $$;

-- users.active — soft-delete flag
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
EXCEPTION WHEN others THEN NULL;
END $$;

-- users.avatar_url
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR;
EXCEPTION WHEN others THEN NULL;
END $$;

-- users.role: drop old CHECK constraint, add FK to roles table
-- Step 1: ensure all existing role values exist in roles (already seeded above)
-- Step 2: drop old constraint (named or unnamed — use DO block to be safe)
DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
EXCEPTION WHEN others THEN NULL;
END $$;

-- Step 3: add FK constraint (idempotent via DO block)
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_fk
    FOREIGN KEY (role) REFERENCES roles(name);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- customers: phone, kyc_status, external_id (widget user_id for fast lookups)
DO $$ BEGIN
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone VARCHAR;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS kyc_status VARCHAR;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS external_id VARCHAR UNIQUE;
EXCEPTION WHEN others THEN NULL;
END $$;

-- customers.tier: expand CHECK constraint to include new tiers from mock API
DO $$ BEGIN
  ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_tier_check;
EXCEPTION WHEN others THEN NULL;
END $$;

-- customers.kyc_tier: 0=unverified, 1=basic, 2=enhanced, 3=full/professional
DO $$ BEGIN
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS kyc_tier INT DEFAULT 0;
EXCEPTION WHEN others THEN NULL;
END $$;

-- ── Assignment Rules ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assignment_rules (
  key        VARCHAR PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id)
);

-- Seed defaults (mirrors current hardcoded logic — idempotent)
INSERT INTO assignment_rules (key, value) VALUES
  ('category_team_map', '{
    "kyc_verification":    "kyc",
    "withdrawal_issue":    "withdrawals",
    "account_restriction": "cs",
    "password_2fa_reset":  "cs",
    "fraud_security":      "cs"
  }'),
  ('sticky_agent_hours',  '12'),
  ('vip_auto_priority1',  'true'),
  ('sla_minutes',         '{"1": 1, "2": 3, "3": 10}')
ON CONFLICT (key) DO NOTHING;

-- Seed a default super_admin (password: admin123)
INSERT INTO users (email, name, password_hash, role, team, state)
VALUES (
  'admin@bitazza.com',
  'Admin',
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lihC',
  'super_admin',
  'cs',
  'Available'
) ON CONFLICT (email) DO NOTHING;

-- Seed specialist agents for team-based routing tests
-- All passwords: agent123
INSERT INTO users (email, name, password_hash, role, team, max_chats, state) VALUES
  -- KYC team
  ('mint@bitazza.com',   'Mint',  '$2a$10$mBiadgYwPZWH8cJE7KYkYOlKCMxRYfzBZpd.zAcUMDvxKZ7dt8SBK', 'kyc_agent',     'kyc',        3, 'Available'),
  -- Withdrawals / finance team
  ('arm@bitazza.com',    'Arm',   '$2a$10$mBiadgYwPZWH8cJE7KYkYOlKCMxRYfzBZpd.zAcUMDvxKZ7dt8SBK', 'finance_agent', 'withdrawals', 3, 'Available'),
  -- General CS team (handles account_restriction, password/2FA, other)
  ('james@bitazza.com',  'James', '$2a$10$mBiadgYwPZWH8cJE7KYkYOlKCMxRYfzBZpd.zAcUMDvxKZ7dt8SBK', 'agent',         'cs',          3, 'Available'),
  ('ploy@bitazza.com',   'Ploy',  '$2a$10$mBiadgYwPZWH8cJE7KYkYOlKCMxRYfzBZpd.zAcUMDvxKZ7dt8SBK', 'agent',         'cs',          3, 'Available'),
  ('nook@bitazza.com',   'Nook',  '$2a$10$mBiadgYwPZWH8cJE7KYkYOlKCMxRYfzBZpd.zAcUMDvxKZ7dt8SBK', 'agent',         'cs',          3, 'Available')
ON CONFLICT (email) DO NOTHING;

-- AI draft log — tracks every draft generated by the copilot for auditing
CREATE TABLE IF NOT EXISTS ai_drafts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  agent_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  instruction   TEXT NOT NULL DEFAULT '',
  partial_draft TEXT NOT NULL DEFAULT '',
  generated     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_drafts_ticket_idx ON ai_drafts(ticket_id);

-- Notification channel configs for scheduled daily/weekly reports
CREATE TABLE IF NOT EXISTS notification_channel_configs (
  channel     VARCHAR PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  config      JSONB    NOT NULL DEFAULT '{}',
  reports     JSONB    NOT NULL DEFAULT '{"daily": true, "weekly": true}',
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration 009: rename category value 'ai_handling' → 'unclassified'
UPDATE tickets SET category = 'unclassified' WHERE category = 'ai_handling';

-- Migration 009b: notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL,
  type        TEXT NOT NULL,
  priority    TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  ticket_id   TEXT,
  read        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_read_created
  ON notifications(user_id, read, created_at DESC);

-- Migration 010: Dynamic ticket property engine
CREATE TABLE IF NOT EXISTS ticket_property_definitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  field_key     VARCHAR(100) NOT NULL UNIQUE,
  field_type    VARCHAR(20)  NOT NULL CHECK (field_type IN ('single_select','multi_select','text','number','boolean')),
  options       JSONB,
  applies_to    TEXT[],
  is_required   BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  display_order INT     NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_property_values (
  ticket_id    UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  property_id  UUID NOT NULL REFERENCES ticket_property_definitions(id) ON DELETE CASCADE,
  value_text   TEXT,
  value_array  TEXT[],
  value_number NUMERIC,
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_property_values_ticket ON ticket_property_values (ticket_id);

CREATE OR REPLACE FUNCTION set_property_definition_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_property_definition_updated_at ON ticket_property_definitions;
CREATE TRIGGER trg_property_definition_updated_at
  BEFORE UPDATE ON ticket_property_definitions
  FOR EACH ROW EXECUTE FUNCTION set_property_definition_updated_at();

INSERT INTO role_permissions (role_name, permission) VALUES
  ('super_admin', 'admin.ticket_properties'),
  ('admin',       'admin.ticket_properties')
ON CONFLICT DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order) VALUES
  ('KYC Sub-category', 'kyc_sub_category', 'single_select', '[
    {"value": "edd",                    "label": "EDD (Enhanced Due Diligence)"},
    {"value": "high_risk",              "label": "High Risk Classification"},
    {"value": "document_resubmission",  "label": "Document Re-submission"},
    {"value": "level_upgrade",          "label": "Level Upgrade (L1→L2→L3)"},
    {"value": "rejection_appeal",       "label": "Rejection Appeal"},
    {"value": "name_mismatch",          "label": "Name Mismatch"},
    {"value": "nationality_restriction","label": "Nationality Restriction"},
    {"value": "pep_sanctions",          "label": "PEP / Sanctions Hit"}
  ]', ARRAY['kyc_verification'], 1),
  ('Account Sub-category', 'account_sub_category', 'single_select', '[
    {"value": "aml_compliance_hold",        "label": "AML / Compliance Hold"},
    {"value": "suspicious_activity",        "label": "Suspicious Activity Flag"},
    {"value": "duplicate_account",          "label": "Duplicate Account Detected"},
    {"value": "suspended_policy_breach",    "label": "Account Suspended — Policy Breach"},
    {"value": "trading_restricted",         "label": "Trading Restricted"},
    {"value": "withdrawal_restricted",      "label": "Withdrawal Restricted"},
    {"value": "regulatory_investigation",   "label": "Regulatory Investigation Hold"}
  ]', ARRAY['account_restriction'], 2),
  ('Transaction Sub-category', 'transaction_sub_category', 'single_select', '[
    {"value": "crypto_deposit_missing",       "label": "Crypto Deposit — Missing"},
    {"value": "crypto_deposit_wrong_network", "label": "Crypto Deposit — Wrong Network"},
    {"value": "crypto_withdrawal_stuck",      "label": "Crypto Withdrawal — Stuck / Pending"},
    {"value": "crypto_withdrawal_wrong_addr", "label": "Crypto Withdrawal — Wrong Address"},
    {"value": "fiat_deposit_bank",            "label": "Fiat Deposit — Bank Transfer"},
    {"value": "fiat_deposit_promptpay",       "label": "Fiat Deposit — PromptPay"},
    {"value": "fiat_withdrawal_delay",        "label": "Fiat Withdrawal — Processing Delay"},
    {"value": "fiat_withdrawal_bank_reject",  "label": "Fiat Withdrawal — Bank Rejection"},
    {"value": "internal_transfer",            "label": "Internal Transfer Issue"},
    {"value": "transaction_dispute",          "label": "Transaction Dispute"}
  ]', ARRAY['withdrawal_issue'], 3),
  ('Fraud Sub-category', 'fraud_sub_category', 'single_select', '[
    {"value": "unauthorized_access",      "label": "Unauthorized Account Access"},
    {"value": "phishing_social_eng",      "label": "Phishing / Social Engineering"},
    {"value": "sim_swap",                 "label": "SIM Swap Attack"},
    {"value": "api_key_compromise",       "label": "API Key Compromise"},
    {"value": "account_takeover",         "label": "Account Takeover"},
    {"value": "suspicious_withdrawals",   "label": "Suspicious Withdrawal Activity"},
    {"value": "ransomware_extortion",     "label": "Ransomware / Extortion Report"}
  ]', ARRAY['fraud_security'], 4),
  ('Password / 2FA Sub-category', 'password_sub_category', 'single_select', '[
    {"value": "auth_device_lost",       "label": "Google Authenticator — Device Lost"},
    {"value": "auth_app_deleted",       "label": "Google Authenticator — App Deleted"},
    {"value": "phone_sim_lost",         "label": "Phone Number Changed / SIM Lost"},
    {"value": "email_access_lost",      "label": "Email Access Lost"},
    {"value": "account_locked",         "label": "Account Locked — Too Many Attempts"},
    {"value": "recovery_codes_missing", "label": "Recovery Codes Not Saved"}
  ]', ARRAY['password_2fa_reset'], 5),
  ('Current Group', 'current_group', 'single_select', '[
    {"value": "cs_team",          "label": "CS Team"},
    {"value": "tech_engineering", "label": "Tech / Engineering"},
    {"value": "treasury",         "label": "Treasury"},
    {"value": "compliance_aml",   "label": "Compliance / AML"},
    {"value": "risk_management",  "label": "Risk Management"},
    {"value": "finance_ops",      "label": "Finance Operations"},
    {"value": "product_team",     "label": "Product Team"},
    {"value": "legal",            "label": "Legal"},
    {"value": "external",         "label": "External / Third Party"}
  ]', NULL, 10),
  ('Investigation Status', 'investigation_status', 'single_select', '[
    {"value": "pending_customer_docs",    "label": "Pending Customer Documents"},
    {"value": "pending_internal_review",  "label": "Pending Internal Review"},
    {"value": "pending_group_response",   "label": "Pending Group Response"},
    {"value": "pending_third_party",      "label": "Pending Third-Party (bank/blockchain)"},
    {"value": "under_compliance_review",  "label": "Under Compliance Review"},
    {"value": "escalated_to_regulator",   "label": "Escalated to Regulator"},
    {"value": "resolved_pending_confirm", "label": "Resolved — Pending Confirmation"},
    {"value": "no_further_action",        "label": "No Further Action"}
  ]', NULL, 11),
  ('Contact Reason', 'contact_reason', 'single_select', '[
    {"value": "status_inquiry",       "label": "Status Inquiry"},
    {"value": "issue_resolution",     "label": "Issue Resolution"},
    {"value": "document_submission",  "label": "Document Submission"},
    {"value": "appeal_complaint",     "label": "Appeal / Complaint"},
    {"value": "general_question",     "label": "General Question"},
    {"value": "account_setup_help",   "label": "Account Setup Help"}
  ]', NULL, 12),
  ('Resolution Action', 'resolution_action', 'single_select', '[
    {"value": "guided_self_service",      "label": "Guided Self-Service"},
    {"value": "manual_override",          "label": "Manual Override by Agent"},
    {"value": "policy_exception",         "label": "Policy Exception Granted"},
    {"value": "escalated_no_resolution",  "label": "Escalated — No Resolution"},
    {"value": "auto_resolved",            "label": "Auto-Resolved by System"},
    {"value": "referred_to_regulator",    "label": "Referred to Regulator"}
  ]', NULL, 13),
  ('Related Transaction ID', 'related_tx_id', 'text', NULL, NULL, 14),
  ('Customer Risk Level', 'customer_risk_level', 'single_select', '[
    {"value": "standard",   "label": "Standard"},
    {"value": "watch_list", "label": "Watch List"},
    {"value": "high_risk",  "label": "High Risk"},
    {"value": "pep",        "label": "PEP (Politically Exposed)"},
    {"value": "sanctioned", "label": "Sanctioned"}
  ]', NULL, 15)
ON CONFLICT (field_key) DO NOTHING;
`;

(async () => {
  const client = await pool.connect();
  try {
    console.log('[migrate] Running migrations…');
    await client.query(SQL);
    console.log('[migrate] Done.');
  } catch (err) {
    console.error('[migrate] Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
