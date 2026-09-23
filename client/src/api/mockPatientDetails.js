// Temporary mock data for issue #17.
// Once the backend is ready, this should be replaced by:
// - GET /api/patients/:id           -> patient info + notes (filtered by role server-side)
// - GET /api/patients/:id/access-log -> access log entries

export const mockPatientDetails = {
  p1: {
    id: 'p1',
    fullName: 'Anna Karlsson',
    personalId: '19850312-4521',
    notes: [
      {
        id: 11,
        patientId: 1,
        authorId: 1,
        authorName: 'Dr. Lindberg',
        authorRole: 'doctor',
        text: 'Patient reports improved mobility after physical therapy. Follow-up in 3 weeks.',
        visibility: 'everyone', // 'private' | 'staff' | 'everyone'
        createdAt: '2026-09-12T14:32:00',
      },
      {
        id: 12,
        patientId: 2,
        authorId: 2,
        authorName: 'Dr. Lindberg',
        authorRole: 'doctor',
        text: 'Internal note: consider referral to specialist if no improvement by next visit.',
        visibility: 'private',
        createdAt: '2026-09-10T09:15:00',
      },
      {
        id: 13,
        patientId: 3,
        authorId: 3,
        authorName: 'Nurse Åström',
        authorRole: 'nurse',
        text: 'Blood pressure and vitals recorded, all within normal range.',
        visibility: 'staff',
        createdAt: '2026-09-08T16:50:00',
      },
    ],
    accessLog: [
      { id: 'l1', name: 'Dr. Lindberg', role: 'doctor', timestamp: '2026-09-12T14:30:00' },
      { id: 'l2', name: 'Nurse Åström', role: 'nurse', timestamp: '2026-09-10T09:10:00' },
      { id: 'l3', name: 'Anna Karlsson', role: 'patient', timestamp: '2026-09-09T20:02:00' },
    ],
  },
};