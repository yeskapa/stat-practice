# Security and privacy

Run on `127.0.0.1` for one local user. The app has no authentication or user isolation. Anyone who can access the server can access or change local attempts. Public hosting is outside the supported deployment model.

Answers, timings, and notes are stored in `data/` and browser storage. Browser storage is scoped to a stable database identity to keep separate installations' pending answers apart; it does not provide access control. There is no cloud account or built-in analytics service. External links may open third-party sites. Imported test HTML is trusted input, not a sandbox for untrusted content.

Do not disclose personal attempt data in public issues. If enabled, use the repository's private vulnerability reporting feature. Otherwise use a private contact channel listed on the maintainer's GitHub profile; do not publish exploit details or private records.
