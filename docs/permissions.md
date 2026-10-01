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

## Review and verification checklist

Use a disposable demo database with the current seed accounts: `doctor1`,
`nurse1`, `clinic1`, `patient1`, `unauthorized1` (password `demo1234`).

- For each staff account, search patients and read patient 1: expect access.
- For patient 1, seeded note 11 (`everyone`) is visible to all staff and
  `patient1`; note 13 (`staff`) is visible only to staff; note 12 (`private`,
  authored by `doctor1`) is visible only to `doctor1`.
- `patient1` can read patient 1 and its access log, but receives `403` for patient
  search and patient 2's record, notes and access log.
- `unauthorized1` can sign in and read `/api/auth/me`, but receives `403` for
  patient search, records, notes and access logs.
- Without a valid cookie, protected patient endpoints return `401`.

The access checks run automatically in `server/src/routes/permissions.test.js`:
`401` and `403` for every seed account and endpoint, and which requests create an
access block. Note creation and note visibility per role are tested in
`server/src/routes/notes.test.js`.
