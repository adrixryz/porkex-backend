-- UTC date of the last materialized or deliberately deleted occurrence.
ALTER TABLE "RecurringRule" ADD COLUMN "lastProcessedDate" DATETIME;

-- Existing history is evidence; do not infer deleted historical occurrences.
UPDATE "RecurringRule"
SET "lastProcessedDate" = (
    SELECT MAX("date")
    FROM "Transaction"
    WHERE "Transaction"."recurringId" = "RecurringRule"."id"
);
