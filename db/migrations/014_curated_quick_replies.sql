-- Migration 014: curated_quick_replies table
-- Stores admin-editable pill library, keyed by category + language.
-- Seeded from the hardcoded defaults in engine/quick_reply_defaults.py.

CREATE TABLE IF NOT EXISTS curated_quick_replies (
    category   TEXT        NOT NULL,
    language   TEXT        NOT NULL,
    pills      JSONB       NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (category, language)
);

-- Seed with existing hardcoded defaults
INSERT INTO curated_quick_replies (category, language, pills) VALUES
  ('kyc_verification',   'en', '["What documents do I need?","My document was rejected","Stuck on ''Under review''","How long does approval take?"]'),
  ('kyc_verification',   'th', '["ต้องใช้เอกสารอะไรบ้าง","เอกสารของฉันถูกปฏิเสธ","ติดอยู่ที่ ''กำลังตรวจสอบ''","อนุมัติใช้เวลานานแค่ไหน"]'),
  ('account_restriction','en', '["Why is my account restricted?","How do I unlock it?","I already submitted documents","What''s the expected timeline?"]'),
  ('account_restriction','th', '["ทำไมบัญชีถูกระงับ","ปลดล็อกได้อย่างไร","ส่งเอกสารไปแล้ว","คาดว่าจะใช้เวลานานแค่ไหน"]'),
  ('withdrawal_issue',   'en', '["My withdrawal is still pending","Funds didn''t arrive in my bank","I have the transaction ID","How long do withdrawals take?"]'),
  ('withdrawal_issue',   'th', '["การถอนยังค้างอยู่","เงินยังไม่ถึงบัญชีธนาคาร","มี transaction ID แล้ว","การถอนใช้เวลานานแค่ไหน"]'),
  ('deposit_issue',      'en', '["My deposit hasn''t arrived","I have the transaction hash","How long do deposits take?","Is there a minimum deposit?"]'),
  ('deposit_issue',      'th', '["เงินฝากยังไม่เข้า","มี transaction hash แล้ว","การฝากใช้เวลานานแค่ไหน","มีขั้นต่ำการฝากไหม"]'),
  ('password_2fa_reset', 'en', '["I forgot my password","I lost my 2FA device","I can''t receive the OTP","I''m still locked out"]'),
  ('password_2fa_reset', 'th', '["ลืมรหัสผ่าน","ไม่มีอุปกรณ์ 2FA แล้ว","ไม่ได้รับ OTP","ยังเข้าบัญชีไม่ได้"]'),
  ('fraud_security',     'en', '["I didn''t make this transaction","My account may be compromised","I received a suspicious message","How do I secure my account?"]'),
  ('fraud_security',     'th', '["ฉันไม่ได้ทำธุรกรรมนี้","บัญชีอาจถูกเข้าถึงโดยไม่ได้รับอนุญาต","ได้รับข้อความน่าสงสัย","จะรักษาความปลอดภัยบัญชีได้อย่างไร"]'),
  ('other',              'en', '["I have a follow-up question","Can you explain that further?","I''m still having the issue"]'),
  ('other',              'th', '["มีคำถามเพิ่มเติม","ช่วยอธิบายเพิ่มเติมได้ไหม","ยังมีปัญหาอยู่"]')
ON CONFLICT (category, language) DO NOTHING;
