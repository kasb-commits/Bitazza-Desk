-- Migration 010: Dynamic ticket property engine
-- Creates ticket_property_definitions + ticket_property_values tables
-- Adds admin.ticket_properties permission to roles
-- Seeds 11 default property definitions for Bitazza CS operations

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ticket_property_definitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  field_key     VARCHAR(100) NOT NULL UNIQUE,
  field_type    VARCHAR(20)  NOT NULL CHECK (field_type IN ('single_select','multi_select','text','number','boolean')),
  options       JSONB,                        -- [{value, label}] — for select types only
  applies_to    TEXT[],                       -- NULL = all categories; otherwise category slugs
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

-- Auto-update updated_at on definition changes
CREATE OR REPLACE FUNCTION set_property_definition_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_property_definition_updated_at ON ticket_property_definitions;
CREATE TRIGGER trg_property_definition_updated_at
  BEFORE UPDATE ON ticket_property_definitions
  FOR EACH ROW EXECUTE FUNCTION set_property_definition_updated_at();

-- ── Permissions ───────────────────────────────────────────────────────────────

INSERT INTO role_permissions (role_name, permission) VALUES
  ('super_admin', 'admin.ticket_properties'),
  ('admin',       'admin.ticket_properties')
ON CONFLICT DO NOTHING;

-- ── Seed default property definitions ────────────────────────────────────────
-- Category-specific sub-categories

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'KYC Sub-category',
  'kyc_sub_category',
  'single_select',
  '[
    {"value": "edd",                    "label": "EDD (Enhanced Due Diligence)"},
    {"value": "high_risk",              "label": "High Risk Classification"},
    {"value": "document_resubmission",  "label": "Document Re-submission"},
    {"value": "level_upgrade",          "label": "Level Upgrade (L1→L2→L3)"},
    {"value": "rejection_appeal",       "label": "Rejection Appeal"},
    {"value": "name_mismatch",          "label": "Name Mismatch"},
    {"value": "nationality_restriction","label": "Nationality Restriction"},
    {"value": "pep_sanctions",          "label": "PEP / Sanctions Hit"}
  ]',
  ARRAY['kyc_verification'],
  1
)
ON CONFLICT (field_key) DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Account Sub-category',
  'account_sub_category',
  'single_select',
  '[
    {"value": "aml_compliance_hold",        "label": "AML / Compliance Hold"},
    {"value": "suspicious_activity",        "label": "Suspicious Activity Flag"},
    {"value": "duplicate_account",          "label": "Duplicate Account Detected"},
    {"value": "suspended_policy_breach",    "label": "Account Suspended — Policy Breach"},
    {"value": "trading_restricted",         "label": "Trading Restricted"},
    {"value": "withdrawal_restricted",      "label": "Withdrawal Restricted"},
    {"value": "regulatory_investigation",   "label": "Regulatory Investigation Hold"}
  ]',
  ARRAY['account_restriction'],
  2
)
ON CONFLICT (field_key) DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Transaction Sub-category',
  'transaction_sub_category',
  'single_select',
  '[
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
  ]',
  ARRAY['withdrawal_issue'],
  3
)
ON CONFLICT (field_key) DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Fraud Sub-category',
  'fraud_sub_category',
  'single_select',
  '[
    {"value": "unauthorized_access",      "label": "Unauthorized Account Access"},
    {"value": "phishing_social_eng",      "label": "Phishing / Social Engineering"},
    {"value": "sim_swap",                 "label": "SIM Swap Attack"},
    {"value": "api_key_compromise",       "label": "API Key Compromise"},
    {"value": "account_takeover",         "label": "Account Takeover"},
    {"value": "suspicious_withdrawals",   "label": "Suspicious Withdrawal Activity"},
    {"value": "ransomware_extortion",     "label": "Ransomware / Extortion Report"}
  ]',
  ARRAY['fraud_security'],
  4
)
ON CONFLICT (field_key) DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Password / 2FA Sub-category',
  'password_sub_category',
  'single_select',
  '[
    {"value": "auth_device_lost",       "label": "Google Authenticator — Device Lost"},
    {"value": "auth_app_deleted",       "label": "Google Authenticator — App Deleted"},
    {"value": "phone_sim_lost",         "label": "Phone Number Changed / SIM Lost"},
    {"value": "email_access_lost",      "label": "Email Access Lost"},
    {"value": "account_locked",         "label": "Account Locked — Too Many Attempts"},
    {"value": "recovery_codes_missing", "label": "Recovery Codes Not Saved"}
  ]',
  ARRAY['password_2fa_reset'],
  5
)
ON CONFLICT (field_key) DO NOTHING;

