# Local trial-preserving 2.0.0

This local-only package identifies itself as `2.0.0-local-trial.20261029.1`.
It retains the existing Botling 2 Dev Trial profile. It is not public production 2.0.0.

Do not drag-install this first upgrade or run the development trial launcher. Merely mounting
this disk does not install anything. Keep the current application and profile intact until the
operator has verified the signed ZIP, native/ASAR metadata, storage compatibility, current
application identity and exact profile pin, and obtained explicit approval of the offline
bootstrap plan. Use the existing offline bootstrap procedure with `candidateDevTrial: true`;
its application path, data directory and trust pin must match the existing installation.

This disk intentionally has no Applications shortcut and no launcher that selects sibling
`trial-data`. It does not approve installation, migrate a profile or bypass update authorization.
A later public production update may be rejected by the retained trial profile pin; migration
to a production profile requires a separate decision and backed-up procedure.
