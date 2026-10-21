ALTER TABLE "Category" ADD COLUMN "clientId" TEXT;
ALTER TABLE "Budget" ADD COLUMN "clientId" TEXT;
CREATE UNIQUE INDEX "Category_userId_clientId_key" ON "Category"("userId", "clientId");
CREATE UNIQUE INDEX "Budget_userId_clientId_key" ON "Budget"("userId", "clientId");
