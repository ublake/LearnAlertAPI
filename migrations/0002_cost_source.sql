-- Records where a cost figure came from.
--
-- 'reported' is what the provider said it billed (CheaperInference returns
-- this per request). 'estimated' is our own arithmetic against the rate card
-- in config.js, used for providers that report nothing. NULL means neither
-- was available. The two deserve different trust, so the log keeps them apart.

ALTER TABLE call_log ADD COLUMN cost_source TEXT;
