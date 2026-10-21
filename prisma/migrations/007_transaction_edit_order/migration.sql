ALTER TABLE "Transaction" ADD COLUMN "editedAt" DATETIME;
ALTER TABLE "Transaction" ADD COLUMN "lastEditId" TEXT;
UPDATE "Transaction" SET "editedAt" = "createdAt";
