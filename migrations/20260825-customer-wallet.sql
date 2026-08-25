-- Closed-loop customer Trac Balance. Apply before deploying the wallet release.
CREATE TABLE IF NOT EXISTS wallet_accounts (
  "userId" uuid PRIMARY KEY,
  "balance" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("balance" >= 0),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_entries (
  "reference" varchar(160) PRIMARY KEY,
  "userId" uuid NOT NULL,
  "amount" numeric(14,2) NOT NULL CHECK ("amount" > 0),
  "direction" varchar(10) NOT NULL CHECK ("direction" IN ('credit', 'debit')),
  "kind" varchar(30) NOT NULL,
  "status" varchar(15) NOT NULL DEFAULT 'pending',
  "jobId" uuid NULL,
  "metadata" jsonb NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "completedAt" timestamptz NULL
);

CREATE INDEX IF NOT EXISTS "IDX_wallet_entries_user_created"
  ON wallet_entries ("userId", "createdAt" DESC);
