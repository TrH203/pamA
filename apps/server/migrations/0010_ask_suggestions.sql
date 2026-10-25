-- Suggested replies for the owner's inbox: the answer the model wrote before it was held back
-- (low confidence, guard) or one drafted later from all of the owner's notes. Never shown to visitors.
ALTER TABLE "asks" ADD COLUMN "draft_answer" text;
