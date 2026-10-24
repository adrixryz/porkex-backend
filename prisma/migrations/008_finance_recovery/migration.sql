CREATE TABLE "FinancialEdit" (
  "userId" INTEGER NOT NULL,
  "key" TEXT NOT NULL,
  "editedAt" DATETIME NOT NULL,
  "mutationId" TEXT NOT NULL,
  PRIMARY KEY ("userId", "key"),
  CONSTRAINT "FinancialEdit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "BalanceAdjustment" (
  "userId" INTEGER NOT NULL,
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "accountName" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "previousBalance" INTEGER NOT NULL,
  "balance" INTEGER NOT NULL,
  "effectiveDate" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL,
  PRIMARY KEY ("userId", "id"),
  CONSTRAINT "BalanceAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "BalanceAdjustment_userId_createdAt_id_idx" ON "BalanceAdjustment"("userId", "createdAt", "id");
CREATE INDEX "BalanceAdjustment_userId_accountId_createdAt_idx" ON "BalanceAdjustment"("userId", "accountId", "createdAt");
CREATE INDEX "BalanceAdjustment_userId_effectiveDate_idx" ON "BalanceAdjustment"("userId", "effectiveDate");
CREATE INDEX "Transfer_userId_createdAt_id_idx" ON "Transfer"("userId", "createdAt", "id");

-- Historical receipts recorded UTC instants without the device time zone.
-- Preserve their recorded UTC day; new adjustments store the explicit local day.
INSERT INTO "BalanceAdjustment" (
  "userId", "id", "accountId", "accountName", "kind", "previousBalance", "balance", "effectiveDate", "createdAt"
)
SELECT "userId", "key",
  json_extract("response", '$.balanceAdjustment.accountId'),
  json_extract("response", '$.balanceAdjustment.accountName'),
  COALESCE(json_extract("response", '$.balanceAdjustment.kind'), 'balance-adjustment'),
  CAST(ROUND(json_extract("response", '$.balanceAdjustment.previousBalance') * 100) AS INTEGER),
  CAST(ROUND(json_extract("response", '$.balanceAdjustment.balance') * 100) AS INTEGER),
  substr(json_extract("response", '$.balanceAdjustment.date'), 1, 10) || 'T00:00:00.000Z',
  json_extract("response", '$.balanceAdjustment.date')
FROM "FinancialReceipt"
WHERE ("key" LIKE 'account:create:%' OR "key" LIKE 'account:edit:%')
  AND json_type("response", '$.balanceAdjustment') = 'object';
