# Permissions

This matrix describes the agreed application permissions for issue #19. It uses
the role names adopted on 2026-09-21 and expands the rules in
[the data contract](kontrakt.md). It does not introduce different privileges for
the three staff roles.

## Role matrix

All journal access requires authentication. "Own patient" means the requested
patient ID equals the authenticated user's `linkedPatientId` (stored as
`linked_patient_id` in the database), not an ID supplied by the browser.

| Role | Sign in / view own account | Search or list patients | Read patient record and visible notes | Read access log | Create notes | Denied |
| --- | --- | --- | --- | --- | --- | --- |
| `doctor` | Yes | Yes | Any patient, subject to note visibility | Any patient | Yes, with `private`, `staff` or `everyone` visibility | Other authors' private notes |
| `nurse` | Yes | Yes | Any patient, subject to note visibility | Any patient | Yes, with `private`, `staff` or `everyone` visibility | Other authors' private notes |
| `clinic` | Yes | Yes | Any patient, subject to note visibility | Any patient | Yes, with `private`, `staff` or `everyone` visibility | Other authors' private notes |
| `patient` | Yes | No | Own patient only, subject to note visibility | Own patient only | No | Patient search, other patients' records/logs, staff notes, other authors' private notes and creating notes |
| `unauthorized` | Yes | No | No | No | No | All patient records, notes, searches and access logs |

An unauthenticated user cannot use protected patient endpoints. Signing in as
`unauthorized` is allowed; it does not grant journal access. No role is granted
note editing/deletion or user administration by this contract.

## Note visibility

First check access to the patient record, then apply visibility to each note.
`everyone` does not mean public access.

| Visibility | `doctor` | `nurse` | `clinic` | `patient` | `unauthorized` |
| --- | --- | --- | --- | --- | --- |
| `private` | Only if author | Only if author | Only if author | Only if author, and only on own patient record | Never |
| `staff` | Yes | Yes | Yes | Never | Never |
| `everyone` | Yes | Yes | Yes | Own patient only | Never |

Patients cannot create notes. The author rule for `private` is nevertheless the
same rule used by the read filter; it does not grant a patient write permission.
The server must remove hidden notes before returning JSON. Hiding notes in the
browser alone is insufficient. The same filter applies to live `note:created`
delivery, after authorizing membership of the `patient:<id>` room.

## Endpoint rules and denied responses

| Endpoint | Required access |
| --- | --- |
| `POST /api/auth/login` | Valid credentials for any of the five roles |
| `GET /api/auth/me` | Authenticated; returns the current user's account only |
| `POST /api/auth/logout` | No authentication required; clears the cookie |
| `GET /api/patients?search=...` | Staff (`doctor`, `nurse`, `clinic`) |
| `GET /api/patients/:id` | Staff, or the linked patient; filter notes |
| `GET /api/patients/:id/notes` | Same patient-access and visibility rules |
| `GET /api/patients/:id/access-log` | Same patient-access rules |
| `POST /api/patients/:id/notes` | Staff only; validate text and visibility |

- Missing/invalid authentication: `401`; the UI shows login.
- Authenticated but forbidden: `403`; the UI shows access denied. A patient
  changing the requested ID must not gain access to another record.
- Invalid input: `400`, after applicable authentication/role checks.
- Missing patient: `404`, after applicable access checks. A denied user must not
  gain patient data from an error response.
- A successful record read creates a signed `read` event. Creating a note is
  specified to create a signed `write` event. Searches, note-list reads and
  access-log reads create no access block; denied requests create no access block.

## Implementation status

Checked against `main` at `0690925` on 2026-09-22. The tables above describe the
agreed permissions, not a claim that every feature is already implemented.

- `server/src/middleware.js` and `server/src/routes/patients.js` enforce the
  staff/patient split, linked-patient checks and SQL note filtering for reads.
- The note-creation POST route is not yet implemented on this baseline. Its
  permission and expected `403` response above are requirements for that work,
  not verified current POST behavior.
- Frontend patient routes on this baseline require login but do not yet enforce
  the role-specific navigation. Search and patient views still use mock data.
  Direct navigation to the patient's own journal and the unauthorized view are
  tracked in #32 and #33; API integration is tracked in #64.
- Access logs currently contain the local node's chain only. Combined logs and
  live notifications depend on the P2P work (#39–#41).

## Review and verification checklist

Use a disposable demo database with the current seed accounts: `doctor1`,
`nurse1`, `clinic1`, `patient1`, `unauthorized1` (password `demo1234`). Existing
databases created before the role rename may still contain Swedish role names;
use a separate database path for verification rather than deleting existing data.

- For each staff account, search patients and read patient 1: expect access.
- For patient 1, seeded note 11 (`everyone`) is visible to all staff and
  `patient1`; note 13 (`staff`) is visible only to staff; note 12 (`private`,
  authored by `doctor1`) is visible only to `doctor1`.
- `patient1` can read patient 1 and its access log, but receives `403` for patient
  search and patient 2's record, notes and access log.
- `unauthorized1` can sign in and read `/api/auth/me`, but receives `403` for
  patient search, records, notes and access logs.
- Without a valid cookie, protected patient endpoints return `401`.
- When note creation is implemented, verify creation for all three staff roles
  and denial for `patient` and `unauthorized`.
- When live delivery is implemented, repeat the visibility checks on both
  servers, including a forbidden patient-room subscription.

This checklist is for implementation review; it is not a report of executed
end-to-end tests. This documentation was checked against the contract, route
guards, SQL filter and seed data listed above.