-- Cross-category operational properties

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Current Group',
  'current_group',
  'single_select',
  '[
    {"value": "cs_team",          "label": "CS Team"},
    {"value": "tech_engineering", "label": "Tech / Engineering"},
    {"value": "treasury",         "label": "Treasury"},
    {"value": "compliance_aml",   "label": "Compliance / AML"},
    {"value": "risk_management",  "label": "Risk Management"},
    {"value": "finance_ops",      "label": "Finance Operations"},
    {"value": "product_team",     "label": "Product Team"},
    {"value": "legal",            "label": "Legal"},
    {"value": "external",         "label": "External / Third Party"}
  ]',
  NULL,
  10
)
ON CONFLICT (field_key) DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Investigation Status',
  'investigation_status',
  'single_select',
  '[
    {"value": "pending_customer_docs",    "label": "Pending Customer Documents"},
    {"value": "pending_internal_review",  "label": "Pending Internal Review"},
    {"value": "pending_group_response",   "label": "Pending Group Response"},
    {"value": "pending_third_party",      "label": "Pending Third-Party (bank/blockchain)"},
    {"value": "under_compliance_review",  "label": "Under Compliance Review"},
    {"value": "escalated_to_regulator",   "label": "Escalated to Regulator"},
    {"value": "resolved_pending_confirm", "label": "Resolved — Pending Confirmation"},
    {"value": "no_further_action",        "label": "No Further Action"}
  ]',
  NULL,
  11
)
ON CONFLICT (field_key) DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Contact Reason',
  'contact_reason',
  'single_select',
  '[
    {"value": "status_inquiry",       "label": "Status Inquiry"},
    {"value": "issue_resolution",     "label": "Issue Resolution"},
    {"value": "document_submission",  "label": "Document Submission"},
    {"value": "appeal_complaint",     "label": "Appeal / Complaint"},
    {"value": "general_question",     "label": "General Question"},
    {"value": "account_setup_help",   "label": "Account Setup Help"}
  ]',
  NULL,
  12
)
ON CONFLICT (field_key) DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Resolution Action',
  'resolution_action',
  'single_select',
  '[
    {"value": "guided_self_service",      "label": "Guided Self-Service"},
    {"value": "manual_override",          "label": "Manual Override by Agent"},
    {"value": "policy_exception",         "label": "Policy Exception Granted"},
    {"value": "escalated_no_resolution",  "label": "Escalated — No Resolution"},
    {"value": "auto_resolved",            "label": "Auto-Resolved by System"},
    {"value": "referred_to_regulator",    "label": "Referred to Regulator"}
  ]',
  NULL,
  13
)
ON CONFLICT (field_key) DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Related Transaction ID',
  'related_tx_id',
  'text',
  NULL,
  NULL,
  14
)
ON CONFLICT (field_key) DO NOTHING;

INSERT INTO ticket_property_definitions (name, field_key, field_type, options, applies_to, display_order)
VALUES (
  'Customer Risk Level',
  'customer_risk_level',
  'single_select',
  '[
    {"value": "standard",   "label": "Standard"},
    {"value": "watch_list", "label": "Watch List"},
    {"value": "high_risk",  "label": "High Risk"},
    {"value": "pep",        "label": "PEP (Politically Exposed)"},
    {"value": "sanctioned", "label": "Sanctioned"}
  ]',
  NULL,
  15
)
ON CONFLICT (field_key) DO NOTHING;
