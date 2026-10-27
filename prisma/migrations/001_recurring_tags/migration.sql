CREATE TABLE "RecurringTag" (
    "ruleId" INTEGER NOT NULL,
    "tagId" TEXT NOT NULL,
    PRIMARY KEY ("ruleId", "tagId"),
    CONSTRAINT "RecurringTag_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecurringRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecurringTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RecurringTag_tagId_idx" ON "RecurringTag"("tagId");
