# Publication sanitization

Historical handoff prose contained three credential-bearing URLs across two document versions. Published projections replace complete URLs with `<redacted-credential-url>`; original local files remain untouched. Archive index retains original SHA256 and separately binds included sanitized bytes. Public CI fixture source stays byte-exact in frozen before/after packets. No credentials, stores, environment inventories, raw plans/state, or unsafe raw logs are transferred. Pattern checks are triage, not a blanket security guarantee.
