-- CreateTable
CREATE TABLE "OccurrenceOverride" (
    "ruleId" INTEGER NOT NULL,
    "date" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER,
    "comment" TEXT,
    "categoryId" INTEGER,
    "processedAt" DATETIME,

    PRIMARY KEY ("ruleId", "date"),
    CONSTRAINT "OccurrenceOverride_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OccurrenceOverride_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecurringRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OccurrenceTag" (
    "ruleId" INTEGER NOT NULL,
    "date" DATETIME NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("ruleId", "date", "tagId"),
    CONSTRAINT "OccurrenceTag_ruleId_date_fkey" FOREIGN KEY ("ruleId", "date") REFERENCES "OccurrenceOverride" ("ruleId", "date") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OccurrenceTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "OccurrenceOverride_categoryId_idx" ON "OccurrenceOverride"("categoryId");

-- CreateIndex
CREATE INDEX "OccurrenceTag_tagId_idx" ON "OccurrenceTag"("tagId");

