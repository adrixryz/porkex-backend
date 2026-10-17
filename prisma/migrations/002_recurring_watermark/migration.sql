-- UTC date of the last materialized or deliberately deleted occurrence.
ALTER TABLE "RecurringRule" ADD COLUMN "lastProcessedDate" DATETIME;

-- Existing history is evidence; do not infer deleted historical occurrences.
UPDATE "RecurringRule"
SET "lastProcessedDate" = (
    SELECT "date"
    FROM "Transaction"
    WHERE "Transaction"."recurringId" = "RecurringRule"."id"
    -- Prisma/libSQL installations may contain both INTEGER epoch milliseconds
    -- and ISO TEXT dates. MAX(date) compares storage classes, not chronology.
    ORDER BY CASE typeof("date")
        WHEN 'integer' THEN "date"
        WHEN 'real' THEN "date"
        ELSE unixepoch("date") * 1000
    END DESC
    LIMIT 1
);
